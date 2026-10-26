//! F* include roots and module tables as the compiler builds them (`FStarC.Find`,
//! `FStarC.Parser.Dep`), configured the way fstar-vscode-assistant configures one input file: the
//! nearest `*.fst.config.json` inside the graph root, whose fields a request may replace.

use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::{OsStr, OsString},
    fs,
    io::ErrorKind,
    os::unix::fs::PermissionsExt,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;

use crate::{Heartbeat, imports::dir_of};

/// An editor `*.fst.config.json`. As a request option, each present field replaces the discovered
/// one (arrays too, so `[]` clears it); absent fields keep the discovered values.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FstarConfig {
    pub cwd: Option<String>,
    pub fstar_exe: Option<String>,
    pub options: Option<Vec<String>>,
    pub include_dirs: Option<Vec<String>>,
}

const CONFIG_SUFFIX: &str = ".fst.config.json";
const REQUEST: &str = "the fstar request option";

// `FStarC.Options.specs_with_types`, by `desc_of_opt_type`: `Const` takes no argument, anything
// else (through its wrappers) exactly one.
const NO_ARGUMENT: &str = "\
    __debug_embedding __no_positivity __tactics_nbe __temp_fast_implicits \
    cache_checked_modules cache_off compat_pre_typed_indexed_effects custard_dump_cui \
    custard_dump_ir custard_dump_layouts custard_dump_specializations custard_split \
    custard_warn_any debug_all debug_all_modules dump_ast eager_embedding eager_subtyping \
    expose_interfaces force help hide_uvar_nums ide ide_id_info_off lax list_debug_keys \
    list_plugins locate locate_lib locate_ocaml log_failing_queries log_queries log_types \
    no_default_includes no_plugins no_prelude no_smt no_tactics \
    normalize_pure_terms_for_extraction ocamlc ocamlenv ocamlopt ocamlopt_plugin print \
    print_bound_var_types print_cache_version print_effect_args print_expected_failures \
    print_full_names print_implicits print_in_place print_universes print_z3_statistics prn \
    profile_group_by_decl proof_recovery query_cache query_stats record_options silent \
    tactic_raw_binders tactic_trace tactics_failhard tactics_info timing trace_error ugly \
    unsafe_tactic_exec unthrottle_inductives use_eq_at_higher_order version \
    warn_default_effects with_fstarc z3refresh";

const ONE_ARGUMENT: &str = "\
    abort_on admit_except admit_smt_queries already_cached cache_dir codegen compat_pre_core \
    custard_c_no_prefix custard_entry custard_entry_module custard_entrypoints \
    custard_extern_type custard_fuel custard_int128 custard_krml_model custard_link \
    custard_main custard_max_specializations custard_monomorphize_types custard_no_unfold \
    custard_norm_budget custard_sizet_width custard_unit debug defensive dep \
    disallow_unification_guards dump_module error_contexts expand_include ext fuel ifuel \
    include initial_fuel initial_ifuel keep_query_captions lang_extensions load load_cmxs \
    locate_file locate_z3 max_fuel max_ifuel message_format odir output_deps_to output_ext \
    output_to prims profile profile_component quake read_checked_file read_krml_file \
    report_assumes retry smt smtencoding.elim_box smtencoding.l_arith_repr \
    smtencoding.nl_arith_repr stats tactic_trace_d target tcnorm \
    trivial_pre_for_unannotated_effectful_fns use_native_tactics use_nbe using_facts_from \
    warn_error z3cliopt z3rlimit z3rlimit_factor z3seed z3smtopt z3version";

