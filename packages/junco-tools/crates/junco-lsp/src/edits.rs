//! Workspace edits are preflighted in order; an execution error must escape its managed epoch.
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use lsp_types::{
    DocumentChangeOperation, DocumentChanges, OneOf, Position, Range, ResourceOp, TextDocumentEdit,
    TextEdit, Uri, WorkspaceEdit,
};
use marsh_core::ManagedEpoch;
use serde_json::Value;
use url::Url;

#[derive(Debug, thiserror::Error)]
pub(crate) enum EditError {
    #[error("{0}")]
    Invalid(String),
    #[error("{path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Marsh(#[from] marsh_core::ShellError),
}

fn invalid(message: impl Into<String>) -> EditError {
    EditError::Invalid(message.into())
}
fn at(path: &Path, source: io::Error) -> EditError {
    EditError::Io {
        path: path.to_owned(),
        source,
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct EditSummary {
    /// Physical paths, translated by the engine before any result is released.
    pub changed: Vec<PathBuf>,
    pub created: Vec<PathBuf>,
    pub deleted: Vec<PathBuf>,
    pub renamed: Vec<(PathBuf, PathBuf)>,
    pub text_edits: usize,
    pub resource_operations: usize,
}

pub(crate) fn path_to_uri(path: &Path) -> Result<Uri, EditError> {
    let url = Url::from_file_path(path)
        .map_err(|()| invalid(format!("not an absolute file path: {}", path.display())))?;
    url.as_str()
        .parse()
        .map_err(|error| invalid(format!("invalid file URI: {error}")))
}

pub(crate) fn uri_to_path(epoch: &ManagedEpoch<'_>, uri: &Uri) -> Result<PathBuf, EditError> {
    let path = file_uri_path(uri)?;
    Ok(epoch.physical_path(&path)?)
}

fn file_uri_path(uri: &Uri) -> Result<PathBuf, EditError> {
    Url::parse(uri.as_str())
        .map_err(|error| invalid(format!("invalid file URI: {error}")))?
        .to_file_path()
        .map_err(|()| invalid(format!("not a local file URI: {}", uri.as_str())))
}

/// Must run on the wire value before lsp-types drops unknown extension fields.
pub(crate) fn reject_workspace_edit_snippets(value: &Value) -> Result<(), EditError> {
    match value {
        Value::Object(object) => {
            if object.get("insertTextFormat").and_then(Value::as_f64) == Some(2.0) {
                return Err(invalid("snippet-formatted LSP edits are unsupported"));
            }
            for value in object.values() {
                reject_workspace_edit_snippets(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                reject_workspace_edit_snippets(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn position_key(position: Position) -> (u32, u32) {
    (position.line, position.character)
}
fn ranges_overlap(a: Range, b: Range) -> bool {
    position_key(a.start) < position_key(b.end) && position_key(b.start) < position_key(a.end)
}
fn nonempty(range: Range) -> bool {
    range.start != range.end
}

/// LSP positions count UTF-16 code units, not bytes or Rust scalar values.
pub(crate) fn position_to_offset(content: &str, position: Position) -> Result<usize, EditError> {
    let bytes = content.as_bytes();
    let mut start = 0;
    for _ in 0..position.line {
        let Some(relative) = bytes[start..]
            .iter()
            .position(|byte| matches!(*byte, b'\r' | b'\n'))
        else {
            return Err(invalid(format!(
                "line {} is outside the document",
                u64::from(position.line) + 1
            )));
        };
        start += relative;
        if bytes[start] == b'\r' && bytes.get(start + 1) == Some(&b'\n') {
            start += 2;
        } else {
            start += 1;
        }
    }
    let end = bytes[start..]
        .iter()
        .position(|byte| matches!(*byte, b'\r' | b'\n'))
        .map_or(bytes.len(), |relative| start + relative);
    let mut units = 0_usize;
    let column = usize::try_from(position.character).map_err(|error| invalid(error.to_string()))?;
    for (offset, character) in content[start..end].char_indices() {
        if units == column {
            return Ok(start + offset);
        }
        units += character.len_utf16();
        if units > column {
            return Err(invalid("LSP position splits a UTF-16 surrogate pair"));
        }
    }
    if units == column {
        Ok(end)
    } else {
        Err(invalid(format!(
            "UTF-16 column {} is outside line {}",
            u64::from(position.character) + 1,
            u64::from(position.line) + 1
        )))
    }
}

fn sorted_edits(edits: &[TextEdit]) -> Result<Vec<&TextEdit>, EditError> {
    let mut unique = HashSet::with_capacity(edits.len());
    let mut sorted = Vec::with_capacity(edits.len());
    for (index, edit) in edits.iter().enumerate() {
        if position_key(edit.range.start) > position_key(edit.range.end) {
            return Err(invalid("LSP edit range ends before it starts"));
        }
        let key = (
            position_key(edit.range.start),
            position_key(edit.range.end),
            edit.new_text.as_str(),
        );
        if nonempty(edit.range) && !unique.insert(key) {
            continue;
        }
        sorted.push((index, edit));
    }
    sorted.sort_unstable_by(|(ai, a), (bi, b)| {
        position_key(b.range.start)
            .cmp(&position_key(a.range.start))
            // A replacement at an insertion's start must run first, so it cannot consume that insertion.
            .then_with(|| nonempty(b.range).cmp(&nonempty(a.range)))
            .then_with(|| bi.cmp(ai))
    });
    for pair in sorted.windows(2) {
        if ranges_overlap(pair[0].1.range, pair[1].1.range) {
            return Err(invalid(
                "overlapping LSP edits; the server produced inconsistent edits",
            ));
        }
    }
    Ok(sorted.into_iter().map(|(_, edit)| edit).collect())
}

#[cfg(test)]
pub(crate) fn apply_text_edits(content: &str, edits: &[TextEdit]) -> Result<String, EditError> {
    apply_sorted_text_edits(content, &sorted_edits(edits)?)
}

fn apply_sorted_text_edits(content: &str, sorted: &[&TextEdit]) -> Result<String, EditError> {
    let offsets = sorted
        .iter()
        .map(|edit| {
            Ok((
                position_to_offset(content, edit.range.start)?,
                position_to_offset(content, edit.range.end)?,
                edit.new_text.as_str(),
            ))
        })
        .collect::<Result<Vec<_>, EditError>>()?;
    let mut result = content.to_owned();
    for (start, end, text) in offsets {
        result.replace_range(start..end, text);
    }
    Ok(result)
}

fn check_version(
    known: &HashMap<String, i32>,
    uri: &Uri,
    required: Option<i32>,
) -> Result<(), EditError> {
    if let Some(required) = required {
        match known.get(uri.as_str()) {
            Some(actual) if *actual == required => {}
            Some(actual) => {
                return Err(invalid(format!(
                    "document version mismatch for {}: expected {required}, open version is {actual}",
                    uri.as_str()
                )));
            }
            None => {
                return Err(invalid(format!(
                    "cannot apply versioned edit to unopened document {}",
                    uri.as_str()
                )));
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
enum Op {
    Text {
        path: PathBuf,
        edits: Vec<TextEdit>,
    },
    Create {
        path: PathBuf,
        overwrite: bool,
        ignore: bool,
    },
    Rename {
        from: PathBuf,
        to: PathBuf,
        overwrite: bool,
        ignore: bool,
    },
    Delete {
        path: PathBuf,
        recursive: bool,
        ignore: bool,
    },
}

fn append_text(
    epoch: &ManagedEpoch<'_>,
    document: &TextDocumentEdit,
    known: &HashMap<String, i32>,
    pending: &mut Vec<(PathBuf, Vec<TextEdit>)>,
) -> Result<(), EditError> {
    let path = uri_to_path(epoch, &document.text_document.uri)?;
    let physical_uri = path_to_uri(&path)?;
    check_version(known, &physical_uri, document.text_document.version)?;
    let edits = document.edits.iter().map(|edit| match edit {
        OneOf::Left(edit) => edit.clone(),
        OneOf::Right(edit) => edit.text_edit.clone(),
    });
    if let Some((_, previous)) = pending.iter_mut().find(|(candidate, _)| *candidate == path) {
        previous.extend(edits);
    } else {
        pending.push((path, edits.collect()));
    }
    Ok(())
}

fn flush(pending: &mut Vec<(PathBuf, Vec<TextEdit>)>, ops: &mut Vec<Op>, paths: &[&Path]) {
    let mut index = 0;
    while index < pending.len() {
        if paths.is_empty() || paths.iter().any(|path| pending[index].0.starts_with(path)) {
            let (path, edits) = pending.remove(index);
            if !edits.is_empty() {
                ops.push(Op::Text { path, edits });
            }
        } else {
            index += 1;
        }
    }
}

fn plan(
    epoch: &ManagedEpoch<'_>,
    edit: &WorkspaceEdit,
    known: &HashMap<String, i32>,
) -> Result<Vec<Op>, EditError> {
    let mut ops = Vec::new();
    let mut pending = Vec::new();
    if let Some(changes) = &edit.document_changes {
        let (documents, operations): (&[TextDocumentEdit], &[DocumentChangeOperation]) =
            match changes {
                DocumentChanges::Edits(edits) => (edits, &[]),
                DocumentChanges::Operations(operations) => (&[], operations),
            };
        for document in documents {
            append_text(epoch, document, known, &mut pending)?;
        }
        for operation in operations {
            match operation {
                DocumentChangeOperation::Edit(document) => {
                    append_text(epoch, document, known, &mut pending)?
                }
                DocumentChangeOperation::Op(resource) => {
                    let op = match resource {
                        ResourceOp::Create(create) => {
                            let path = uri_to_path(epoch, &create.uri)?;
                            flush(&mut pending, &mut ops, &[&path]);
                            let options = create.options.as_ref();
                            Op::Create {
                                path,
                                overwrite: options.and_then(|o| o.overwrite).unwrap_or(false),
                                ignore: options.and_then(|o| o.ignore_if_exists).unwrap_or(false),
                            }
                        }
                        ResourceOp::Rename(rename) => {
                            let from = uri_to_path(epoch, &rename.old_uri)?;
                            let to = uri_to_path(epoch, &rename.new_uri)?;
                            flush(&mut pending, &mut ops, &[&from, &to]);
                            let options = rename.options.as_ref();
                            Op::Rename {
                                from,
                                to,
                                overwrite: options.and_then(|o| o.overwrite).unwrap_or(false),
                                ignore: options.and_then(|o| o.ignore_if_exists).unwrap_or(false),
                            }
                        }
                        ResourceOp::Delete(delete) => {
                            let path = uri_to_path(epoch, &delete.uri)?;
                            flush(&mut pending, &mut ops, &[&path]);
                            let options = delete.options.as_ref();
                            Op::Delete {
                                path,
                                recursive: options.and_then(|o| o.recursive).unwrap_or(false),
                                ignore: options
                                    .and_then(|o| o.ignore_if_not_exists)
                                    .unwrap_or(false),
                            }
                        }
                    };
                    ops.push(op);
                }
            }
        }
    } else if let Some(changes) = &edit.changes {
        // Independent legacy map entries have no specified order; make the receipt deterministic.
        let mut changes: Vec<_> = changes.iter().collect();
        changes.sort_unstable_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
        for (uri, edits) in changes {
            pending.push((uri_to_path(epoch, uri)?, edits.clone()));
        }
    }
    flush(&mut pending, &mut ops, &[]);
    Ok(ops)
}

#[derive(Clone, Debug)]
enum Entry {
    File {
        source: PathBuf,
        text: Option<Arc<str>>,
    },
    Directory {
        source: Option<PathBuf>,
    },
    Symlink(PathBuf),
    Other,
    Missing,
}

/// Only touched paths are materialized. Resource subtrees are read through the epoch, never std::fs.
struct Preview<'a, 'session> {
    epoch: &'a ManagedEpoch<'session>,
    entries: BTreeMap<PathBuf, Entry>,
}
impl Preview<'_, '_> {
    fn entry(&mut self, path: &Path) -> Result<Entry, EditError> {
        if let Some(entry) = self.entries.get(path) {
            return Ok(entry.clone());
        }
        let ancestor = path
            .ancestors()
            .skip(1)
            .find_map(|ancestor| self.entries.get(ancestor).map(|entry| (ancestor, entry)));
        let source = match ancestor {
            Some((_, Entry::Missing | Entry::Directory { source: None })) => {
                return Ok(Entry::Missing);
            }
            Some((
                ancestor,
                Entry::Directory {
                    source: Some(source),
                },
            )) => source.join(
                path.strip_prefix(ancestor)
                    .map_err(|error| invalid(error.to_string()))?,
            ),
            Some((_, Entry::File { .. } | Entry::Other)) => {
                return Err(invalid(format!(
                    "parent is not a directory: {}",
                    path.display()
                )));
            }
            _ => path.to_owned(),
        };
        let entry = match self.epoch.symlink_metadata(&source) {
            Ok(metadata) if metadata.is_symlink() => Entry::Symlink(
                self.epoch
                    .read_link(&source)
                    .map_err(|error| at(path, error))?,
            ),
            Ok(metadata) if metadata.is_dir() => Entry::Directory {
                source: Some(source),
            },
            Ok(metadata) if metadata.is_file() => Entry::File { source, text: None },
            Ok(_) => Entry::Other,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Entry::Missing,
            Err(error) => return Err(at(path, error)),
        };
        self.entries.insert(path.to_owned(), entry.clone());
        Ok(entry)
    }

    fn text(&mut self, path: &Path, depth: u8) -> Result<(PathBuf, Arc<str>), EditError> {
        match self.entry(path)? {
            Entry::File {
                text: Some(text), ..
            } => Ok((path.to_owned(), text)),
            Entry::File { source, text: None } => self
                .epoch
                .read_to_string(&source)
                .map(|text| (path.to_owned(), Arc::from(text)))
                .map_err(|error| at(path, error)),
            Entry::Symlink(target) if depth < 40 => {
                let target = if target.is_absolute() {
                    self.epoch.physical_path(&target)?
                } else {
                    path.parent().unwrap_or(Path::new("/")).join(target)
                };
                self.text(&target, depth + 1)
            }
            Entry::Symlink(_) => Err(invalid(format!("too many symlinks: {}", path.display()))),
            _ => Err(invalid(format!(
                "not an existing text file: {}",
                path.display()
            ))),
        }
    }

    fn parents(&mut self, path: &Path) -> Result<(), EditError> {
        let Some(parent) = path.parent() else {
            return Ok(());
        };
        match self.entry(parent)? {
            Entry::Directory { .. } => Ok(()),
            Entry::Missing => {
                self.parents(parent)?;
                self.entries
                    .insert(parent.to_owned(), Entry::Directory { source: None });
                Ok(())
            }
            Entry::Symlink(_)
                if self
                    .epoch
                    .metadata(parent)
                    .map_err(|error| at(parent, error))?
                    .is_dir() =>
            {
                Ok(())
            }
            _ => Err(invalid(format!(
                "parent is not a directory: {}",
                parent.display()
            ))),
        }
    }

    fn children(&mut self, path: &Path) -> Result<Vec<PathBuf>, EditError> {
        let mut children = HashSet::new();
        if let Entry::Directory {
            source: Some(source),
        } = self.entry(path)?
        {
            for child in self
                .epoch
                .read_dir(&source)
                .map_err(|error| at(&source, error))?
            {
                let child = child.map_err(|error| at(&source, error))?;
                if let Some(name) = child.file_name() {
                    let destination = path.join(name);
                    if !self.entries.contains_key(&destination) {
                        let physical = self.epoch.physical_path(&child)?;
                        let entry = self.entry(&physical)?;
                        self.entries.insert(destination.clone(), entry);
                    }
                    children.insert(destination);
                }
            }
        }
        for child in self.entries.keys() {
            if child.parent() == Some(path) {
                children.insert(child.clone());
            }
        }
        let mut children: Vec<_> = children
            .into_iter()
            .filter(|child| !matches!(self.entries.get(child), Some(Entry::Missing)))
            .collect();
        children.sort_unstable();
        Ok(children)
    }

    fn subtree(&mut self, path: &Path, out: &mut Vec<(PathBuf, Entry)>) -> Result<(), EditError> {
        let entry = self.entry(path)?;
        if matches!(entry, Entry::Directory { .. }) {
            for child in self.children(path)? {
                self.subtree(&child, out)?;
            }
        }
        out.push((path.to_owned(), entry));
        Ok(())
    }

    fn forget(&mut self, path: &Path) {
        self.entries
            .retain(|candidate, _| !candidate.starts_with(path));
        self.entries.insert(path.to_owned(), Entry::Missing);
    }
}

#[derive(Debug)]
enum Prepared {
    Write(PathBuf, Arc<str>),
    Create(PathBuf, bool),
    Rename(PathBuf, PathBuf, bool),
    Delete(PathBuf, bool),
}

pub(crate) fn apply_workspace_edit(
    epoch: &ManagedEpoch<'_>,
    edit: &WorkspaceEdit,
    known_versions: &HashMap<String, i32>,
    apply: bool,
) -> Result<EditSummary, EditError> {
    let ops = plan(epoch, edit, known_versions)?;
    let mut preview = Preview {
        epoch,
        entries: BTreeMap::new(),
    };
    let mut prepared = Vec::with_capacity(ops.len());
    let mut summary = EditSummary::default();
    for op in ops {
        match op {
            Op::Text { path, edits } => {
                let (target, content) = preview.text(&path, 0)?;
                let sorted = sorted_edits(&edits)?;
                let updated: Arc<str> = apply_sorted_text_edits(&content, &sorted)?.into();
                summary.text_edits += sorted.len();
                summary.changed.push(path.clone());
                // Cache the referent, not the link: relocation changes relative symlink resolution.
                preview.entries.insert(
                    target.clone(),
                    Entry::File {
                        source: target,
                        text: Some(updated.clone()),
                    },
                );
                prepared.push(Prepared::Write(path, updated));
            }
            Op::Create {
                path,
                overwrite,
                ignore,
            } => {
                let created = match preview.entry(&path)? {
                    Entry::Missing => true,
                    _ if !overwrite && ignore => continue,
                    Entry::File { .. } | Entry::Symlink(_) if overwrite => false,
                    _ => {
                        return Err(invalid(format!(
                            "create target already exists: {}",
                            path.display()
                        )));
                    }
                };
                if created {
                    summary.created.push(path.clone());
                }
                preview.parents(&path)?;
                preview.entries.insert(
                    path.clone(),
                    Entry::File {
                        source: path.clone(),
                        text: Some(Arc::from("")),
                    },
                );
                summary.changed.push(path.clone());
                summary.resource_operations += 1;
                prepared.push(Prepared::Create(path, overwrite));
            }
            Op::Rename {
                from,
                to,
                overwrite,
                ignore,
            } => {
                if matches!(preview.entry(&from)?, Entry::Missing) {
                    return Err(invalid(format!(
                        "rename source does not exist: {}",
                        from.display()
                    )));
                }
                if from == to {
                    continue;
                }
                if to.starts_with(&from) || from.starts_with(&to) {
                    return Err(invalid(
                        "cannot rename between a directory and its descendant",
                    ));
                }
                if !matches!(preview.entry(&to)?, Entry::Missing) && !overwrite {
                    if ignore {
                        continue;
                    }
                    return Err(invalid(format!(
                        "rename target already exists: {}",
                        to.display()
                    )));
                }
                preview.parents(&to)?;
                let mut entries = Vec::new();
                preview.subtree(&from, &mut entries)?;
                preview.forget(&to);
                preview.forget(&from);
                for (path, entry) in entries {
                    let relative = path
                        .strip_prefix(&from)
                        .map_err(|error| invalid(error.to_string()))?;
                    preview.entries.insert(to.join(relative), entry);
                }
                summary.renamed.push((from.clone(), to.clone()));
                summary.resource_operations += 1;
                prepared.push(Prepared::Rename(from, to, overwrite));
            }
            Op::Delete {
                path,
                recursive,
                ignore,
            } => {
                match preview.entry(&path)? {
                    Entry::Missing if ignore => continue,
                    Entry::Missing => {
                        return Err(invalid(format!(
                            "delete target does not exist: {}",
                            path.display()
                        )));
                    }
                    Entry::Directory { .. }
                        if !recursive && !preview.children(&path)?.is_empty() =>
                    {
                        return Err(invalid(format!(
                            "directory is not empty: {}",
                            path.display()
                        )));
                    }
                    _ => {}
                }
                preview.forget(&path);
                summary.deleted.push(path.clone());
                summary.resource_operations += 1;
                prepared.push(Prepared::Delete(path, recursive));
            }
        }
    }
    if apply {
        for op in prepared {
            match op {
                Prepared::Write(path, content) => epoch
                    .write(&path, content.as_bytes())
                    .map_err(|error| at(&path, error))?,
                Prepared::Create(path, overwrite) => {
                    create_parents(epoch, &path)?;
                    let result = if overwrite {
                        epoch.write(&path, b"")
                    } else {
                        epoch.create_new(&path, b"")
                    };
                    result.map_err(|error| at(&path, error))?;
                }
                Prepared::Rename(from, to, overwrite) => {
                    rename_restoring_destination(epoch, &from, &to, overwrite)?
                }
                Prepared::Delete(path, recursive) => remove(epoch, &path, recursive)?,
            }
        }
    }
    Ok(summary)
}

fn create_parents(epoch: &ManagedEpoch<'_>, path: &Path) -> Result<(), EditError> {
    if let Some(parent) = path.parent() {
        epoch
            .create_dir_all(parent)
            .map_err(|error| at(parent, error))?;
    }
    Ok(())
}

fn remove(epoch: &ManagedEpoch<'_>, path: &Path, recursive: bool) -> Result<(), EditError> {
    let metadata = epoch
        .symlink_metadata(path)
        .map_err(|error| at(path, error))?;
    if metadata.is_dir() && !metadata.is_symlink() {
        if recursive {
            for child in epoch.read_dir(path).map_err(|error| at(path, error))? {
                let child = child.map_err(|error| at(path, error))?;
                remove(epoch, &child, true)?;
            }
        }
        epoch.remove_dir(path).map_err(|error| at(path, error))
    } else {
        epoch.remove_file(path).map_err(|error| at(path, error))
    }
}

fn rename_restoring_destination(
    epoch: &ManagedEpoch<'_>,
    from: &Path,
    to: &Path,
    overwrite: bool,
) -> Result<(), EditError> {
    create_parents(epoch, to)?;
    match epoch.symlink_metadata(to) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return epoch.rename(from, to).map_err(|error| at(from, error));
        }
        Err(error) => return Err(at(to, error)),
        Ok(target) => {
            if !overwrite {
                return Err(invalid(format!(
                    "rename target appeared after validation: {}",
                    to.display()
                )));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let source = epoch
                    .symlink_metadata(from)
                    .map_err(|error| at(from, error))?;
                if source.dev() == target.dev() && source.ino() == target.ino() {
                    return epoch.rename(from, to).map_err(|error| at(from, error));
                }
            }
            #[cfg(not(unix))]
            let _ = target;
        }
    }
    static NEXT_HOLD: AtomicU64 = AtomicU64::new(0);
    let parent = to
        .parent()
        .ok_or_else(|| invalid("rename target has no parent"))?;
    // The exclusive reservation remains in place until the displacement is cleaned up.
    let (reservation, directory) = loop {
        let name = format!(
            ".junco-lsp-hold-{}-{}",
            std::process::id(),
            NEXT_HOLD.fetch_add(1, Ordering::Relaxed)
        );
        let reservation = parent.join(format!("{name}.lock"));
        match epoch.create_new(&reservation, b"") {
            Ok(()) => {
                let directory = parent.join(name);
                match epoch.symlink_metadata(&directory) {
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        break (reservation, directory);
                    }
                    Ok(_) => epoch
                        .remove_file(&reservation)
                        .map_err(|error| at(&reservation, error))?,
                    Err(error) => return Err(at(&directory, error)),
                }
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(at(&reservation, error)),
        }
    };
    epoch
        .create_dir_all(&directory)
        .map_err(|error| at(&directory, error))?;
    let held = directory.join("destination");
    epoch.rename(to, &held).map_err(|error| at(to, error))?;
    if let Err(move_error) = epoch.rename(from, to) {
        if let Err(restore_error) = epoch.rename(&held, to) {
            return Err(invalid(format!(
                "rename failed: {move_error}; destination restoration failed: {restore_error}"
            )));
        }
        epoch
            .remove_dir(&directory)
            .map_err(|error| at(&directory, error))?;
        epoch
            .remove_file(&reservation)
            .map_err(|error| at(&reservation, error))?;
        return Err(at(from, move_error));
    }
    remove(epoch, &held, true)?;
    epoch
        .remove_dir(&directory)
        .map_err(|error| at(&directory, error))?;
    epoch
        .remove_file(&reservation)
        .map_err(|error| at(&reservation, error))?;
    Ok(())
}

/// Inputs are already ranked by the engine (project-aware before linter, otherwise stable order).
/// Identical replacements deduplicate; incompatible later text edits/resource operations are counted.
pub(crate) fn merge_workspace_edits(
    edits: &[WorkspaceEdit],
) -> Result<(WorkspaceEdit, usize), EditError> {
    let mut operations = Vec::new();
    let mut accepted: HashMap<PathBuf, Vec<TextEdit>> = HashMap::new();
    // Claims are published only between contributions: one server's ordered operations stay intact.
    let mut resource_claims: Vec<PathBuf> = Vec::new();
    let mut text_claims: Vec<PathBuf> = Vec::new();
    // ponytail: linear conflict lookup per edit; use an interval index only if rename batches make it costly.
    let mut discarded = 0;
    for edit in edits {
        let mut own_resources = Vec::new();
        let mut own_text = Vec::new();
        let candidates = if let Some(changes) = &edit.document_changes {
            match changes {
                DocumentChanges::Edits(edits) => edits
                    .iter()
                    .cloned()
                    .map(DocumentChangeOperation::Edit)
                    .collect::<Vec<_>>(),
                DocumentChanges::Operations(operations) => operations.clone(),
            }
        } else {
            let mut changes: Vec<_> = edit
                .changes
                .iter()
                .flat_map(|changes| changes.iter())
                .collect();
            changes.sort_unstable_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
            changes
                .into_iter()
                .map(|(uri, edits)| {
                    DocumentChangeOperation::Edit(TextDocumentEdit {
                        text_document: lsp_types::OptionalVersionedTextDocumentIdentifier {
                            uri: uri.clone(),
                            version: None,
                        },
                        edits: edits.iter().cloned().map(OneOf::Left).collect(),
                    })
                })
                .collect()
        };
        for candidate in candidates {
            match candidate {
                DocumentChangeOperation::Op(resource) => {
                    let touched = match &resource {
                        ResourceOp::Create(create) => vec![file_uri_path(&create.uri)?],
                        ResourceOp::Delete(delete) => vec![file_uri_path(&delete.uri)?],
                        ResourceOp::Rename(rename) => vec![
                            file_uri_path(&rename.old_uri)?,
                            file_uri_path(&rename.new_uri)?,
                        ],
                    };
                    if touched.iter().any(|root| {
                        resource_claims
                            .iter()
                            .chain(&text_claims)
                            .any(|prior| root.starts_with(prior) || prior.starts_with(root))
                    }) {
                        discarded += 1;
                        continue;
                    }
                    own_resources.extend(touched.iter().cloned());
                    accepted.retain(|path, _| !touched.iter().any(|root| path.starts_with(root)));
                    operations.push(DocumentChangeOperation::Op(resource));
                }
                DocumentChangeOperation::Edit(mut document) => {
                    let path = file_uri_path(&document.text_document.uri)?;
                    if resource_claims
                        .iter()
                        .any(|root| path.starts_with(root) || root.starts_with(&path))
                    {
                        discarded += document.edits.len();
                        continue;
                    }
                    let prior = accepted.entry(path.clone()).or_default();
                    let mut retained = Vec::with_capacity(document.edits.len());
                    for edit in document.edits {
                        let text = match &edit {
                            OneOf::Left(edit) => edit,
                            OneOf::Right(edit) => &edit.text_edit,
                        };
                        if position_key(text.range.start) > position_key(text.range.end) {
                            return Err(invalid("LSP edit range ends before it starts"));
                        }
                        if nonempty(text.range) && prior.iter().any(|previous| previous == text) {
                            continue;
                        }
                        if prior
                            .iter()
                            .any(|previous| ranges_overlap(previous.range, text.range))
                        {
                            discarded += 1;
                        } else {
                            prior.push(text.clone());
                            retained.push(edit);
                        }
                    }
                    if !retained.is_empty() {
                        own_text.push(path);
                        document.edits = retained;
                        operations.push(DocumentChangeOperation::Edit(document));
                    }
                }
            }
        }
        resource_claims.extend(own_resources);
        text_claims.extend(own_text);
    }
    Ok((
        WorkspaceEdit {
            document_changes: Some(DocumentChanges::Operations(operations)),
            ..WorkspaceEdit::default()
        },
        discarded,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use marsh_core::{Action, ManagedCancellation, ManagedError, ManagedSession, MarshTool};
    use serde_json::json;
    use std::borrow::Cow;

    fn text_edit(start: u32, end: u32, text: &str) -> TextEdit {
        TextEdit {
            range: Range::new(Position::new(0, start), Position::new(0, end)),
            new_text: text.into(),
        }
    }

    #[test]
    fn utf16_positions_and_crlf_are_strict_and_preserved() {
        let content = "a😀b\r\nβeta\r\n";
        assert_eq!(position_to_offset(content, Position::new(0, 3)).unwrap(), 5);
        assert_eq!(
            position_to_offset(content, Position::new(1, 0)).unwrap(),
            content.find('β').unwrap()
        );
        assert_eq!(
            position_to_offset(content, Position::new(2, 0)).unwrap(),
            content.len()
        );
        for position in [
            Position::new(0, 2),
            Position::new(0, 5),
            Position::new(3, 0),
        ] {
            assert!(position_to_offset(content, position).is_err());
        }
        let edits = [
            text_edit(1, 3, "X"),
            TextEdit {
                range: Range::new(Position::new(1, 0), Position::new(1, 1)),
                new_text: "B".into(),
            },
        ];
        assert_eq!(
            apply_text_edits(content, &edits).unwrap(),
            "aXb\r\nBeta\r\n"
        );
        let spanning = TextEdit {
            range: Range::new(Position::new(0, 4), Position::new(1, 1)),
            new_text: "!".into(),
        };
        assert_eq!(
            apply_text_edits(content, &[spanning]).unwrap(),
            "a😀b!eta\r\n"
        );
    }

    #[test]
    fn touching_edits_insertion_order_and_deduplication() {
        let cases = [
            (vec![text_edit(0, 1, "X"), text_edit(1, 2, "Y")], "XYc"),
            (vec![text_edit(1, 1, "A"), text_edit(1, 1, "B")], "aABbc"),
            (vec![text_edit(0, 1, "X"), text_edit(0, 1, "X")], "Xbc"),
            (vec![text_edit(0, 0, "Z"), text_edit(0, 0, "Z")], "ZZabc"),
            (vec![text_edit(0, 0, "I"), text_edit(0, 1, "X")], "IXbc"),
            (vec![text_edit(0, 1, "X"), text_edit(0, 0, "I")], "IXbc"),
            (vec![text_edit(1, 1, "I"), text_edit(0, 1, "X")], "XIbc"),
        ];
        for (edits, expected) in cases {
            assert_eq!(apply_text_edits("abc", &edits).unwrap(), expected);
        }
        for edits in [
            vec![text_edit(0, 2, "X"), text_edit(1, 3, "Y")],
            vec![text_edit(0, 2, "X"), text_edit(1, 1, "I")],
            vec![text_edit(0, 2, "X"), text_edit(0, 2, "Y")],
            vec![text_edit(2, 1, "X")],
        ] {
            assert!(apply_text_edits("abc", &edits).is_err());
        }
    }

    #[test]
    fn snippets_and_unknown_or_mismatched_versions_are_rejected() {
        let snippet =
            json!({"documentChanges":[{"edits":[{"newText":"${1:name}","insertTextFormat":2}]}]});
        assert!(reject_workspace_edit_snippets(&snippet).is_err());
        assert!(
            reject_workspace_edit_snippets(
                &json!({"changes":{"file:///a":[{"newText":"$not_a_snippet"}]}})
            )
            .is_ok()
        );
        let uri = path_to_uri(Path::new("/a b.fixture")).unwrap();
        let mut versions = HashMap::new();
        assert!(check_version(&versions, &uri, Some(1)).is_err());
        assert!(check_version(&versions, &uri, None).is_ok());
        versions.insert(uri.as_str().to_owned(), 3);
        assert!(check_version(&versions, &uri, Some(2)).is_err());
        assert!(check_version(&versions, &uri, Some(3)).is_ok());
        assert!(uri.as_str().contains("%20"));
        assert_eq!(file_uri_path(&uri).unwrap(), Path::new("/a b.fixture"));
        assert!(file_uri_path(&"https://example.test/a".parse().unwrap()).is_err());
    }

    #[test]
    fn ranked_rename_merge_keeps_first_nonoverlap_and_reports_conflicts() {
        let uri = path_to_uri(Path::new("/a.fixture")).unwrap();
        let high = WorkspaceEdit {
            changes: Some(HashMap::from([(uri.clone(), vec![text_edit(0, 3, "X")])])),
            ..WorkspaceEdit::default()
        };
        let low = WorkspaceEdit {
            changes: Some(HashMap::from([(
                uri,
                vec![
                    text_edit(0, 3, "Y"),
                    text_edit(3, 4, "!"),
                    text_edit(0, 0, "I"),
                    text_edit(0, 3, "X"),
                ],
            )])),
            ..WorkspaceEdit::default()
        };
        let (merged, discarded) = merge_workspace_edits(&[high, low]).unwrap();
        assert_eq!(discarded, 1);
        let Some(DocumentChanges::Operations(operations)) = merged.document_changes else {
            panic!("expected operations");
        };
        let edits: Vec<_> = operations
            .into_iter()
            .flat_map(|operation| match operation {
                DocumentChangeOperation::Edit(document) => document
                    .edits
                    .into_iter()
                    .map(|edit| match edit {
                        OneOf::Left(edit) => edit,
                        OneOf::Right(edit) => edit.text_edit,
                    })
                    .collect(),
                _ => Vec::new(),
            })
            .collect();
        assert_eq!(apply_text_edits("abcd", &edits).unwrap(), "IX!");
    }

    struct EditTool;
    impl From<EditTool> for Action {
        fn from(_: EditTool) -> Self {
            Self::Edit
        }
    }
    impl From<&EditTool> for Action {
        fn from(_: &EditTool) -> Self {
            Self::Edit
        }
    }
    impl MarshTool for EditTool {
        fn description(&self) -> Cow<'_, str> {
            Cow::Borrowed("workspace edit transaction test")
        }
    }

    async fn fixture() -> (tempfile::TempDir, PathBuf, ManagedSession) {
        let temporary = tempfile::tempdir().unwrap();
        let seed = temporary.path().join("seed");
        std::fs::create_dir(&seed).unwrap();
        std::fs::write(seed.join("a.fixture"), "a😀b\r\n").unwrap();
        std::fs::create_dir(seed.join("directory")).unwrap();
        std::fs::write(seed.join("directory/child.fixture"), "child").unwrap();
        let backend = Arc::new(marsh_btrfs::fake::CopyTree::new());
        backend.register(&seed);
        let session = marsh_core::test_support::shell_builder(backend)
            .working_dir(seed.clone())
            .build_managed_session()
            .await
            .unwrap();
        (temporary, seed, session)
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relocated_symlink_text_uses_each_virtual_target_and_discards_failed_prefix() {
        let (_temporary, seed, mut session) = fixture().await;
        std::fs::create_dir(seed.join("old")).unwrap();
        std::fs::create_dir(seed.join("new")).unwrap();
        std::fs::write(seed.join("old/target"), "abc").unwrap();
        std::fs::write(seed.join("new/target"), "longer").unwrap();
        std::os::unix::fs::symlink("target", seed.join("old/link")).unwrap();
        let uri = |name| path_to_uri(&seed.join(name)).unwrap().as_str().to_owned();
        let document = |name, start, end, text| {
            json!({
                "textDocument":{"uri":uri(name),"version":null},
                "edits":[{"range":{"start":{"line":0,"character":start},
                    "end":{"line":0,"character":end}},"newText":text}]
            })
        };
        // Final edits share the original six-unit target; insertion touches the replacement end.
        let edit: WorkspaceEdit = serde_json::from_value(json!({"documentChanges":[
            document("old/link", 0, 1, "A"),
            {"kind":"rename","oldUri":uri("old/link"),"newUri":uri("new/link")},
            document("new/link", 0, 6, "new"),
            document("new/link", 6, 6, "!")
        ]}))
        .unwrap();
        let preview = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                apply_workspace_edit(epoch, &edit, &HashMap::new(), false)
            })
            .await
            .unwrap();
        assert_eq!(preview.value.text_edits, 3);
        assert!(!preview.workspace_mutated);
        let failed = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                apply_workspace_edit(epoch, &edit, &HashMap::new(), true)?;
                epoch
                    .rename(Path::new("missing"), Path::new("destination"))
                    .map_err(|error| at(Path::new("missing"), error))
            })
            .await;
        assert!(matches!(failed, Err(ManagedError::Operation(_))));
        assert_eq!(
            std::fs::read_to_string(seed.join("old/target")).unwrap(),
            "abc"
        );
        assert_eq!(
            std::fs::read_to_string(seed.join("new/target")).unwrap(),
            "longer"
        );
        assert_eq!(
            std::fs::read_link(seed.join("old/link")).unwrap(),
            Path::new("target")
        );
        let applied = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                apply_workspace_edit(epoch, &edit, &HashMap::new(), true)
            })
            .await
            .unwrap();
        assert!(applied.workspace_mutated);
        assert_eq!(applied.value.text_edits, preview.value.text_edits);
        assert_eq!(
            std::fs::read_to_string(seed.join("old/target")).unwrap(),
            "Abc"
        );
        assert_eq!(
            std::fs::read_to_string(seed.join("new/target")).unwrap(),
            "new!"
        );
        assert_eq!(
            std::fs::read_link(seed.join("new/link")).unwrap(),
            Path::new("target")
        );
        assert!(!seed.join("old/link").exists());
        session.close().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ranked_resource_claims_keep_winning_order_and_apply_without_conflicts() {
        let (_temporary, seed, mut session) = fixture().await;
        let uri = |name| path_to_uri(&seed.join(name)).unwrap().as_str().to_owned();
        let document = |name, text| {
            json!({
                "textDocument":{"uri":uri(name),"version":null},
                "edits":[{"range":{"start":{"line":0,"character":0},
                    "end":{"line":0,"character":0}},"newText":text}]
            })
        };
        let high: WorkspaceEdit = serde_json::from_value(json!({"documentChanges":[
            {"kind":"create","uri":uri("created")},
            document("created", "winner"),
            {"kind":"rename","oldUri":uri("created"),"newUri":uri("moved")},
            document("moved", "!"),
            {"kind":"delete","uri":uri("directory"),"options":{"recursive":true}},
            document("a.fixture", "high")
        ]}))
        .unwrap();
        let low: WorkspaceEdit = serde_json::from_value(json!({"documentChanges":[
            {"kind":"create","uri":uri("created")},
            document("created", "loser"),
            document("directory/child.fixture", "loser"),
            {"kind":"delete","uri":uri("a.fixture")},
            {"kind":"rename","oldUri":uri("moved"),"newUri":uri("stolen")},
            {"kind":"create","uri":uri("independent")},
            document("independent", "retained")
        ]}))
        .unwrap();
        let (merged, discarded) = merge_workspace_edits(&[high, low]).unwrap();
        assert_eq!(discarded, 5);
        let preview = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                apply_workspace_edit(epoch, &merged, &HashMap::new(), false)
            })
            .await
            .unwrap();
        assert!(!preview.workspace_mutated);
        let applied = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                apply_workspace_edit(epoch, &merged, &HashMap::new(), true)
            })
            .await
            .unwrap();
        assert_eq!(
            applied.value.resource_operations,
            preview.value.resource_operations
        );
        assert_eq!(
            std::fs::read_to_string(seed.join("moved")).unwrap(),
            "!winner"
        );
        assert_eq!(
            std::fs::read_to_string(seed.join("independent")).unwrap(),
            "retained"
        );
        assert_eq!(
            std::fs::read_to_string(seed.join("a.fixture")).unwrap(),
            "higha😀b\r\n"
        );
        assert!(!seed.join("created").exists());
        assert!(!seed.join("directory").exists());
        assert!(!seed.join("stolen").exists());
        session.close().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tracked_preview_and_ordered_create_text_rename_delete_publish_only_on_apply() {
        let (_temporary, seed, mut session) = fixture().await;
        let new = path_to_uri(&seed.join("new/nested.fixture")).unwrap();
        let moved = path_to_uri(&seed.join("moved.fixture")).unwrap();
        let directory = path_to_uri(&seed.join("directory")).unwrap();
        let edit: WorkspaceEdit = serde_json::from_value(json!({
            "changes": {"file:///ignored": [{"range":{"start":{"line":999,"character":0},"end":{"line":999,"character":0}},"newText":"ignored"}]},
            "documentChanges": [
                {"kind":"create","uri":new.as_str()},
                {"textDocument":{"uri":new.as_str(),"version":null},"edits":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},"newText":"hello"}]},
                {"kind":"rename","oldUri":new.as_str(),"newUri":moved.as_str()},
                {"textDocument":{"uri":moved.as_str(),"version":null},"edits":[{"range":{"start":{"line":0,"character":5},"end":{"line":0,"character":5}},"newText":"!"}]},
                {"kind":"delete","uri":directory.as_str(),"options":{"recursive":true}}
            ]
        })).unwrap();
        let preview = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                apply_workspace_edit(epoch, &edit, &HashMap::new(), false)
            })
            .await
            .unwrap();
        assert!(!preview.workspace_mutated);
        assert_eq!(preview.value.text_edits, 2);
        assert_eq!(preview.value.resource_operations, 3);
        assert_eq!(preview.value.created.len(), 1);
        assert!(!seed.join("new").exists());
        assert!(seed.join("directory/child.fixture").exists());
        let applied = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                apply_workspace_edit(epoch, &edit, &HashMap::new(), true)
            })
            .await
            .unwrap();
        assert!(applied.workspace_mutated);
        assert_eq!(
            std::fs::read_to_string(seed.join("moved.fixture")).unwrap(),
            "hello!"
        );
        assert!(!seed.join("directory").exists());
        assert!(!seed.join("new/nested.fixture").exists());
        session.close().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tracked_version_rejection_and_later_operation_failure_discard_every_prefix() {
        let (_temporary, seed, mut session) = fixture().await;
        let uri = path_to_uri(&seed.join("a.fixture")).unwrap();
        let document = |version: Value| json!({"textDocument":{"uri":uri.as_str(),"version":version},"edits":[{"range":{"start":{"line":0,"character":1},"end":{"line":0,"character":3}},"newText":"X"}]});
        let mismatch: WorkspaceEdit =
            serde_json::from_value(json!({"documentChanges":[document(json!(2))]})).unwrap();
        let result = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                let physical = path_to_uri(&uri_to_path(epoch, &uri)?)?;
                apply_workspace_edit(
                    epoch,
                    &mismatch,
                    &HashMap::from([(physical.as_str().to_owned(), 1)]),
                    true,
                )
            })
            .await;
        assert!(matches!(result, Err(ManagedError::Operation(_))));
        assert_eq!(
            std::fs::read_to_string(seed.join("a.fixture")).unwrap(),
            "a😀b\r\n"
        );
        let edit: WorkspaceEdit =
            serde_json::from_value(json!({"documentChanges":[document(Value::Null)]})).unwrap();
        let result = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                apply_workspace_edit(epoch, &edit, &HashMap::new(), true)?;
                // A real later resource error must not publish the already-executed edit.
                epoch
                    .rename(Path::new("absent.fixture"), Path::new("dest.fixture"))
                    .map_err(|error| at(Path::new("absent.fixture"), error))?;
                Ok::<_, EditError>(())
            })
            .await;
        assert!(matches!(result, Err(ManagedError::Operation(_))));
        assert_eq!(
            std::fs::read_to_string(seed.join("a.fixture")).unwrap(),
            "a😀b\r\n"
        );
        session.close().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tracked_ignore_overwrite_directory_move_and_failed_destination_restore() {
        let (_temporary, seed, mut session) = fixture().await;
        std::fs::write(seed.join("target.fixture"), "target").unwrap();
        let uri = |name| path_to_uri(&seed.join(name)).unwrap().as_str().to_owned();
        let edit: WorkspaceEdit = serde_json::from_value(json!({"documentChanges":[
            {"kind":"create","uri":uri("a.fixture"),"options":{"ignoreIfExists":true}},
            {"kind":"rename","oldUri":uri("a.fixture"),"newUri":uri("target.fixture"),"options":{"ignoreIfExists":true}},
            {"kind":"delete","uri":uri("missing.fixture"),"options":{"ignoreIfNotExists":true}},
            {"kind":"create","uri":uri("target.fixture"),"options":{"overwrite":true,"ignoreIfExists":true}},
            {"kind":"rename","oldUri":uri("directory"),"newUri":uri("target.fixture"),"options":{"overwrite":true}},
            {"textDocument":{"uri":uri("target.fixture/child.fixture"),"version":null},"edits":[{"range":{"start":{"line":0,"character":5},"end":{"line":0,"character":5}},"newText":"!"}]}
        ]})).unwrap();
        let outcome = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                let summary = apply_workspace_edit(epoch, &edit, &HashMap::new(), true)?;
                assert_eq!(summary.resource_operations, 2);
                assert!(
                    summary.created.is_empty(),
                    "ignores and overwrites do not create a new path"
                );
                Ok::<_, EditError>(summary)
            })
            .await
            .unwrap();
        assert!(outcome.workspace_mutated);
        assert_eq!(
            std::fs::read_to_string(seed.join("a.fixture")).unwrap(),
            "a😀b\r\n"
        );
        assert_eq!(
            std::fs::read_to_string(seed.join("target.fixture/child.fixture")).unwrap(),
            "child!"
        );
        assert!(!seed.join("directory").exists());
        session.retire().await.unwrap();
        let failed = session
            .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                let from = epoch.physical_path(Path::new("missing.fixture"))?;
                let to = epoch.physical_path(Path::new("a.fixture"))?;
                let error = rename_restoring_destination(epoch, &from, &to, true).unwrap_err();
                assert_eq!(
                    epoch.read_to_string(&to).map_err(|error| at(&to, error))?,
                    "a😀b\r\n"
                );
                Err::<(), EditError>(error)
            })
            .await;
        assert!(matches!(failed, Err(ManagedError::Operation(_))));
        assert_eq!(
            std::fs::read_to_string(seed.join("a.fixture")).unwrap(),
            "a😀b\r\n"
        );
        session.close().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_resource_preflight_failure_and_invalid_text_batch_leaves_source_unchanged() {
        let (_temporary, seed, mut session) = fixture().await;
        let uri = |name| path_to_uri(&seed.join(name)).unwrap().as_str().to_owned();
        let edit_a = json!({"textDocument":{"uri":uri("a.fixture"),"version":null},"edits":[{"range":{"start":{"line":0,"character":1},"end":{"line":0,"character":3}},"newText":"X"}]});
        let failures = [
            json!({"kind":"create","uri":uri("a.fixture")}),
            json!({"kind":"rename","oldUri":uri("absent.fixture"),"newUri":uri("destination.fixture")}),
            json!({"kind":"delete","uri":uri("directory")}),
            json!({"textDocument":{"uri":uri("directory/child.fixture"),"version":null},"edits":[{"range":{"start":{"line":0,"character":100},"end":{"line":0,"character":100}},"newText":"bad"}]}),
        ];
        for failure in failures {
            let edit: WorkspaceEdit =
                serde_json::from_value(json!({"documentChanges":[edit_a.clone(),failure]}))
                    .unwrap();
            for apply in [false, true] {
                let result = session
                    .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                        apply_workspace_edit(epoch, &edit, &HashMap::new(), apply)
                    })
                    .await;
                assert!(matches!(result, Err(ManagedError::Operation(_))));
                assert_eq!(
                    std::fs::read_to_string(seed.join("a.fixture")).unwrap(),
                    "a😀b\r\n"
                );
                assert_eq!(
                    std::fs::read_to_string(seed.join("directory/child.fixture")).unwrap(),
                    "child"
                );
                assert!(!seed.join("destination.fixture").exists());
            }
        }
        session.close().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn preview_does_not_resurrect_children_of_deleted_then_recreated_directories() {
        let (_temporary, seed, mut session) = fixture().await;
        let uri = |name| path_to_uri(&seed.join(name)).unwrap().as_str().to_owned();
        let edit: WorkspaceEdit = serde_json::from_value(json!({"documentChanges":[
            {"kind":"delete","uri":uri("directory"),"options":{"recursive":true}},
            {"kind":"create","uri":uri("directory/new.fixture")},
            {"textDocument":{"uri":uri("directory/child.fixture"),"version":null},"edits":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},"newText":"must fail"}]}
        ]})).unwrap();
        for apply in [false, true] {
            let result = session
                .epoch(EditTool, &ManagedCancellation::default(), async |epoch| {
                    apply_workspace_edit(epoch, &edit, &HashMap::new(), apply)
                })
                .await;
            assert!(matches!(result, Err(ManagedError::Operation(_))));
            assert_eq!(
                std::fs::read_to_string(seed.join("directory/child.fixture")).unwrap(),
                "child"
            );
            assert!(!seed.join("directory/new.fixture").exists());
        }
        session.close().await.unwrap();
    }
}
