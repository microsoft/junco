//! Walk, fingerprint, incremental reuse, resolve, persist.

use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    time::{Instant, UNIX_EPOCH},
};

use rayon::prelude::*;
use sha2::{Digest, Sha256};

use crate::{
    EXTRACTOR_VERSION, GRAPH_VERSION, Heartbeat, cache_path,
    extract::extract,
    lang::{LangSpec, spec_for_path},
    model::{BuildReport, FileEntry, Graph},
    resolve::resolve,
};

const MAX_FILE_BYTES: u64 = 1 << 20;

fn load_cache(path: &Path) -> Option<Graph> {
    let graph: Graph = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (graph.version == GRAPH_VERSION && graph.extractor == EXTRACTOR_VERSION).then_some(graph)
}

fn walk(root: &Path, heartbeat: Heartbeat<'_>) -> Result<Vec<(String, &'static LangSpec)>, String> {
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != "node_modules")
        .build();
    let mut out = Vec::new();
    for (i, entry) in walker.enumerate() {
        if i % 256 == 0 {
            heartbeat()?;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(spec) = spec_for_path(entry.path()) else {
            continue;
        };
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let Some(parts) = rel
            .components()
            .map(|c| c.as_os_str().to_str())
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        out.push((parts.join("/"), spec));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn fingerprint(root: &Path, rel: &str) -> Result<(u64, u64), String> {
    let meta = fs::metadata(root.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Ok((meta.len(), mtime_ms))
}

/// Returns the entry and whether it was reused from the cache.
fn file_entry(
    root: &Path,
    rel: &str,
    spec: &LangSpec,
    cached: Option<&FileEntry>,
) -> Result<(FileEntry, bool), String> {
    let (size, mtime_ms) = fingerprint(root, rel)?;
    if let Some(c) = cached
        && c.size == size
        && c.mtime_ms == mtime_ms
    {
        return Ok((c.clone(), true));
    }
    let bytes = fs::read(root.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if let Some(c) = cached
        && c.hash == hash
    {
        return Ok((
            FileEntry {
                size,
                mtime_ms,
                ..c.clone()
            },
            true,
        ));
    }
    let mut entry = FileEntry {
        size,
        mtime_ms,
        hash,
        lang: spec.lang.canonical_name().to_string(),
        nodes: Vec::new(),
        raw_edges: Vec::new(),
        imports: Vec::new(),
        error: None,
    };
    if bytes.len() as u64 > MAX_FILE_BYTES {
        entry.error = Some("larger than 1 MiB".into());
    } else if let Ok(source) = std::str::from_utf8(&bytes) {
        let x = extract(rel, source, spec);
        entry.nodes = x.nodes;
        entry.raw_edges = x.raw_edges;
        entry.imports = x.imports;
        entry.error = x.error;
    } else {
        entry.error = Some("not UTF-8".into());
    }
    Ok((entry, false))
}

pub fn build(
    root: &Path,
    full: bool,
    heartbeat: Heartbeat<'_>,
) -> Result<(Graph, BuildReport), String> {
    let started = Instant::now();
    let root = fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let cache = cache_path(&root);
    let (cached, full) = if full {
        (BTreeMap::new(), true)
    } else {
        match load_cache(&cache) {
            Some(g) => (g.files, false),
            None => (BTreeMap::new(), true),
        }
    };

    let paths = walk(&root, heartbeat)?;
    let entries: Vec<(String, FileEntry, bool)> = paths
        .par_iter()
        .map(|(rel, spec)| {
            heartbeat()?;
            let (entry, reused) = file_entry(&root, rel, spec, cached.get(rel))?;
            Ok((rel.clone(), entry, reused))
        })
        .collect::<Result<_, String>>()?;

    let files_reused = entries.iter().filter(|e| e.2).count() as u32;
    let files_parsed = entries.len() as u32 - files_reused;
    let files: BTreeMap<String, FileEntry> = entries.into_iter().map(|(p, e, _)| (p, e)).collect();
    let files_removed = cached.keys().filter(|k| !files.contains_key(*k)).count() as u32;
    heartbeat()?;
    let (edges, unresolved_imports) = resolve(&files, &root);
    let graph = Graph {
        version: GRAPH_VERSION,
        extractor: EXTRACTOR_VERSION,
        files,
        edges,
    };

    let dir = cache.parent().expect("cache path has a parent");
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // ponytail: no lock; add a .lock file if two agents ever race here (last writer wins).
    let tmp = dir.join(format!("graph.json.tmp.{}", std::process::id()));
    let json = serde_json::to_vec(&graph).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, &cache).map_err(|e| format!("{}: {e}", cache.display()))?;

    let mut languages = BTreeMap::new();
    let mut errors = Vec::new();
    let mut nodes = 0u32;
    for (path, f) in &graph.files {
        *languages.entry(f.lang.clone()).or_insert(0u32) += 1;
        nodes += f.nodes.len() as u32;
        if let Some(e) = &f.error {
            errors.push((path.clone(), e.clone()));
        }
    }
    let report = BuildReport {
        files_total: graph.files.len() as u32,
        files_parsed,
        files_reused,
        files_removed,
        nodes,
        edges: graph.edges.len() as u32,
        languages,
        unresolved_imports,
        errors,
        duration_ms: started.elapsed().as_millis() as u64,
        cache_path: cache.display().to_string(),
        full,
    };
    Ok((graph, report))
}