/// Whether the exact compiler argument `option` consumes the next argument (whatever it looks
/// like); `None` if it is no option. `FStarC.Getopt` has no `--name=value` or grouped short options.
fn option_arity(option: &str) -> Option<bool> {
    let name = match option.strip_prefix("--") {
        Some(name) => name,
        None => match option {
            "-c" => "cache_checked_modules",
            "-f" => "force",
            "-h" => "help",
            "-o" => "output_to",
            "-v" => "version",
            _ => return None,
        },
    };
    let known = |names: &str| names.split_whitespace().any(|n| n == name);
    if known(NO_ARGUMENT) {
        Some(false)
    } else if known(ONE_ARGUMENT) {
        Some(true)
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Kind {
    /// Immediate files only.
    Flat,
    /// Namespace directories too: `A/B/C.fst` provides `A.B.C`.
    Recursive,
}

type Root = (PathBuf, Kind);

/// A module's (interface, implementation) graph keys.
type Slots = (Option<String>, Option<String>);

/// A command-line input in its table slot: lowercase module key, interface?, graph key.
type Input<'a> = (String, bool, &'a str);

/// One source file a root provides.
struct Candidate {
    name: String,
    /// Lowercase `name`: module names are case-insensitive.
    key: String,
    interface: bool,
    /// Graph key.
    file: String,
    path: PathBuf,
}

/// A root's candidates, and the directories whose include-root status decided them: any root list
/// that agrees on those reproduces the walk.
struct Walk {
    examined: Vec<PathBuf>,
    stopped: HashSet<PathBuf>,
    candidates: Arc<Vec<Candidate>>,
}

/// The roots of one input that do not depend on the input file itself.
struct Settings {
    /// Cache, library, and explicit roots, expanded, in compiler order.
    head: Vec<Root>,
    /// The expanded explicit roots, which may cover the input's parent.
    explicit: Vec<Root>,
    /// The expanded cwd root.
    cwd: Vec<Root>,
}

/// The filesystem-affecting compiler options, each value with where it came from.
#[derive(Default)]
struct Args {
    includes: Vec<(String, String)>,
    cache_dir: Option<(String, String)>,
    no_default_includes: bool,
    with_fstarc: bool,
}

/// One compiler module table: what each module name selects for one input file.
struct Context {
    modules: Arc<HashMap<String, Slots>>,
    /// Source-navigation files: each module's implementation, else its interface.
    visible: HashSet<String>,
}

/// The F* module tables of one build, and the tables each F* graph file resolves under.
#[derive(Default)]
pub(crate) struct FstarScopes {
    contexts: Vec<Context>,
    memberships: HashMap<String, Vec<usize>>,
    external: Vec<String>,
    /// Files every context sees, such as a shared default library.
    everywhere: HashSet<String>,
}

impl FstarScopes {
    /// Selected files the repository walk did not yield, as graph keys.
    pub(crate) fn external(&self) -> &[String] {
        &self.external
    }

    /// The contexts `file` resolves under: its own as an input, and each that selects it.
    pub(crate) fn contexts(&self, file: &str) -> &[usize] {
        self.memberships.get(file).map_or(&[], Vec::as_slice)
    }

    /// The file `module` navigates to in `context`: its implementation, else its interface.
    pub(crate) fn module(&self, context: usize, module: &str) -> Option<&str> {
        let (interface, implementation) = self.contexts[context]
            .modules
            .get(&module.to_ascii_lowercase())?;
        implementation.as_deref().or(interface.as_deref())
    }

    /// Every file some module of `context` navigates to.
    pub(crate) fn visible(&self, context: usize) -> &HashSet<String> {
        &self.contexts[context].visible
    }

    /// The files visible in every context.
    pub(crate) fn everywhere(&self) -> &HashSet<String> {
        &self.everywhere
    }
}

/// Module tables for every repository F* source, each its own compiler input, or for the graph
/// root alone when a request configures F* for a repository without F* sources. Everything is
/// reread: nothing outlives the build.
pub(crate) fn discover(
    root: &Path,
    sources: &[&str],
    request: Option<&FstarConfig>,
    heartbeat: Heartbeat<'_>,
) -> Result<FstarScopes, String> {
    if sources.is_empty() && request.is_none() {
        return Ok(FstarScopes::default());
    }
    let mut discovery = Discovery {
        root,
        request,
        heartbeat,
        nearest: HashMap::new(),
        configs: HashMap::new(),
        settings: HashMap::new(),
        expansions: HashMap::new(),
        walks: HashMap::new(),
    };
    let inputs: Vec<Option<&str>> = if sources.is_empty() {
        vec![None]
    } else {
        sources.iter().copied().map(Some).collect()
    };
    let mut scopes: Vec<Vec<Root>> = Vec::new();
    let mut scope_ids: HashMap<Vec<Root>, usize> = HashMap::new();
    let mut scoped = Vec::with_capacity(inputs.len());
    for file in inputs {
        heartbeat()?;
        let dir = match file.map(dir_of) {
            None | Some("") => root.to_path_buf(),
            Some(dir) => root.join(dir),
        };
        let config = discovery.nearest(&dir)?;
        let settings = discovery.settings(config.as_deref(), &dir)?;
        let mut roots = settings.head.clone();
        if file.is_some() && !settings.explicit.iter().any(|root| covers(root, &dir)) {
            roots.extend(discovery.expand(&dir, Kind::Flat)?);
        }
        roots.extend(settings.cwd.iter().cloned());
        let roots = last_occurrences(roots);
        let module = match file {
            Some(file) => input_module(&roots, &root.join(file))?.map(|m| (file, m)),
            None => None,
        };
        let scope = match scope_ids.get(&roots) {
            Some(&scope) => scope,
            None => {
                scope_ids.insert(roots.clone(), scopes.len());
                scopes.push(roots);
                scopes.len() - 1
            }
        };
        scoped.push((file, scope, module));
    }

    let mut tables = Vec::with_capacity(scopes.len());
    for roots in &scopes {
        tables.push(Arc::new(discovery.table(roots)?));
    }
    // The compiler adds each command-line input last; most inputs are already selected there.
    let mut contexts: Vec<Context> = Vec::new();
    let mut context_ids: HashMap<(usize, Option<Input<'_>>), usize> = HashMap::new();
    let mut memberships: HashMap<String, Vec<usize>> = HashMap::new();
    for (file, scope, module) in scoped {
        let table = &tables[scope];
        let input = module
            .map(|(file, (key, interface))| (key, interface, file))
            .filter(|(key, interface, file)| {
                let slots = table.get(key);
                let selected = slots.and_then(|s| if *interface { &s.0 } else { &s.1 }.as_deref());
                selected != Some(*file)
            });
        let id = match context_ids.get(&(scope, input.clone())) {
            Some(&id) => id,
            None => {
                contexts.push(context(table, input.as_ref()));
                context_ids.insert((scope, input), contexts.len() - 1);
                contexts.len() - 1
            }
        };
        if let Some(file) = file {
            memberships.entry(file.to_string()).or_default().push(id);
        }
    }
    for (id, context) in contexts.iter().enumerate() {
        for (interface, implementation) in context.modules.values() {
            for file in interface.iter().chain(implementation) {
                memberships.entry(file.clone()).or_default().push(id);
            }
        }
    }
    for ids in memberships.values_mut() {
        ids.sort_unstable();
        ids.dedup();
    }
    let repository: HashSet<&str> = sources.iter().copied().collect();
    let mut external: Vec<String> = memberships
        .keys()
        .filter(|file| !repository.contains(file.as_str()))
        .cloned()
        .collect();
    external.sort_unstable();
    let mut everywhere = contexts
        .iter()
        .map(|context| &context.visible)
        .min_by_key(|visible| visible.len())
        .cloned()
        .unwrap_or_default();
    everywhere.retain(|file| {
        contexts
            .iter()
            .all(|context| context.visible.contains(file))
    });
    Ok(FstarScopes {
        contexts,
        memberships,
        external,
        everywhere,
    })
}

/// `table` with `input`, a command-line input, in its slot.
fn context(table: &Arc<HashMap<String, Slots>>, input: Option<&Input<'_>>) -> Context {
    let modules = match input {
        None => Arc::clone(table),
        Some((key, interface, file)) => {
            let mut modules = HashMap::clone(table);
            let slots = modules.entry(key.clone()).or_default();
            *if *interface {
                &mut slots.0
            } else {
                &mut slots.1
            } = Some(file.to_string());
            Arc::new(modules)
        }
    };
    let visible = modules
        .values()
        .filter_map(|(interface, implementation)| implementation.as_ref().or(interface.as_ref()))
        .cloned()
        .collect();
    Context { modules, visible }
}

/// One build's discovery state; every cache lives only as long as the build.
struct Discovery<'a> {
    root: &'a Path,
    request: Option<&'a FstarConfig>,
    heartbeat: Heartbeat<'a>,
    /// Nearest config per directory below the graph root.
    nearest: HashMap<PathBuf, Option<PathBuf>>,
    configs: HashMap<PathBuf, Arc<FstarConfig>>,
    /// Per (config, input directory when the cwd depends on it).
    settings: HashMap<(Option<PathBuf>, Option<PathBuf>), Arc<Settings>>,
    expansions: HashMap<Root, Vec<Root>>,
    walks: HashMap<Root, Vec<Walk>>,
}

impl Discovery<'_> {
    /// `dir`'s entries by name.
    fn entries(&self, dir: &Path) -> Result<Vec<(OsString, PathBuf)>, String> {
        (self.heartbeat)()?;
        let mut entries = fs::read_dir(dir)
            .and_then(|entries| {
                entries
                    .map(|entry| entry.map(|entry| (entry.file_name(), entry.path())))
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        entries.sort_unstable();
        Ok(entries)
    }

    /// The single `*.fst.config.json` of the nearest directory from `dir` up to the graph root
    /// that has any; parents are never merged.
    fn nearest(&mut self, dir: &Path) -> Result<Option<PathBuf>, String> {
        if let Some(found) = self.nearest.get(dir) {
            return Ok(found.clone());
        }
        let mut configs = Vec::new();
        for (name, path) in self.entries(dir)? {
            if name.as_encoded_bytes().ends_with(CONFIG_SUFFIX.as_bytes())
                && regular_file(path.clone())?.is_some()
            {
                configs.push(path);
            }
        }
        let found = match configs.as_slice() {
            [] if dir == self.root => None,
            [] => self.nearest(dir.parent().expect("inputs lie below the graph root"))?,
            [config] => Some(config.clone()),
            several => {
                let names: Vec<_> = several.iter().map(|p| p.display().to_string()).collect();
                return Err(format!(
                    "several F* configurations in {}: {}",
                    dir.display(),
                    names.join(", ")
                ));
            }
        };
        self.nearest.insert(dir.to_path_buf(), found.clone());
        Ok(found)
    }

    fn config(&mut self, path: &Path) -> Result<Arc<FstarConfig>, String> {
        if let Some(config) = self.configs.get(path) {
            return Ok(Arc::clone(config));
        }
        let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let config: Arc<FstarConfig> =
            Arc::new(serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?);
        self.configs.insert(path.to_path_buf(), Arc::clone(&config));
        Ok(config)
    }

    /// The effective configuration's roots: request fields over `config`'s, interpreted from the
    /// final cwd as `fstar.exe` would be spawned there.
    fn settings(&mut self, config: Option<&Path>, dir: &Path) -> Result<Arc<Settings>, String> {
        let request = self.request;
        let fixed_cwd = config.is_some() || request.is_some_and(|r| r.cwd.is_some());
        let key = (
            config.map(Path::to_path_buf),
            (!fixed_cwd).then(|| dir.to_path_buf()),
        );
        if let Some(settings) = self.settings.get(&key) {
            return Ok(Arc::clone(settings));
        }
        let discovered = match config {
            Some(path) => self.config(path)?,
            None => Arc::default(),
        };
        let config_dir = config.map(|path| path.parent().expect("a config lies in a directory"));
        let origin = |from_request: bool| match config {
            Some(path) if !from_request => path.display().to_string(),
            _ => REQUEST.to_string(),
        };
        let cwd = pick(
            request.and_then(|r| r.cwd.as_ref()),
            discovered.cwd.as_ref(),
        );
        let fstar_exe = pick(
            request.and_then(|r| r.fstar_exe.as_ref()),
            discovered.fstar_exe.as_ref(),
        );
        let options = pick(
            request.and_then(|r| r.options.as_ref()),
            discovered.options.as_ref(),
        );
        let include_dirs = pick(
            request.and_then(|r| r.include_dirs.as_ref()),
            discovered.include_dirs.as_ref(),
        );

        let cwd = match cwd {
            Some((value, from_request)) => {
                let origin = origin(from_request);
                let value = expand_env(value, &origin)?;
                if value.is_empty() {
                    return Err(format!("empty F* cwd (from {origin})"));
                }
                let base = if from_request {
                    self.root
                } else {
                    config_dir.expect("a discovered cwd has a config")
                };
                canonical_dir(&base.join(&value))
                    .map_err(|e| format!("F* cwd {value} (from {origin}): {e}"))?
            }
            None => config_dir.unwrap_or(dir).to_path_buf(),
        };
        let mut args = Args::default();
        if let Some((options, from_request)) = options {
            let origin = origin(from_request);
            let options = options
                .iter()
                .map(|option| expand_env(option, &origin))
                .collect::<Result<Vec<_>, _>>()?;
            parse_args(&options, &cwd, &origin, &mut Vec::new(), &mut args)?;
        }
        if let Some((dirs, from_request)) = include_dirs {
            let origin = origin(from_request);
            for dir in dirs {
                args.includes
                    .push((expand_env(dir, &origin)?, origin.clone()));
            }
        }
        let mut includes = Vec::with_capacity(args.includes.len());
        for (dir, origin) in &args.includes {
            if dir.is_empty() {
                return Err(format!("empty F* include directory (from {origin})"));
            }
            includes.push(
                canonical_dir(&cwd.join(dir))
                    .map_err(|e| format!("F* include directory {dir} (from {origin}): {e}"))?,
            );
        }
        let cache_dir = match &args.cache_dir {
            Some((dir, origin)) if dir.is_empty() => {
                return Err(format!("empty F* cache directory (from {origin})"));
            }
            Some((dir, _)) => present_dir(&cwd.join(dir))?,
            None => None,
        };

        let (exe, exe_origin, exe_explicit) = match fstar_exe {
            Some((exe, from_request)) => {
                let origin = origin(from_request);
                (expand_env(exe, &origin)?, origin, true)
            }
            None => ("fstar.exe".to_string(), "the default".to_string(), false),
        };
        let mut libraries = Vec::new();
        if !args.no_default_includes {
            match env::var_os("FSTAR_LIB").filter(|lib| !lib.is_empty()) {
                Some(lib) => libraries.push(
                    canonical_dir(&cwd.join(&lib))
                        .map_err(|e| format!("FSTAR_LIB {}: {e}", Path::new(&lib).display()))?,
                ),
                None => match find_executable(&exe, &cwd) {
                    Some(exe) => libraries.extend(present_dir(&installation(&exe, "lib/fstar"))?),
                    None if exe_explicit => {
                        return Err(format!(
                            "F* executable {exe} (from {exe_origin}) not found; it locates the \
                             default library (set FSTAR_LIB or pass --no_default_includes)"
                        ));
                    }
                    // No compiler installed: only explicit and local roots.
                    None => {}
                },
            }
        }
        if args.with_fstarc {
            let exe = find_executable(&exe, &cwd).ok_or_else(|| {
                format!("--with_fstarc needs F* executable {exe} (from {exe_origin}), not found")
            })?;
            libraries.extend(present_dir(&installation(&exe, "lib/fstar/fstarc"))?);
        }

        // `FStarC.Find.module_include_paths`; the cache directory is never expanded.
        let mut head: Vec<Root> = cache_dir.into_iter().map(|dir| (dir, Kind::Flat)).collect();
        for library in libraries {
            head.extend(self.expand(&library, Kind::Flat)?);
        }
        let mut explicit = Vec::new();
        for include in includes {
            explicit.extend(self.expand(&include, Kind::Recursive)?);
        }
        head.extend(explicit.iter().cloned());
        let cwd = self.expand(&cwd, Kind::Flat)?;
        let settings = Arc::new(Settings {
            head,
            explicit,
            cwd,
        });
        self.settings.insert(key, Arc::clone(&settings));
        Ok(settings)
    }

    /// `dir` as a `kind` root, or flat plus its `fstar.include` children, recursively.
    fn expand(&mut self, dir: &Path, kind: Kind) -> Result<Vec<Root>, String> {
        let key = (dir.to_path_buf(), kind);
        if let Some(roots) = self.expansions.get(&key) {
            return Ok(roots.clone());
        }
        let mut roots = Vec::new();
        expand_into(dir, kind, &mut Vec::new(), &mut roots)?;
        self.expansions.insert(key, roots.clone());
        Ok(roots)
    }

    /// The module table of `roots`: later roots replace each role independently.
    fn table(&mut self, roots: &[Root]) -> Result<HashMap<String, Slots>, String> {
        let dirs: HashSet<PathBuf> = roots.iter().map(|(dir, _)| dir.clone()).collect();
        let mut table: HashMap<String, Slots> = HashMap::new();
        for root in roots {
            for candidate in self.candidates(root, &dirs)?.iter() {
                let slots = table.entry(candidate.key.clone()).or_default();
                *if candidate.interface {
                    &mut slots.0
                } else {
                    &mut slots.1
                } = Some(candidate.file.clone());
            }
        }
        Ok(table)
    }

    /// `root`'s sources, unique per module name and role; `dirs` are every include root, whose
    /// subtrees their own traversal owns.
    fn candidates(
        &mut self,
        root: &Root,
        dirs: &HashSet<PathBuf>,
    ) -> Result<Arc<Vec<Candidate>>, String> {
        if let Some(walk) = self.walks.get(root).and_then(|walks| {
            walks.iter().find(|walk| {
                walk.examined
                    .iter()
                    .all(|dir| dirs.contains(dir) == walk.stopped.contains(dir))
            })
        }) {
            return Ok(Arc::clone(&walk.candidates));
        }
        let mut walk = Walk {
            examined: Vec::new(),
            stopped: HashSet::new(),
            candidates: Arc::default(),
        };
        let mut candidates = Vec::new();
        match root.1 {
            Kind::Flat => self.flat(&root.0, &mut candidates)?,
            Kind::Recursive => self.nested(
                &root.0,
                &mut Vec::new(),
                &mut vec![root.0.clone()],
                dirs,
                &mut walk,
                &mut candidates,
            )?,
        }
        let mut seen: HashMap<(&str, bool), &Path> = HashMap::new();
        for candidate in &candidates {
            if let Some(previous) =
                seen.insert((&candidate.key, candidate.interface), &candidate.path)
            {
                return Err(format!(
                    "F* module {} is provided by more than one file in include directory {}: {} \
                     and {}",
                    candidate.name,
                    root.0.display(),
                    previous.display(),
                    candidate.path.display()
                ));
            }
        }
        walk.candidates = Arc::new(candidates);
        let candidates = Arc::clone(&walk.candidates);
        self.walks.entry(root.clone()).or_default().push(walk);
        Ok(candidates)
    }

    fn flat(&self, dir: &Path, out: &mut Vec<Candidate>) -> Result<(), String> {
        for (name, path) in self.entries(dir)? {
            if let Some((stem, interface)) = source_name(&name, &path)?
                && let Some(file) = regular_file(path)?
            {
                out.push(self.candidate(stem.to_string(), interface, file)?);
            }
        }
        Ok(())
    }

    /// `FStarC.Parser.Dep.hierarchical_modules_for_dir` below `dir`, whose namespace is
    /// `namespace` and whose canonical ancestors within the root are `ancestors`.
    fn nested(
        &self,
        dir: &Path,
        namespace: &mut Vec<String>,
        ancestors: &mut Vec<PathBuf>,
        dirs: &HashSet<PathBuf>,
        walk: &mut Walk,
        out: &mut Vec<Candidate>,
    ) -> Result<(), String> {
        for (name, path) in self.entries(dir)? {
            let component = name.to_str().filter(|name| namespace_component(name));
            let source = source_name(&name, &path)?;
            if component.is_none() && source.is_none() {
                continue;
            }
            let meta = match fs::metadata(&path) {
                Ok(meta) => meta,
                Err(e) if e.kind() == ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("{}: {e}", path.display())),
            };
            if meta.is_dir() {
                let Some(component) = component else { continue };
                let canonical =
                    fs::canonicalize(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                walk.examined.push(canonical.clone());
                if dirs.contains(&canonical) {
                    walk.stopped.insert(canonical);
                    continue;
                }
                if ancestors.contains(&canonical) {
                    return Err(format!(
                        "F* include directory {} loops: {} leads back to {}",
                        ancestors[0].display(),
                        path.display(),
                        canonical.display()
                    ));
                }
                namespace.push(component.to_string());
                ancestors.push(canonical.clone());
                self.nested(&canonical, namespace, ancestors, dirs, walk, out)?;
                ancestors.pop();
                namespace.pop();
            } else if let Some((stem, interface)) = source
                && let Some(file) = regular_file(path)?
            {
                let name = namespace
                    .iter()
                    .map(String::as_str)
                    .chain([stem])
                    .collect::<Vec<_>>()
                    .join(".");
                out.push(self.candidate(name, interface, file)?);
            }
        }
        Ok(())
    }

    fn candidate(&self, name: String, interface: bool, path: PathBuf) -> Result<Candidate, String> {
        Ok(Candidate {
            key: name.to_ascii_lowercase(),
            name,
            interface,
            file: graph_key(self.root, &path)?,
            path,
        })
    }
}

/// The request's value, else the discovered one, and whether it came from the request.
fn pick<'v, T>(request: Option<&'v T>, discovered: Option<&'v T>) -> Option<(&'v T, bool)> {
    request
        .map(|value| (value, true))
        .or(discovered.map(|value| (value, false)))
}

/// `FStarC.Find.expand_module_include_path`, refusing a manifest that includes itself.
fn expand_into(
    dir: &Path,
    kind: Kind,
    stack: &mut Vec<PathBuf>,
    out: &mut Vec<Root>,
) -> Result<(), String> {
    let manifest = dir.join("fstar.include");
    let text = match fs::read(&manifest) {
        Err(e) if e.kind() == ErrorKind::NotFound => {
            out.push((dir.to_path_buf(), kind));
            return Ok(());
        }
        Err(e) => return Err(format!("{}: {e}", manifest.display())),
        Ok(bytes) => {
            String::from_utf8(bytes).map_err(|_| format!("{}: not UTF-8", manifest.display()))?
        }
    };
    if stack.iter().any(|active| active == dir) {
        let chain: Vec<_> = stack
            .iter()
            .chain([&dir.to_path_buf()])
            .map(|dir| dir.join("fstar.include").display().to_string())
            .collect();
        return Err(format!(
            "F* include manifests form a cycle: {}",
            chain.join(" -> ")
        ));
    }
    out.push((dir.to_path_buf(), Kind::Flat));
    stack.push(dir.to_path_buf());
    for entry in text
        .split(['\r', '\n'])
        .map(|line| line.trim_matches(|c: char| c.is_ascii_whitespace()))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        // `dirname ^ "/" ^ subd`: an entry is never absolute. The compiler reads a missing child
        // as an empty root (installed libraries list optional ones), so it adds nothing.
        let mut child = dir.as_os_str().to_owned();
        child.push("/");
        child.push(entry);
        let Some(child) = present_dir(Path::new(&child))
            .map_err(|e| format!("{} lists {entry}: {e}", manifest.display()))?
        else {
            continue;
        };
        expand_into(&child, Kind::Recursive, stack, out)?;
    }
    stack.pop();
    Ok(())
}

