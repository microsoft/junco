//! Ordered, tolerant configuration loading. All filesystem probes belong to the epoch.
//! Defaults and normalization are adapted from OMP 18.13.3; see ../LICENSE-OMP.
use crate::LspError;
use marsh_core::ManagedEpoch;
use serde_json::{Map, Value, json};
use std::{
    ffi::OsString,
    io,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug)]
pub(crate) struct ConfigContext {
    pub construction_cwd: PathBuf,
    pub home: Option<PathBuf>,
    pub pi_config_dir: Option<OsString>,
    pub claude_config_dir: Option<OsString>,
}
impl ConfigContext {
    pub fn from_epoch(epoch: &ManagedEpoch<'_>, construction_cwd: PathBuf) -> Self {
        let get = |key: &str| {
            epoch
                .environment()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_owned())
        };
        Self {
            construction_cwd,
            home: get("HOME").map(PathBuf::from),
            pi_config_dir: get("PI_CONFIG_DIR"),
            claude_config_dir: get("CLAUDE_CONFIG_DIR"),
        }
    }
    fn roots(&self, cwd: &Path) -> Vec<PathBuf> {
        let mut roots = vec![
            cwd.to_owned(),
            cwd.join(".omp"),
            cwd.join(".claude"),
            cwd.join(".codex"),
            cwd.join(".gemini"),
        ];
        if let Some(home) = &self.home {
            // Node path.join does not discard the home prefix for an absolute second part.
            let config = self
                .pi_config_dir
                .as_deref()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| std::ffi::OsStr::new(".omp"));
            let relative: PathBuf = Path::new(config)
                .components()
                .filter(|c| !matches!(c, Component::RootDir | Component::Prefix(_)))
                .collect();
            roots.push(normalize_path(&home.join(relative).join("agent")));
        }
        if let Some(dir) = self
            .claude_config_dir
            .as_ref()
            .filter(|v| !v.to_string_lossy().trim().is_empty())
        {
            let path = PathBuf::from(dir);
            roots.push(normalize_path(&if path.is_absolute() {
                path
            } else {
                self.construction_cwd.join(path)
            }));
        }
        if let Some(home) = &self.home {
            roots.push(home.clone());
        }
        roots
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ServerConfig {
    pub name: String,
    pub command: PathBuf,
    pub cwd: PathBuf,
    pub args: Vec<String>,
    pub file_types: Vec<String>,
    pub root_markers: Vec<String>,
    pub language_id: Option<String>,
    pub init_options: Value,
    pub settings: Value,
    pub warmup_timeout_ms: Option<f64>,
    pub workspace_ready_timings: Value,
    pub capabilities: Value,
    pub is_linter: bool,
    pub custom: Option<String>,
    pub available: bool,
}
impl ServerConfig {
    pub fn matches(&self, path: &Path) -> bool {
        let basename = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let extension = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        self.file_types.iter().any(|kind| {
            let kind = kind.to_lowercase();
            kind == basename
                || kind.trim_start_matches('.') == extension
                || kind.trim_start_matches('.') == basename
        })
    }
    pub fn project_aware(&self) -> bool {
        self.custom.is_none() && !self.is_linter
    }
    pub fn identity(&self) -> String {
        json!([
            self.name,
            self.command,
            self.cwd,
            self.args,
            self.init_options,
            self.settings,
            self.language_id
        ])
        .to_string()
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Config {
    pub servers: Vec<ServerConfig>,
    pub idle_timeout_ms: Option<f64>,
}
impl Config {
    pub fn load(epoch: &ManagedEpoch<'_>, context: &ConfigContext) -> Result<Self, LspError> {
        let defaults: Value = serde_json::from_str(include_str!("defaults.json"))
            .expect("vendored defaults are valid JSON");
        let mut merged = Map::new();
        merge_servers(
            &mut merged,
            defaults.as_object().expect("default server map"),
        );
        let mut idle = None;
        let roots = context.roots(epoch.cwd());
        for root in roots.iter().rev() {
            for filename in [
                ".lsp.yml",
                "lsp.yml",
                ".lsp.yaml",
                "lsp.yaml",
                ".lsp.json",
                "lsp.json",
            ] {
                let path = root.join(filename);
                let content = match epoch.read_to_string(&path) {
                    Ok(content) => content,
                    Err(error) => {
                        skip_io(error)?;
                        continue;
                    }
                };
                let Some(value) = parse_content(&content, &path) else {
                    continue;
                };
                let Some(object) = value.as_object() else {
                    continue;
                };
                if let Some(number) = object.get("idleTimeoutMs").and_then(Value::as_f64) {
                    idle = Some(number);
                }
                if let Some(servers) = object.get("servers").and_then(Value::as_object) {
                    merge_servers(&mut merged, servers);
                } else {
                    merge_servers(&mut merged, object);
                }
            }
        }
        let cwd = epoch.physical_path(epoch.cwd()).map_err(LspError::Marsh)?;
        let mut servers = Vec::with_capacity(merged.len());
        for (name, value) in merged {
            let object = value.as_object().expect("normalized server");
            if truthy(object.get("disabled")) {
                continue;
            }
            let command = object["command"].as_str().expect("normalized command");
            let root_markers = strings(&object["rootMarkers"], false);
            if !has_root_markers(epoch, &root_markers)? {
                continue;
            }
            let resolved = resolve_command(epoch, command)?;
            // As upstream, unavailable binaries do not constitute configured clients.
            let Some(command) = resolved else { continue };
            let mut args = object
                .get("args")
                .map(|v| strings(v, true))
                .unwrap_or_default();
            if name == "omnisharp" {
                for arg in &mut args {
                    if arg == "$PID" {
                        *arg = std::process::id().to_string();
                    }
                }
            }
            let custom = match name.as_str() {
                "biome" | "swiftlint" => Some(name.clone()),
                _ => None,
            };
            if name == "biome" {
                args = ["lint", "--reporter=json"].map(str::to_owned).to_vec();
            }
            if name == "swiftlint" {
                args = ["lint", "--quiet", "--reporter", "json"]
                    .map(str::to_owned)
                    .to_vec();
            }
            servers.push(ServerConfig {
                name,
                command,
                cwd: cwd.clone(),
                args,
                root_markers,
                file_types: strings(&object["fileTypes"], false),
                language_id: object
                    .get("languageId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
                init_options: object.get("initOptions").cloned().unwrap_or(Value::Null),
                settings: object.get("settings").cloned().unwrap_or(Value::Null),
                warmup_timeout_ms: object.get("warmupTimeoutMs").and_then(Value::as_f64),
                workspace_ready_timings: object
                    .get("workspaceReadyTimings")
                    .cloned()
                    .unwrap_or(Value::Null),
                capabilities: object.get("capabilities").cloned().unwrap_or(Value::Null),
                is_linter: truthy(object.get("isLinter")),
                custom,
                available: true,
            });
        }
        if let Some(native) = servers.iter().find(|s| s.name == "typescript-native") {
            let speaks_lsp = typescript_speaks_lsp(epoch, &native.command)?;
            let remove = if speaks_lsp {
                "typescript-language-server"
            } else {
                "typescript-native"
            };
            servers.retain(|server| server.name != remove);
        }
        servers.sort_by_key(|server| server.is_linter);
        Ok(Self {
            servers,
            idle_timeout_ms: idle.filter(|n| *n > 0.0),
        })
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() && !path.is_absolute() {
                    result.push("..");
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(v)) => v.as_f64() != Some(0.0),
        Some(Value::String(v)) => !v.is_empty(),
        _ => true,
    }
}
fn strings(value: &Value, allow_empty: bool) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| allow_empty || !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn normalized(value: &Map<String, Value>) -> Option<Value> {
    value.get("command")?.as_str().filter(|v| !v.is_empty())?;
    let mut result = value.clone();
    let mut file_types = value
        .get("fileTypes")
        .map(|v| strings(v, false))
        .unwrap_or_default();
    if file_types.is_empty() {
        file_types = value
            .get("extensionToLanguage")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|m| m.keys())
            .filter(|s| !s.is_empty())
            .cloned()
            .collect();
    }
    let mut markers = value
        .get("rootMarkers")
        .map(|v| strings(v, false))
        .unwrap_or_default();
    if markers.is_empty() && truthy(value.get("extensionToLanguage")) {
        markers.push(".".into());
    }
    if file_types.is_empty() || markers.is_empty() {
        return None;
    }
    result.insert("fileTypes".into(), json!(file_types));
    result.insert("rootMarkers".into(), json!(markers));
    if !value.get("initOptions").is_some_and(Value::is_object)
        && let Some(options) = value.get("initializationOptions").filter(|v| v.is_object())
    {
        result.insert("initOptions".into(), options.clone());
    }
    Some(Value::Object(result))
}
fn merge_servers(base: &mut Map<String, Value>, overrides: &Map<String, Value>) {
    for (name, value) in overrides {
        if name == "idleTimeoutMs" {
            continue;
        }
        let Some(overrides) = value.as_object() else {
            continue;
        };
        let mut candidate = base
            .get(name)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        candidate.extend(overrides.clone());
        if let Some(server) = normalized(&candidate) {
            base.insert(name.clone(), server);
        }
    }
}
fn parse_content(content: &str, path: &Path) -> Option<Value> {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "yaml" | "yml" => serde_saphyr::from_str_with_options(
            content,
            serde_saphyr::options! { strict_booleans: true, reject_unsupported_tags: true },
        )
        .ok(),
        _ => serde_json::from_str(content).ok(),
    }
}
// Only ordinary file errors are tolerated. Generation/lease/observation failures are not config misses.
fn skip_io(error: io::Error) -> Result<(), LspError> {
    if error
        .get_ref()
        .is_some_and(|inner| inner.is::<marsh_core::ShellError>())
        || error.kind() == io::ErrorKind::Other
    {
        return Err(LspError::Tool(error.to_string()));
    }
    Ok(())
}
fn exists(epoch: &ManagedEpoch<'_>, path: &Path) -> Result<bool, LspError> {
    match epoch.metadata(path) {
        Ok(_) => Ok(true),
        Err(error) => {
            skip_io(error)?;
            Ok(false)
        }
    }
}
fn glob_regex(pattern: &str) -> Option<regex::Regex> {
    fn literal(regex: &mut String, c: char) {
        if matches!(
            c,
            '\\' | '.' | '+' | '(' | ')' | '|' | '^' | '$' | '[' | ']' | '{' | '}' | '*' | '?'
        ) {
            regex.push('\\');
        }
        regex.push(c);
    }
    let mut regex = String::from("^");
    let mut chars = pattern.chars().peekable();
    let mut braces = Vec::new();
    let mut component_start = true;
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if component_start && chars.peek() == Some(&'*') {
                    while chars.peek() == Some(&'*') {
                        chars.next();
                    }
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        regex.push_str("(?:[^/]+/)?");
                        continue;
                    }
                }
                regex.push_str("[^/]*");
                component_start = false;
            }
            '?' => {
                regex.push_str("[^/]");
                component_start = false;
            }
            '[' => {
                regex.push('[');
                if chars.peek() == Some(&'!') {
                    chars.next();
                    regex.push('^');
                }
                for c in chars.by_ref() {
                    regex.push(c);
                    if c == ']' {
                        break;
                    }
                }
                component_start = false;
            }
            '{' => {
                braces.push(component_start);
                regex.push_str("(?:");
            }
            ',' if !braces.is_empty() => {
                regex.push('|');
                component_start = *braces.last()?;
            }
            '}' if !braces.is_empty() => {
                braces.pop();
                regex.push(')');
                component_start = false;
            }
            '/' => {
                regex.push('/');
                component_start = true;
            }
            '\\' => {
                literal(&mut regex, chars.next().unwrap_or('\\'));
                component_start = false;
            }
            _ => {
                literal(&mut regex, c);
                component_start = false;
            }
        }
    }
    if !braces.is_empty() {
        return None;
    }
    regex.push('$');
    regex::Regex::new(&regex).ok()
}
fn has_root_markers(epoch: &ManagedEpoch<'_>, markers: &[String]) -> Result<bool, LspError> {
    let mut entries: Option<Vec<PathBuf>> = None;
    let mut children: Option<Vec<PathBuf>> = None;
    for marker in markers {
        if !marker.contains(['*', '?', '[', '{']) {
            if exists(epoch, &epoch.cwd().join(marker))? {
                return Ok(true);
            }
            continue;
        }
        if entries.is_none() {
            let mut paths = Vec::new();
            match epoch.read_dir(epoch.cwd()) {
                Ok(iter) => {
                    for entry in iter {
                        match entry {
                            Ok(path) => paths.push(path),
                            Err(error) => skip_io(error)?,
                        }
                    }
                }
                Err(error) => skip_io(error)?,
            }
            entries = Some(paths);
        }
        let Some(regex) = glob_regex(marker) else {
            continue;
        };
        let matches = |path: &PathBuf| {
            path.strip_prefix(epoch.cwd())
                .ok()
                .is_some_and(|relative| regex.is_match(&relative.to_string_lossy()))
        };
        if entries
            .as_ref()
            .is_some_and(|paths| paths.iter().any(matches))
        {
            return Ok(true);
        }
        if marker.contains('/') {
            if children.is_none() {
                let mut paths = Vec::new();
                for directory in entries.as_deref().unwrap_or_default() {
                    match epoch.symlink_metadata(directory) {
                        Ok(metadata) if metadata.is_dir() => match epoch.read_dir(directory) {
                            Ok(iter) => {
                                for entry in iter {
                                    match entry {
                                        Ok(path) => paths.push(path),
                                        Err(error) => skip_io(error)?,
                                    }
                                }
                            }
                            Err(error) => skip_io(error)?,
                        },
                        Ok(_) => {}
                        Err(error) => skip_io(error)?,
                    }
                }
                // Root markers may inspect one child level, never an ancestor or recursive tree.
                children = Some(paths);
            }
            if children
                .as_ref()
                .is_some_and(|paths| paths.iter().any(matches))
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
pub(crate) fn resolve_command(
    epoch: &ManagedEpoch<'_>,
    command: &str,
) -> Result<Option<PathBuf>, LspError> {
    if Path::new(command).components().count() == 1 {
        const PYTHON: &[&str] = &[
            "pyproject.toml",
            "ty.toml",
            "requirements.txt",
            "setup.py",
            "setup.cfg",
            "Pipfile",
            "pyrightconfig.json",
            "ruff.toml",
            ".ruff.toml",
        ];
        let groups: &[(&[&str], &[&str])] = &[
            (
                &[
                    "package.json",
                    "package-lock.json",
                    "yarn.lock",
                    "pnpm-lock.yaml",
                ],
                &["node_modules/.bin"],
            ),
            (
                PYTHON,
                &[
                    ".venv/bin",
                    ".venv/Scripts",
                    "venv/bin",
                    "venv/Scripts",
                    ".env/bin",
                    ".env/Scripts",
                ],
            ),
            (&["Gemfile", "Gemfile.lock"], &["vendor/bundle/bin", "bin"]),
            (&["go.mod", "go.sum", "go.work"], &["bin"]),
        ];
        for (markers, dirs) in groups {
            if !has_root_markers(
                epoch,
                &markers.iter().map(|s| (*s).into()).collect::<Vec<_>>(),
            )? {
                continue;
            }
            for dir in *dirs {
                let candidate = epoch.cwd().join(dir).join(command);
                match epoch.resolve_executable(candidate.as_os_str(), None) {
                    Ok(path) => return Ok(Some(path)),
                    Err(error) => skip_io(error)?,
                }
            }
        }
    }
    match epoch.resolve_executable(std::ffi::OsStr::new(command), None) {
        Ok(path) => Ok(Some(path)),
        Err(error) => {
            skip_io(error)?;
            Ok(None)
        }
    }
}
fn typescript_speaks_lsp(epoch: &ManagedEpoch<'_>, command: &Path) -> Result<bool, LspError> {
    let mut real = command.to_owned();
    // Follow launcher links through tracked reads rather than host realpath.
    for _ in 0..40 {
        let metadata = match epoch.symlink_metadata(&real) {
            Ok(value) => value,
            Err(error) => {
                skip_io(error)?;
                break;
            }
        };
        if !metadata.file_type().is_symlink() {
            break;
        }
        let target = epoch
            .read_link(&real)
            .map_err(|e| LspError::Tool(e.to_string()))?;
        real = normalize_path(&if target.is_absolute() {
            target
        } else {
            real.parent().unwrap_or(Path::new("/")).join(target)
        });
    }
    let bin = command.parent().unwrap_or(Path::new("/"));
    let mut candidates = Vec::with_capacity(3);
    if let Some(parent) = real
        .parent()
        .filter(|p| p.file_name().is_some_and(|s| s == "bin"))
        .and_then(Path::parent)
    {
        candidates.push(parent.to_owned());
    }
    candidates.push(normalize_path(&bin.join("../typescript")));
    candidates.push(bin.join("node_modules/typescript"));
    for dir in candidates {
        if exists(epoch, &dir.join("package.json"))? {
            return Ok(!exists(epoch, &dir.join("lib/tsserver.js"))?);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tolerant_merges_preserve_order_and_previous_valid_values() {
        let cases = [
            (
                json!({"command":"","settings":{"lost":true}}),
                "server",
                json!({"a":1}),
            ),
            (
                json!({"settings":{"b":2},"args":["",3,"x"]}),
                "server",
                json!({"b":2}),
            ),
            (json!({"disabled":true}), "server", json!({"a":1})),
        ];
        for (override_value, command, settings) in cases {
            let mut base = Map::new();
            merge_servers(&mut base, json!({"first":{"command":"server","fileTypes":[".X",null,""],"rootMarkers":["."],"settings":{"a":1}},"last":{"command":"other","fileTypes":["x"],"rootMarkers":["."]}}).as_object().unwrap());
            merge_servers(
                &mut base,
                json!({"first":override_value,"invalid":{"command":"no"}})
                    .as_object()
                    .unwrap(),
            );
            assert_eq!(
                base.keys().map(String::as_str).collect::<Vec<_>>(),
                ["first", "last"]
            );
            assert_eq!(base["first"]["command"], command);
            assert_eq!(base["first"]["settings"], settings);
        }
    }
    #[test]
    fn legacy_yaml_and_argument_normalization() {
        let value = parse_content("servers:\n  custom:\n    command: server\n    extensionToLanguage: {'.x': x}\n    initializationOptions: {enabled: yes}\n    args: ['', 2, ok]\n", Path::new("lsp.yaml")).unwrap();
        let server = normalized(value["servers"]["custom"].as_object().unwrap()).unwrap();
        assert_eq!(server["rootMarkers"], json!(["."]));
        assert_eq!(server["fileTypes"], json!([".x"]));
        assert_eq!(server["initOptions"]["enabled"], "yes");
        assert_eq!(strings(&server["args"], true), ["", "ok"]);
        assert!(parse_content("x: !include missing.yaml", Path::new("lsp.yml")).is_none());
    }
    #[test]
    fn native_user_roots_and_one_level_markers() {
        let context = ConfigContext {
            construction_cwd: "/launch".into(),
            home: Some("/home/u".into()),
            pi_config_dir: Some("/custom".into()),
            claude_config_dir: Some("relative".into()),
        };
        assert_eq!(
            context.roots(Path::new("/repo")),
            [
                "/repo",
                "/repo/.omp",
                "/repo/.claude",
                "/repo/.codex",
                "/repo/.gemini",
                "/home/u/custom/agent",
                "/launch/relative",
                "/home/u"
            ]
            .map(PathBuf::from)
        );
        for (pattern, yes, no) in [
            ("*.cabal", "a.cabal", "dir/a.cabal"),
            ("file?.[ch]", "file1.c", "file12.c"),
            ("**/*.cabal", "a.cabal", "deep/dir/a.cabal"),
            ("**/*.cabal", "dir/a.cabal", "deep/dir/a.cabal"),
            ("*.{sln,csproj}", "app.csproj", "app.txt"),
            ("{**/*.cabal,*.sln}", "app.cabal", "deep/dir/app.cabal"),
            ("marker/*.flag", "marker/one.flag", "marker/deep/one.flag"),
            (r"file\?.c", "file?.c", "file1.c"),
        ] {
            let regex = glob_regex(pattern).unwrap();
            assert!(regex.is_match(yes));
            assert!(!regex.is_match(no));
        }
    }
}