/// Parses compiler arguments as `FStarC.Options.parse_cmd_line` would, keeping only what selects
/// files. `@file` reads one argument per line, relative to `cwd` at any depth.
fn parse_args(
    args: &[String],
    cwd: &Path,
    origin: &str,
    stack: &mut Vec<PathBuf>,
    out: &mut Args,
) -> Result<(), String> {
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg.len() >= 2 && arg.starts_with('-') {
            let takes_argument = option_arity(arg)
                .ok_or_else(|| format!("unknown F* option {arg} (from {origin})"))?;
            if !takes_argument {
                match arg.as_str() {
                    "--no_default_includes" => out.no_default_includes = true,
                    "--with_fstarc" => out.with_fstarc = true,
                    _ => {}
                }
                continue;
            }
            let value = args
                .next()
                .ok_or_else(|| format!("F* option {arg} (from {origin}) lacks its argument"))?;
            match arg.as_str() {
                "--include" => out.includes.push((value.clone(), origin.to_string())),
                "--cache_dir" => out.cache_dir = Some((value.clone(), origin.to_string())),
                _ => {}
            }
        } else if let Some(file) = arg.strip_prefix('@') {
            let path = cwd.join(file);
            let response = fs::canonicalize(&path)
                .map_err(|e| format!("F* response file {} (from {origin}): {e}", path.display()))?;
            if stack.contains(&response) {
                let chain: Vec<_> = stack
                    .iter()
                    .chain([&response])
                    .map(|p| p.display().to_string())
                    .collect();
                return Err(format!(
                    "F* response files form a cycle: {}",
                    chain.join(" -> ")
                ));
            }
            let text = fs::read_to_string(&response)
                .map_err(|e| format!("F* response file {} (from {origin}): {e}", path.display()))?;
            let lines: Vec<String> = text.split_terminator('\n').map(str::to_owned).collect();
            stack.push(response);
            let nested = stack.last().expect("just pushed").display().to_string();
            parse_args(&lines, cwd, &nested, stack, out)?;
            stack.pop();
        } else {
            return Err(format!(
                "F* options (from {origin}) name the source {arg:?}; the graph supplies its inputs"
            ));
        }
    }
    Ok(())
}

/// `value` with `$NAME` and `${NAME}` replaced once from the environment, as the editor does,
/// except that an unset or empty variable is an error rather than an empty string.
fn expand_env(value: &str, origin: &str) -> Result<String, String> {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(dollar) = rest.find('$') {
        out.push_str(&rest[..dollar]);
        let after = &rest[dollar + 1..];
        let name = match after.strip_prefix('{') {
            Some(braced) => braced
                .find('}')
                .map(|end| &braced[..end])
                .filter(|name| name.chars().all(word))
                .map(|name| (name, name.len() + 2)),
            None if after.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') => {
                let end = after.find(|c| !word(c)).unwrap_or(after.len());
                Some((&after[..end], end))
            }
            None => None,
        };
        let Some((name, consumed)) = name else {
            out.push('$');
            rest = after;
            continue;
        };
        let resolved = env::var(name)
            .ok()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("{origin}: environment variable {name} is unset or empty"))?;
        out.push_str(&resolved);
        rest = &after[consumed..];
    }
    out.push_str(rest);
    Ok(out)
}

/// `name`'s module stem and whether it is an interface, if it names an F* source.
fn source_name<'n>(name: &'n OsStr, path: &Path) -> Result<Option<(&'n str, bool)>, String> {
    let bytes = name.as_encoded_bytes();
    let (suffix, interface) = if bytes.ends_with(b".fsti") {
        (5, true)
    } else if bytes.ends_with(b".fst") {
        (4, false)
    } else {
        return Ok(None);
    };
    if bytes.len() == suffix {
        return Ok(None);
    }
    let name = name
        .to_str()
        .ok_or_else(|| format!("F* source path is not UTF-8: {}", path.display()))?;
    Ok(Some((&name[..name.len() - suffix], interface)))
}

/// `FStarC.Parser.Dep.can_be_namespace_component`; `BatChar.is_letter` is ASCII-only.
fn namespace_component(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_alphabetic())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '\'')
}

/// The module key of the input `file`: its path below the longest root that applies to it, else
/// its basename (`FStarC.Parser.Dep.module_name_from_include_path`).
fn input_module(roots: &[Root], file: &Path) -> Result<Option<(String, bool)>, String> {
    let parent = file.parent();
    let mut best: Option<&Path> = None;
    for (dir, kind) in roots {
        if file.starts_with(dir)
            && (*kind == Kind::Recursive || parent == Some(dir.as_path()))
            && best.is_none_or(|best| dir.as_os_str().len() > best.as_os_str().len())
        {
            best = Some(dir);
        }
    }
    let relative = match best {
        Some(dir) => file.strip_prefix(dir).expect("checked prefix"),
        None => Path::new(file.file_name().expect("a source file has a name")),
    };
    Ok(source_name(relative.as_os_str(), file)?
        .map(|(stem, interface)| (stem.replace('/', ".").to_ascii_lowercase(), interface)))
}

/// `roots` without repeats, each at its last occurrence (`BatList.unique`).
fn last_occurrences(roots: Vec<Root>) -> Vec<Root> {
    let mut seen = HashSet::new();
    let mut unique: Vec<Root> = roots
        .into_iter()
        .rev()
        .filter(|root| seen.insert(root.clone()))
        .collect();
    unique.reverse();
    unique
}

/// `FStarC.Find.module_include_covers_path`.
fn covers((dir, kind): &Root, path: &Path) -> bool {
    match kind {
        Kind::Flat => dir == path,
        Kind::Recursive => path.starts_with(dir),
    }
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    let dir = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err("not a directory".into())
    }
}

/// The canonical directory at `path`, or `None` if there is none: an optional root.
fn present_dir(path: &Path) -> Result<Option<PathBuf>, String> {
    match fs::canonicalize(path) {
        Ok(dir) => Ok(dir.is_dir().then_some(dir)),
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// `path` resolved to a regular file; `None` for directories, dangling links and special files.
fn regular_file(path: PathBuf) -> Result<Option<PathBuf>, String> {
    let meta = fs::symlink_metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.file_type().is_symlink() {
        return Ok(meta.is_file().then_some(path));
    }
    match fs::canonicalize(&path) {
        Ok(target) => Ok(target.is_file().then_some(target)),
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// The real path of the executable `name` names from `cwd`, as `which` finds it.
fn find_executable(name: &str, cwd: &Path) -> Option<PathBuf> {
    let executable = |path: &Path| {
        fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    let found = if name.contains('/') {
        Some(cwd.join(name)).filter(|path| executable(path))
    } else if name.is_empty() {
        None
    } else {
        env::split_paths(&env::var_os("PATH")?)
            .map(|dir| dir.join(name))
            .find(|path| executable(path))
    };
    fs::canonicalize(found?).ok()
}

/// `relative` under the installation of `exe`: `<bin>/../relative`.
fn installation(exe: &Path, relative: &str) -> PathBuf {
    let bin = exe.parent().unwrap_or(exe);
    bin.parent().unwrap_or(bin).join(relative)
}

/// The graph key of the canonical `path`: root-relative POSIX, with leading `..` outside the root.
fn graph_key(root: &Path, path: &Path) -> Result<String, String> {
    let root: Vec<Component> = root.components().collect();
    let target: Vec<Component> = path.components().collect();
    let common = root.iter().zip(&target).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; root.len() - common];
    for component in &target[common..] {
        parts.push(
            component
                .as_os_str()
                .to_str()
                .ok_or_else(|| format!("F* source path is not UTF-8: {}", path.display()))?,
        );
    }
    Ok(parts.join("/"))
}
