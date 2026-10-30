//! Native action compatibility adapted from OMP 18.13.3 (see ../LICENSE-OMP).
use crate::{
    LspAction as A, LspError, LspInput, LspOptions, LspResult,
    client::{self, Runtime},
    config::{self, ServerConfig},
    edits::{self, EditSummary},
};
use futures_util::{StreamExt, stream};
use lsp_types::{
    Diagnostic, DiagnosticSeverity, Position, Range, Uri, WorkspaceEdit,
    notification::{self},
    request,
};
use marsh_core::ManagedEpoch;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    time::Instant,
};

pub(crate) fn validate(input: &LspInput, options: LspOptions) -> Result<(), LspError> {
    if options.read_only
        && matches!(
            input.action,
            A::Rename | A::RenameFile | A::CodeActions | A::Reload | A::Request
        )
    {
        return Err(LspError::Tool(format!(
            "{} is unavailable in read-only mode",
            input.action
        )));
    }
    if input
        .timeout
        .is_some_and(|n| !n.is_finite() || !(5.0..=300.0).contains(&n))
    {
        return Err(LspResult::failure(
            input,
            "timeout must be between 5 and 300 seconds",
        ));
    }
    if input
        .line
        .is_some_and(|n| !n.is_finite() || n < 1.0 || n.fract() != 0.0 || n > f64::from(u32::MAX))
    {
        return Err(LspResult::failure(
            input,
            "line must be a positive whole number",
        ));
    }
    match input.action {
        A::Diagnostics
        | A::Definition
        | A::References
        | A::Hover
        | A::Symbols
        | A::Rename
        | A::RenameFile
        | A::CodeActions
        | A::TypeDefinition
        | A::Implementation
            if input.file.as_deref().is_none_or(str::is_empty) =>
        {
            return Err(LspResult::failure(input, "file is required"));
        }
        _ => {}
    }
    if matches!(
        input.action,
        A::Definition
            | A::References
            | A::Hover
            | A::Rename
            | A::RenameFile
            | A::CodeActions
            | A::TypeDefinition
            | A::Implementation
    ) && input.file.as_deref() == Some("*")
    {
        return Err(LspResult::failure(input, "a concrete file is required"));
    }
    if matches!(input.action, A::Rename | A::RenameFile)
        && input.new_name.as_deref().is_none_or(str::is_empty)
    {
        return Err(LspResult::failure(input, "new_name is required"));
    }
    if (input.action == A::Symbols && input.file.as_deref() == Some("*")
        || input.action == A::Request)
        && input.query.as_deref().is_none_or(|s| s.trim().is_empty())
    {
        return Err(LspResult::failure(
            input,
            if input.action == A::Request {
                "request method is required in query"
            } else {
                "workspace symbols require a nonempty query"
            },
        ));
    }
    if input.action == A::Request
        && let Some(payload) = &input.payload
    {
        serde_json::from_str::<Value>(payload)
            .map_err(|e| LspResult::failure(input, format!("invalid JSON payload: {e}")))?;
    }
    Ok(())
}

pub(crate) async fn execute(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    input: &LspInput,
    deadline: Instant,
    wait: Duration,
) -> Result<LspResult, LspError> {
    let result = execute_inner(runtime, epoch, input, deadline, wait).await;
    result.map_err(|error| match error {
        LspError::Tool(text) => LspResult::failure(input, text),
        error => error,
    })
}
async fn execute_inner(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    input: &LspInput,
    deadline: Instant,
    wait: Duration,
) -> Result<LspResult, LspError> {
    match input.action {
        A::Status => return status(runtime, input),
        A::Diagnostics => return diagnostics(runtime, epoch, input, deadline, wait).await,
        A::Symbols if input.file.as_deref() == Some("*") => {
            return workspace_symbols(runtime, epoch, input, deadline, wait).await;
        }
        A::Reload => return reload(runtime, epoch, input, deadline, wait).await,
        A::Capabilities => return capabilities(runtime, epoch, input, deadline).await,
        A::RenameFile => return rename_file(runtime, epoch, input, deadline, wait).await,
        _ => {}
    }
    let path = input
        .file
        .as_deref()
        .filter(|s| *s != "*")
        .map(|file| input_path(epoch, file))
        .transpose()?;
    let server = runtime
        .selected(path.as_deref(), true)
        .into_iter()
        .next()
        .ok_or_else(|| LspResult::failure(input, "no matching language server is configured"))?;
    if server.project_aware()
        && input.line.is_some()
        && matches!(input.action, A::Definition | A::References | A::Rename)
        && input.symbol.as_deref().is_none_or(|s| s.is_empty())
    {
        return Err(LspResult::failure(
            input,
            "symbol is required with an explicit line for this project-aware action",
        ));
    }
    // Validate positions from tracked disk bytes before initialization can initiate edits.
    let pre_position = if input.line.is_some()
        || matches!(
            input.action,
            A::Definition
                | A::TypeDefinition
                | A::Implementation
                | A::References
                | A::Hover
                | A::Rename
                | A::CodeActions
        ) {
        path.as_deref()
            .map(|path| {
                epoch
                    .read_to_string(path)
                    .map_err(LspError::from)
                    .and_then(|text| {
                        position(&text, input.line, input.symbol.as_deref()).map_err(LspError::Tool)
                    })
            })
            .transpose()?
    } else {
        None
    };
    let index = runtime.ensure(epoch, server.clone(), deadline).await?;
    let name = Some(server.name.clone());
    if input.action == A::Rename {
        runtime.reconcile_all(epoch).await?;
    }
    let (uri, content) = if let Some(path) = &path {
        runtime.document(epoch, index, path, false).await?
    } else {
        (String::new(), String::new())
    };
    if server.project_aware() && input.action != A::Request {
        runtime.project_ready(epoch, index, deadline, wait).await?;
    }
    let pos = if pre_position.is_some() {
        position(&content, input.line, input.symbol.as_deref()).map_err(LspError::Tool)?
    } else {
        Position::new(0, 0)
    };
    let params = json!({"textDocument":{"uri":uri},"position":pos});
    match input.action {
        A::Definition | A::TypeDefinition | A::Implementation => {
            let response = match input.action {
                A::Definition => {
                    runtime
                        .call::<request::GotoDefinition>(epoch, index, params, deadline)
                        .await?
                }
                A::TypeDefinition => {
                    runtime
                        .call::<request::GotoTypeDefinition>(epoch, index, params, deadline)
                        .await?
                }
                _ => {
                    runtime
                        .call::<request::GotoImplementation>(epoch, index, params, deadline)
                        .await?
                }
            };
            let locations = locations(response)?;
            let mut result = LspResult::new(
                input,
                render_locations(epoch, &locations, usize::MAX)?,
                name,
            );
            if locations.is_empty() {
                result.text = "No locations found".into();
                result.useless = Some(true);
            }
            Ok(result)
        }
        A::References => {
            let mut params = params;
            params["context"] = json!({"includeDeclaration":true});
            let mut found = Vec::new();
            for attempt in 0..3 {
                found = locations(
                    runtime
                        .call::<request::References>(epoch, index, params.clone(), deadline)
                        .await?,
                )?;
                let declaration_only =
                    found.len() == 1 && found[0].0 == uri && found[0].1.start.line == pos.line;
                if !server.project_aware()
                    || (!found.is_empty() && !declaration_only)
                    || attempt == 2
                {
                    break;
                }
                runtime.project_ready(epoch, index, deadline, wait).await?;
                runtime
                    .pause(epoch, Duration::from_millis(250), deadline)
                    .await?;
            }
            let text = if found.is_empty() {
                "No references found".into()
            } else {
                format!(
                    "Found {} references:\n{}",
                    found.len(),
                    render_locations(epoch, &found, 50)?
                )
            };
            let mut result = LspResult::new(input, text, name);
            if found.is_empty() {
                result.useless = Some(true);
            }
            Ok(result)
        }
        A::Hover => {
            let response = runtime
                .call::<request::HoverRequest>(epoch, index, params, deadline)
                .await?;
            let text = hover(response.get("contents").unwrap_or(&Value::Null));
            Ok(LspResult::new(
                input,
                if text.trim().is_empty() {
                    "No hover information".into()
                } else {
                    text
                },
                name,
            ))
        }
        A::Symbols => {
            let response = runtime
                .call::<request::DocumentSymbolRequest>(
                    epoch,
                    index,
                    json!({"textDocument":{"uri":uri}}),
                    deadline,
                )
                .await?;
            let mut lines = Vec::new();
            render_symbols(&response, 0, &mut lines);
            let mut result = LspResult::new(
                input,
                format!(
                    "Symbols in {}:\n{}",
                    input.file.as_deref().unwrap_or(""),
                    if lines.is_empty() {
                        "No symbols found".into()
                    } else {
                        lines.join("\n")
                    }
                ),
                name,
            );
            if lines.is_empty() {
                result.useless = Some(true);
            }
            Ok(result)
        }
        A::Rename => {
            let response = runtime
                .call::<request::Rename>(
                    epoch,
                    index,
                    json!({"textDocument":{"uri":uri},"position":pos,"newName":input.new_name}),
                    deadline,
                )
                .await?;
            if response.is_null() {
                return Ok(LspResult::new(input, "No edits required", name));
            }
            let edit = parse_edit(response)?;
            let apply = input.apply != Some(false);
            let summary = runtime.apply(epoch, &edit, apply, Some(index)).await?;
            let text = if apply {
                format!("Applied rename:\n{}", edit_description(&summary, true))
            } else {
                format!(
                    "Rename preview:\n{}\n{}",
                    edit_description(&summary, false),
                    serde_json::to_string_pretty(&edit)?
                )
            };
            Ok(LspResult::new(input, text, name))
        }
        A::CodeActions => code_actions(runtime, epoch, input, index, &uri, pos, deadline).await,
        A::Request => {
            let mut payload = if let Some(payload) = &input.payload {
                serde_json::from_str::<Value>(payload)?
            } else if path.is_some() {
                let mut params = json!({"textDocument":{"uri":uri}});
                if input.line.is_some() {
                    params["position"] = json!(pos);
                }
                params
            } else {
                json!({})
            };
            client::map_value(epoch, &mut payload, true);
            let method = input.query.as_deref().unwrap_or("").trim();
            let preview = truncate(&payload.to_string(), 400);
            let response = runtime
                .raw(epoch, index, method, payload, deadline)
                .await
                .map_err(|error| match error {
                    LspError::Tool(reason) => {
                        LspResult::failure(input, format!("{reason}\nParameters: {preview}"))
                    }
                    error => error,
                })?;
            let mut response = response;
            client::map_value(epoch, &mut response, false);
            Ok(LspResult::new(
                input,
                serde_json::to_string_pretty(&response)?,
                name,
            ))
        }
        _ => Err(LspError::Tool(format!(
            "unexpected dispatch for {}",
            input.action
        ))),
    }
}
fn status(runtime: &Runtime, input: &LspInput) -> Result<LspResult, LspError> {
    let mut lines = Vec::new();
    for config in runtime.servers() {
        let identity = config.identity();
        let state = if config.custom.is_some() {
            "custom diagnostic client".into()
        } else if let Some(client) = runtime
            .clients
            .iter()
            .find(|client| client.identity == identity)
        {
            format!("live (PID {})", client.child.id())
        } else if let Some((when, reason)) = runtime
            .failures
            .get(&identity)
            .filter(|(when, _)| when.elapsed() < Duration::from_secs(180))
        {
            let _ = when;
            format!("error: {reason}")
        } else {
            "not started".into()
        };
        lines.push(format!(
            "{}: {state} [{}]",
            config.name,
            config.file_types.join(", ")
        ));
    }
    Ok(LspResult::new(
        input,
        if lines.is_empty() {
            "No language servers configured".into()
        } else {
            lines.join("\n")
        },
        None,
    ))
}
fn input_path(epoch: &ManagedEpoch<'_>, file: &str) -> Result<PathBuf, LspError> {
    if file.starts_with("file:") {
        let uri = file
            .parse::<Uri>()
            .map_err(|e| LspError::Tool(e.to_string()))?;
        return Ok(edits::uri_to_path(epoch, &uri)?);
    }
    Ok(epoch.physical_path(&epoch.cwd().join(file))?)
}

pub(crate) fn position(
    content: &str,
    line: Option<f64>,
    symbol: Option<&str>,
) -> Result<Position, String> {
    let line = line.unwrap_or(1.0);
    if !line.is_finite() || line < 1.0 || line.fract() != 0.0 || line > f64::from(u32::MAX) {
        return Err("line must be a positive whole number".into());
    }
    let number = line as u32;
    let text = content
        .split('\n')
        .nth((number - 1) as usize)
        .ok_or_else(|| format!("line {number} is out of bounds"))?
        .trim_end_matches('\r');
    let offset = if let Some(spec) = symbol.filter(|s| !s.is_empty()) {
        let (needle, occurrence) = match spec.rsplit_once('#') {
            Some((name, n))
                if !name.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) =>
            {
                (
                    name,
                    n.parse::<usize>()
                        .map_err(|_| "symbol occurrence is too large")?
                        .max(1),
                )
            }
            _ => (spec, 1),
        };
        let identifier = needle
            .chars()
            .next()
            .is_some_and(|c| c == '_' || c == '$' || c.is_ascii_alphabetic())
            && needle.chars().all(identifier_char);
        let valid = |offset: usize, end: usize| {
            !identifier
                || !(text[..offset]
                    .chars()
                    .next_back()
                    .is_some_and(identifier_char)
                    || text[end..].chars().next().is_some_and(identifier_char))
        };
        let exact = text
            .match_indices(needle)
            .filter(|(offset, _)| valid(*offset, *offset + needle.len()))
            .map(|(offset, _)| offset)
            .collect::<Vec<_>>();
        let found = if exact.is_empty() {
            let pattern = regex::RegexBuilder::new(&regex::escape(needle))
                .case_insensitive(true)
                .build()
                .map_err(|e| e.to_string())?;
            pattern
                .find_iter(text)
                .filter(|m| valid(m.start(), m.end()))
                .map(|m| m.start())
                .collect()
        } else {
            exact
        };
        *found.get(occurrence - 1).ok_or_else(|| {
            format!("symbol {spec:?} not found at occurrence {occurrence} on line {number}")
        })?
    } else {
        text.char_indices()
            .find(|(_, c)| !c.is_whitespace())
            .map_or(0, |(index, _)| index)
    };
    let character =
        u32::try_from(text[..offset].encode_utf16().count()).map_err(|_| "line is too long")?;
    Ok(Position::new(number - 1, character))
}
fn identifier_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}
fn hover(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(values) => values
            .iter()
            .map(hover)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        Value::Object(value) => {
            let text = value.get("value").and_then(Value::as_str).unwrap_or("");
            if let Some(language) = value.get("language").and_then(Value::as_str) {
                format!("```{language}\n{text}\n```")
            } else {
                text.into()
            }
        }
        _ => value.to_string(),
    }
}
fn locations(value: Value) -> Result<Vec<(String, Range)>, LspError> {
    let values = match value {
        Value::Null => Vec::new(),
        Value::Array(values) => values,
        value => vec![value],
    };
    values
        .into_iter()
        .map(|value| {
            let uri = value
                .get("uri")
                .or_else(|| value.get("targetUri"))
                .and_then(Value::as_str)
                .ok_or_else(|| LspError::Transport("location lacks a URI".into()))?
                .to_owned();
            let range = value
                .get("range")
                .or_else(|| value.get("targetSelectionRange"))
                .cloned()
                .ok_or_else(|| LspError::Transport("location lacks a range".into()))?;
            Ok((uri, serde_json::from_value(range)?))
        })
        .collect()
}
fn render_locations(
    epoch: &ManagedEpoch<'_>,
    locations: &[(String, Range)],
    context_limit: usize,
) -> Result<String, LspError> {
    let mut lines = Vec::new();
    for (index, (uri, range)) in locations.iter().enumerate() {
        let uri = uri
            .parse::<Uri>()
            .map_err(|e| LspError::Transport(e.to_string()))?;
        if url::Url::parse(uri.as_str())
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .is_none()
        {
            lines.push(format!(
                "{}:{}:{}",
                uri.as_str(),
                u64::from(range.start.line) + 1,
                u64::from(range.start.character) + 1
            ));
            continue;
        }
        let path = edits::uri_to_path(epoch, &uri)?;
        let logical = epoch.logical_path(&path)?;
        lines.push(format!(
            "{}:{}:{}",
            logical.display(),
            u64::from(range.start.line) + 1,
            u64::from(range.start.character) + 1
        ));
        if index < context_limit {
            match epoch.read_to_string(&path) {
                Ok(content) => {
                    let start = range.start.line.saturating_sub(1) as usize;
                    let count = if range.start.line == 0 { 2 } else { 3 };
                    for (number, text) in content.split('\n').enumerate().skip(start).take(count) {
                        lines.push(format!(
                            "  {} | {}",
                            number + 1,
                            text.trim_end_matches('\r')
                        ));
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::InvalidData
                            | std::io::ErrorKind::InvalidInput
                            | std::io::ErrorKind::IsADirectory
                    ) => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(lines.join("\n"))
}
fn render_symbols(value: &Value, depth: usize, lines: &mut Vec<String>) {
    if let Some(symbols) = value.as_array() {
        for symbol in symbols {
            let name = symbol.get("name").and_then(Value::as_str).unwrap_or("?");
            let range = symbol
                .get("selectionRange")
                .or_else(|| symbol.get("range"))
                .or_else(|| symbol.pointer("/location/range"));
            let line = range
                .and_then(|r| r.pointer("/start/line"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1;
            let detail = symbol.get("detail").and_then(Value::as_str).unwrap_or("");
            let location = symbol
                .pointer("/location/uri")
                .and_then(Value::as_str)
                .map(|uri| format!(" {uri}:{line}"))
                .unwrap_or_else(|| format!(" @ line {line}"));
            lines.push(format!(
                "{}{} {}{}",
                "  ".repeat(depth),
                name,
                detail,
                location
            ));
            if let Some(children) = symbol.get("children") {
                render_symbols(children, depth + 1, lines);
            }
        }
    }
}
fn parse_edit(value: Value) -> Result<WorkspaceEdit, LspError> {
    edits::reject_workspace_edit_snippets(&value)?;
    Ok(serde_json::from_value(value)?)
}
fn edit_description(summary: &EditSummary, apply: bool) -> String {
    format!(
        "{} {} text edits and {} resource operations across {} files",
        if apply { "Applied" } else { "Preview:" },
        summary.text_edits,
        summary.resource_operations,
        summary.changed.len() + summary.deleted.len() + summary.renamed.len()
    )
}
fn truncate(text: &str, count: usize) -> String {
    let end = text
        .char_indices()
        .nth(count)
        .map_or(text.len(), |(i, _)| i);
    if end == text.len() {
        text.into()
    } else {
        format!("{}…", &text[..end])
    }
}

async fn code_actions(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    input: &LspInput,
    index: usize,
    uri: &str,
    pos: Position,
    deadline: Instant,
) -> Result<LspResult, LspError> {
    let mut context = json!({"diagnostics":runtime.clients[index].diagnostics.get(uri).map(|p|&p.diagnostics).cloned().unwrap_or_default()});
    if input.apply != Some(true)
        && let Some(kind) = input.query.as_deref().filter(|q| !q.is_empty())
    {
        context["only"] = json!([kind]);
    }
    let response = runtime
        .call::<request::CodeActionRequest>(
            epoch,
            index,
            json!({"textDocument":{"uri":uri},"range":{"start":pos,"end":pos},"context":context}),
            deadline,
        )
        .await?;
    let actions = response.as_array().cloned().unwrap_or_default();
    let name = Some(runtime.clients[index].config.name.clone());
    if actions.is_empty() {
        return Ok(LspResult::new(input, "No code actions available", name));
    }
    if input.apply != Some(true) || input.query.as_deref().is_none_or(|q| q.is_empty()) {
        let text = actions
            .iter()
            .enumerate()
            .map(|(i, a)| {
                format!(
                    "{i}: {}",
                    a.get("title").and_then(Value::as_str).unwrap_or("Untitled")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(LspResult::new(input, text, name));
    }
    let query = input.query.as_deref().unwrap_or("").trim();
    if query.is_empty() {
        return Ok(LspResult::new(
            input,
            "No code action selected: query is blank",
            name,
        ));
    }
    let selected = if query.bytes().all(|b| b.is_ascii_digit()) {
        query
            .parse::<usize>()
            .ok()
            .and_then(|i| actions.get(i))
            .cloned()
    } else {
        let query = query.to_lowercase();
        actions
            .iter()
            .find(|a| {
                a.get("title")
                    .and_then(Value::as_str)
                    .is_some_and(|title| title.to_lowercase().contains(&query))
            })
            .cloned()
    };
    let Some(mut action) = selected else {
        return Ok(LspResult::new(
            input,
            "No matching code action selected",
            name,
        ));
    };
    if action.get("disabled").is_some() {
        return Ok(LspResult::new(
            input,
            format!(
                "Code action unavailable: {}",
                action
                    .pointer("/disabled/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("disabled")
            ),
            name,
        ));
    }
    let direct = action.get("command").is_some_and(Value::is_string);
    if !direct && action.get("edit").is_none_or(Value::is_null) {
        match runtime
            .call::<request::CodeActionResolveRequest>(epoch, index, action.clone(), deadline)
            .await
        {
            Ok(resolved) => action = resolved,
            Err(LspError::Tool(_)) => {}
            Err(e) => return Err(e),
        }
    }
    let mut summary = String::new();
    if let Some(edit) = action.get("edit").filter(|e| !e.is_null()) {
        let edit = parse_edit(edit.clone())?;
        summary = edit_description(&runtime.apply(epoch, &edit, true, Some(index)).await?, true);
    }
    let command = if direct {
        Some(&action)
    } else {
        action.get("command").filter(|c| c.is_object())
    };
    if command.is_none() && summary.is_empty() {
        return Ok(LspResult::new(
            input,
            "Selected action has no workspace edit or command to apply",
            name,
        ));
    }
    if let Some(command) = command {
        runtime.call::<request::ExecuteCommand>(epoch,index,json!({"command":command.get("command"),"arguments":command.get("arguments").cloned().unwrap_or_else(||json!([]))}),deadline).await?;
    }
    Ok(LspResult::new(
        input,
        format!(
            "Applied code action: {}{}",
            action
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled"),
            if summary.is_empty() {
                String::new()
            } else {
                format!("\n{summary}")
            }
        ),
        name,
    ))
}

async fn workspace_symbols(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    input: &LspInput,
    deadline: Instant,
    wait: Duration,
) -> Result<LspResult, LspError> {
    let servers = runtime.selected(None, true);
    if servers.is_empty() {
        return Err(LspResult::failure(input, "no semantic servers configured"));
    }
    let query = input.query.as_deref().unwrap_or("");
    let mut found = Vec::new();
    let mut warnings = Vec::new();
    let mut responses = 0;
    for server in servers {
        let result = async {
            let index = runtime.ensure(epoch, server.clone(), deadline).await?;
            if server.project_aware() {
                runtime.project_ready(epoch, index, deadline, wait).await?;
            }
            runtime
                .call::<request::WorkspaceSymbolRequest>(
                    epoch,
                    index,
                    json!({"query":query}),
                    deadline,
                )
                .await
        }
        .await;
        match result {
            Ok(value) => {
                responses += 1;
                if let Some(symbols) = value.as_array() {
                    found.extend(
                        symbols
                            .iter()
                            .filter(|symbol| {
                                symbol
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .is_some_and(|name| {
                                        name.to_lowercase().contains(&query.to_lowercase())
                                    })
                            })
                            .cloned(),
                    );
                }
            }
            Err(error) => {
                if fatal(&error) {
                    return Err(error);
                }
                warnings.push(format!("{}: {error}", server.name));
            }
        }
    }
    if responses == 0 {
        return Err(LspResult::failure(
            input,
            format!(
                "All workspace symbol requests failed\n{}",
                warnings.join("\n")
            ),
        ));
    }
    let mut seen = HashSet::new();
    found.retain(|symbol| {
        seen.insert(format!(
            "{}:{}:{}",
            symbol.get("name").unwrap_or(&Value::Null),
            symbol.pointer("/location/uri").unwrap_or(&Value::Null),
            symbol.pointer("/location/range").unwrap_or(&Value::Null)
        ))
    });
    let total = found.len();
    found.truncate(200);
    let mut lines = Vec::new();
    render_symbols(&Value::Array(found), 0, &mut lines);
    if total > 200 {
        lines.push(format!("Showing 200 of {total} symbols"));
    }
    lines.extend(warnings.into_iter().map(|w| format!("Warning: {w}")));
    let mut result = LspResult::new(
        input,
        if lines.is_empty() {
            "No symbols found".into()
        } else {
            lines.join("\n")
        },
        None,
    );
    if total == 0 {
        result.useless = Some(true);
    }
    Ok(result)
}
fn fatal(error: &LspError) -> bool {
    matches!(
        error,
        LspError::Transport(_) | LspError::Marsh(_) | LspError::Cancelled | LspError::Closed
    )
}

async fn capabilities(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    input: &LspInput,
    deadline: Instant,
) -> Result<LspResult, LspError> {
    let file = input
        .file
        .as_deref()
        .filter(|f| *f != "*")
        .map(|f| input_path(epoch, f))
        .transpose()?;
    let mut servers = runtime.selected(file.as_deref(), true);
    if file.is_some() {
        servers.truncate(1);
    }
    if servers.is_empty() {
        return Err(LspResult::failure(input, "no semantic servers configured"));
    }
    let mut lines = Vec::new();
    for server in servers {
        match runtime.ensure(epoch, server.clone(), deadline).await {
            Ok(index) => lines.push(format!(
                "{}:\n{}",
                server.name,
                serde_json::to_string_pretty(&runtime.clients[index].capabilities)?
            )),
            Err(error) => {
                if fatal(&error) {
                    return Err(error);
                }
                lines.push(format!("{}: {error}", server.name));
            }
        }
    }
    Ok(LspResult::new(input, lines.join("\n\n"), None))
}
async fn reload(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    input: &LspInput,
    deadline: Instant,
    wait: Duration,
) -> Result<LspResult, LspError> {
    let file = input
        .file
        .as_deref()
        .filter(|f| *f != "*")
        .map(|f| input_path(epoch, f))
        .transpose()?;
    if file.is_none() {
        runtime.load_config(epoch)?;
        let identities: HashSet<_> = runtime
            .servers()
            .iter()
            .map(ServerConfig::identity)
            .collect();
        let mut index = runtime.clients.len();
        while index > 0 {
            index -= 1;
            if !identities.contains(&runtime.clients[index].identity) {
                runtime.stop(epoch, index).await?;
            }
        }
        runtime.clear_failures(None);
    }
    let mut servers = runtime.selected(file.as_deref(), true);
    if file.is_some() {
        servers.truncate(1);
    }
    if servers.is_empty() {
        return Err(LspResult::failure(input, "no language servers to reload"));
    }
    let mut lines = Vec::new();
    for server in servers {
        runtime.clear_failures(Some(&server.identity()));
        let result = async {
            let mut index = runtime.ensure(epoch, server.clone(), deadline).await?;
            let delivery = async {
                let specialized = if runtime.clients[index].is_rust() {
                    match runtime
                        .raw(
                            epoch,
                            index,
                            "rust-analyzer/reloadWorkspace",
                            json!({}),
                            deadline,
                        )
                        .await
                    {
                        Ok(_) => true,
                        Err(LspError::Tool(_)) => false,
                        Err(error) => return Err(error),
                    }
                } else {
                    false
                };
                if !specialized {
                    runtime
                        .notify::<notification::DidChangeConfiguration>(
                            epoch,
                            index,
                            json!({"settings":runtime.clients[index].config.settings}),
                        )
                        .await?;
                    runtime.refresh_documents(epoch, index).await?;
                }
                Ok::<_, LspError>(())
            }
            .await;
            if delivery.is_err() {
                runtime.stop(epoch, index).await?;
                index = runtime.ensure(epoch, server.clone(), deadline).await?;
            }
            runtime.clients[index].rust_ready = false;
            if server.project_aware() {
                runtime.project_ready(epoch, index, deadline, wait).await?;
            }
            Ok::<_, LspError>(())
        }
        .await;
        match result {
            Ok(()) => lines.push(format!("{} reloaded", server.name)),
            Err(error) => {
                if fatal(&error) {
                    return Err(error);
                }
                lines.push(format!("{} failed: {error}", server.name));
            }
        }
    }
    Ok(LspResult::new(input, lines.join("\n"), None))
}

async fn rename_file(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    input: &LspInput,
    deadline: Instant,
    wait: Duration,
) -> Result<LspResult, LspError> {
    let source = input_path(epoch, input.file.as_deref().unwrap_or(""))?;
    let destination = input_path(epoch, input.new_name.as_deref().unwrap_or(""))?;
    if source == destination {
        return Err(LspResult::failure(
            input,
            "source and destination must differ",
        ));
    }
    let metadata = epoch.metadata(&source)?;
    match epoch.symlink_metadata(&destination) {
        Ok(_) => return Err(LspResult::failure(input, "destination already exists")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let mut files = Vec::new();
    if metadata.is_dir() {
        regular_descendants(epoch, &source, &mut files)?;
    } else if metadata.is_file() {
        files.push(source.clone());
    } else {
        return Err(LspResult::failure(
            input,
            "source must be a regular file or directory",
        ));
    }
    if files.is_empty() || files.len() > 1000 {
        return Err(LspResult::failure(
            input,
            "rename_file requires 1–1000 regular files",
        ));
    }
    runtime.reconcile_all(epoch).await?;
    let pairs = files
        .iter()
        .map(|from| {
            let to = if metadata.is_dir() {
                destination.join(
                    from.strip_prefix(&source)
                        .map_err(|e| LspError::Tool(e.to_string()))?,
                )
            } else {
                destination.clone()
            };
            Ok((from.clone(), to))
        })
        .collect::<Result<Vec<_>, LspError>>()?;
    let params = json!({"files":pairs.iter().map(|(from,to)|Ok(json!({"oldUri":edits::path_to_uri(from)?,"newUri":edits::path_to_uri(to)?}))).collect::<Result<Vec<_>,LspError>>()?});
    let mut servers: Vec<_> = runtime
        .selected(None, true)
        .into_iter()
        .filter(|s| files.iter().any(|file| s.matches(file)))
        .collect();
    servers.sort_by_key(|s| !s.project_aware());
    let mut edits = Vec::new();
    let mut warnings = Vec::new();
    let mut blockers = Vec::new();
    for server in servers {
        let result = async {
            let index = runtime.ensure(epoch, server.clone(), deadline).await?;
            if server.project_aware() {
                runtime.project_ready(epoch, index, deadline, wait).await?;
            }
            runtime
                .call::<request::WillRenameFiles>(epoch, index, params.clone(), deadline)
                .await
        }
        .await;
        match result {
            Ok(edit) if !edit.is_null() => edits.push(parse_edit(edit)?),
            Ok(_) => {}
            Err(LspError::Tool(reason)) if reason.contains("(-32601)") => {}
            Err(error) => {
                if fatal(&error) {
                    return Err(error);
                }
                blockers.push(format!("{}: {error}", server.name));
            }
        }
    }
    let (edit, discarded) = edits::merge_workspace_edits(&edits)?;
    if discarded > 0 {
        warnings.push(format!(
            "Discarded {discarded} overlapping lower-priority edits"
        ));
    }
    let apply = input.apply != Some(false);
    if apply && !blockers.is_empty() {
        return Err(LspResult::failure(
            input,
            format!("Rename blocked:\n{}", blockers.join("\n")),
        ));
    }
    let summary = runtime.apply(epoch, &edit, false, None).await?;
    if apply {
        runtime.apply(epoch, &edit, true, None).await?;
        if let Some(parent) = destination.parent() {
            epoch.create_dir_all(parent)?;
        }
        epoch.rename(&source, &destination)?;
        let moved = EditSummary {
            renamed: pairs,
            resource_operations: 1,
            ..EditSummary::default()
        };
        runtime.fanout(epoch, &moved).await?;
    }
    warnings.extend(
        blockers
            .into_iter()
            .map(|b| format!("Preview warning: {b}")),
    );
    Ok(LspResult::new(
        input,
        format!(
            "{} {} → {} ({} files)\n{}{}",
            if apply { "Renamed" } else { "Preview:" },
            input.file.as_deref().unwrap_or(""),
            input.new_name.as_deref().unwrap_or(""),
            files.len(),
            edit_description(&summary, apply),
            if warnings.is_empty() {
                String::new()
            } else {
                format!("\n{}", warnings.join("\n"))
            }
        ),
        None,
    ))
}
fn regular_descendants(
    epoch: &ManagedEpoch<'_>,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), LspError> {
    for entry in epoch.read_dir(directory)? {
        let path = epoch.physical_path(&entry?)?;
        let metadata = epoch.symlink_metadata(&path)?;
        if metadata.is_dir() {
            regular_descendants(epoch, &path, files)?;
        } else if metadata.is_file() {
            files.push(path);
        }
        if files.len() > 1000 {
            break;
        }
    }
    files.sort();
    Ok(())
}

async fn diagnostics(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    input: &LspInput,
    deadline: Instant,
    wait: Duration,
) -> Result<LspResult, LspError> {
    let file = input.file.as_deref().unwrap_or("");
    if file == "*" {
        return workspace_diagnostics(runtime, epoch, input, deadline).await;
    }
    let is_glob = file.bytes().any(|b| matches!(b, b'*' | b'?' | b'['));
    let mut files = if is_glob {
        let pattern = input_path(epoch, file)?;
        epoch
            .glob(&pattern.to_string_lossy())?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        vec![input_path(epoch, file)?]
    };
    if is_glob {
        let mut regular = Vec::with_capacity(files.len());
        for path in files {
            if epoch.metadata(&path)?.is_file() {
                regular.push(path);
            }
        }
        files = regular;
    }
    files.sort();
    let count = files.len();
    files.truncate(20);
    if files.is_empty() {
        return Ok(LspResult::new(input, "No files matched", None));
    }
    let mut lines = Vec::new();
    let mut total = 0;
    let mut errors = 0;
    let mut warnings = Vec::new();
    let mut attempted = 0;
    let mut successful = 0;
    for path in files {
        let servers = runtime.selected(Some(&path), false);
        if servers.is_empty() {
            lines.push(format!(
                "{}: no matching language server",
                epoch.logical_path(&path)?.display()
            ));
            continue;
        }
        let mut merged = Vec::new();
        for server in servers {
            attempted += 1;
            let result = if server.custom.is_some() {
                custom_diagnostics(runtime, epoch, &server, &path, deadline).await
            } else {
                async {
                    let index = runtime.ensure(epoch, server.clone(), deadline).await?;
                    runtime
                        .diagnostics(epoch, index, &path, deadline, wait)
                        .await
                }
                .await
            };
            match result {
                Ok(diagnostics) => {
                    successful += 1;
                    merged.extend(diagnostics);
                }
                Err(error) => {
                    if fatal(&error) {
                        return Err(error);
                    }
                    warnings.push(format!(
                        "{} ({}): {error}",
                        epoch.logical_path(&path)?.display(),
                        server.name
                    ));
                }
            }
        }
        client::sort_diagnostics(&mut merged);
        for diagnostic in merged {
            total += 1;
            let severity = match diagnostic.severity {
                Some(DiagnosticSeverity::ERROR) => {
                    errors += 1;
                    "error"
                }
                Some(DiagnosticSeverity::WARNING) => "warning",
                Some(DiagnosticSeverity::HINT) => "hint",
                _ => "info",
            };
            lines.push(format!(
                "{}:{}:{} {severity}: {}",
                epoch.logical_path(&path)?.display(),
                u64::from(diagnostic.range.start.line) + 1,
                u64::from(diagnostic.range.start.character) + 1,
                diagnostic.message
            ));
        }
    }
    if !is_glob && attempted > 0 && successful == 0 {
        return Err(LspResult::failure(
            input,
            format!("All diagnostic servers failed\n{}", warnings.join("\n")),
        ));
    }
    if count > 20 {
        warnings.push(format!("Glob matched {count} files; limited to 20"));
    }
    let mut text = format!("{total} diagnostics ({errors} errors)");
    if !lines.is_empty() {
        text.push('\n');
        text.push_str(&lines.join("\n"));
    }
    for warning in warnings {
        text.push_str("\nWarning: ");
        text.push_str(&warning);
    }
    Ok(LspResult::new(input, text, None))
}
async fn custom_diagnostics(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    server: &ServerConfig,
    path: &Path,
    deadline: Instant,
) -> Result<Vec<Diagnostic>, LspError> {
    let mut args = server.args.clone();
    args.push(path.to_string_lossy().into_owned());
    let process = run_process(epoch, &server.command, &args, None);
    tokio::pin!(process);
    let output = loop {
        tokio::select! {output=&mut process=>break output?,pump=runtime.pump_until(epoch,deadline)=>{if !pump?{return Err(LspError::Tool("linter timed out".into()));}}}
    };
    if !output.success && output.stdout.trim().is_empty() {
        return Err(LspError::Tool(format!(
            "{} failed: {}",
            server.name, output.stderr
        )));
    }
    let report: Value = serde_json::from_str(&output.stdout)
        .map_err(|e| LspError::Tool(format!("invalid {} diagnostics: {e}", server.name)))?;
    let entries = if server.custom.as_deref() == Some("biome") {
        report.get("diagnostics").and_then(Value::as_array)
    } else {
        report.as_array()
    }
    .ok_or_else(|| LspError::Tool(format!("invalid {} diagnostic report", server.name)))?;
    let mut result = Vec::new();
    for entry in entries {
        let biome = server.custom.as_deref() == Some("biome");
        let location = entry.get("location").unwrap_or(&Value::Null);
        let file = if biome {
            location.get("path")
        } else {
            entry.get("file")
        }
        .and_then(Value::as_str);
        if let Some(file) = file {
            if epoch.physical_path(&epoch.cwd().join(file))? != path {
                continue;
            }
        } else if biome {
            continue;
        }
        let number = |value: Option<&Value>| -> u32 {
            value
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n.saturating_sub(1)).ok())
                .unwrap_or(0)
        };
        let start = if biome {
            Position::new(
                number(location.pointer("/start/line")),
                number(location.pointer("/start/column")),
            )
        } else {
            Position::new(number(entry.get("line")), number(entry.get("character")))
        };
        let end = if biome && location.get("end").is_some() {
            Position::new(
                number(location.pointer("/end/line")),
                number(location.pointer("/end/column")),
            )
        } else {
            start
        };
        let severity = match entry
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or("warning")
            .to_ascii_lowercase()
            .as_str()
        {
            "error" | "fatal" => 1,
            "info" | "information" => 3,
            "hint" => 4,
            _ => 2,
        };
        let diagnostic = json!({"range":{"start":start,"end":end},"severity":severity,"message":entry.get(if biome{"message"}else{"reason"}).and_then(Value::as_str).unwrap_or("Unknown diagnostic"),"source":server.name,"code":entry.get(if biome{"category"}else{"rule_id"}).cloned().unwrap_or(Value::Null)});
        result.push(serde_json::from_value(diagnostic)?);
    }
    Ok(result)
}

struct ProcessOutput {
    success: bool,
    stdout: String,
    stderr: String,
}
async fn drain(
    reader: &mut (impl AsyncRead + Unpin),
    max_lines: Option<usize>,
) -> Result<Vec<u8>, LspError> {
    let mut output = Vec::new();
    let mut chunk = [0; 8192];
    let mut lines = 0;
    let mut truncated = false;
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let keep = if let Some(limit) = max_lines {
            if lines >= limit {
                0
            } else {
                chunk[..count]
                    .iter()
                    .enumerate()
                    .filter(|(_, byte)| **byte == b'\n')
                    .nth(limit - lines - 1)
                    .map_or(count, |(offset, _)| offset + 1)
            }
        } else {
            count
        };
        lines += chunk[..keep].iter().filter(|byte| **byte == b'\n').count();
        output.extend_from_slice(&chunk[..keep]);
        truncated |= keep < count;
    }
    if truncated && let Some(limit) = max_lines {
        std::io::Write::write_fmt(
            &mut output,
            format_args!("\n(output limited to {limit} lines)"),
        )?;
    }
    Ok(output)
}
async fn run_process(
    epoch: &ManagedEpoch<'_>,
    program: &Path,
    args: &[String],
    max_lines: Option<usize>,
) -> Result<ProcessOutput, LspError> {
    let program = match program.to_str() {
        Some(name) if program.components().count() == 1 => config::resolve_command(epoch, name)?
            .ok_or_else(|| {
                LspError::Tool(format!("executable not found: {}", program.display()))
            })?,
        _ => epoch.resolve_executable(program.as_os_str(), None)?,
    };
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(epoch.environment())
        .current_dir(epoch.physical_path(epoch.cwd())?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = epoch.spawn(
        format!("LSP checker {}", command.get_program().to_string_lossy()),
        command,
    )?;
    let mut io = child.io(epoch)?;
    let (stdout, stderr, status) = tokio::try_join!(
        drain(&mut io.stdout, max_lines),
        drain(&mut io.stderr, max_lines),
        async { Ok::<_, LspError>(child.wait(epoch).await?) }
    )?;
    Ok(ProcessOutput {
        success: status.success(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}
#[derive(Clone)]
struct Checker {
    label: &'static str,
    program: &'static str,
    args: Vec<String>,
    go_work: bool,
}
async fn workspace_diagnostics(
    runtime: &mut Runtime,
    epoch: &ManagedEpoch<'_>,
    input: &LspInput,
    deadline: Instant,
) -> Result<LspResult, LspError> {
    let exists = |path: &str| -> Result<bool, LspError> {
        match epoch.metadata(Path::new(path)) {
            Ok(m) => Ok(m.is_file()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    };
    let mut checkers = Vec::new();
    if exists("Cargo.toml")? {
        checkers.push(Checker {
            label: "Rust",
            program: "cargo",
            args: vec!["check".into(), "--message-format=short".into()],
            go_work: false,
        });
    }
    if exists("tsconfig.json")? {
        checkers.push(Checker {
            label: "TypeScript",
            program: "npx",
            args: vec!["tsc".into(), "--noEmit".into()],
            go_work: false,
        });
    }
    let work = exists("go.work")?;
    if work || exists("go.mod")? {
        checkers.push(Checker {
            label: "Go",
            program: "go",
            args: vec!["build".into(), "./...".into()],
            go_work: work,
        });
    }
    if exists("pyproject.toml")? || exists("pyrightconfig.json")? {
        checkers.push(Checker {
            label: "Python",
            program: "pyright",
            args: Vec::new(),
            go_work: false,
        });
    }
    if checkers.is_empty() {
        return Ok(LspResult::new(
            input,
            "No supported project found. Workspace diagnostics support Cargo.toml, tsconfig.json, go.work/go.mod and pyproject.toml/pyrightconfig.json.",
            None,
        ));
    }
    let mut jobs = stream::iter(checkers)
        .map(|checker| async move {
            let mut args = checker.args;
            if checker.go_work {
                match run_process(
                    epoch,
                    Path::new("go"),
                    &["work".into(), "edit".into(), "-json".into()],
                    None,
                )
                .await
                {
                    Ok(output) if output.success => {
                        if let Ok(value) = serde_json::from_str::<Value>(&output.stdout)
                            && let Some(paths) = value.get("Use").and_then(Value::as_array)
                        {
                            let paths: Vec<_> = paths
                                .iter()
                                .filter_map(|entry| entry.get("DiskPath").and_then(Value::as_str))
                                .map(|path| {
                                    format!(
                                        "{}/...",
                                        client::map_string(epoch, path, true).trim_end_matches('/')
                                    )
                                })
                                .collect();
                            if !paths.is_empty() {
                                args = vec!["build".into()];
                                args.extend(paths);
                            }
                        }
                    }
                    _ => {}
                }
            }
            (
                checker.label,
                run_process(epoch, Path::new(checker.program), &args, Some(50)).await,
            )
        })
        .buffered(2);
    let mut lines = Vec::new();
    loop {
        let output = tokio::select! {output=jobs.next()=>output,pump=runtime.pump_until(epoch,deadline)=>{if !pump?{return Err(LspError::Tool("workspace diagnostics timed out".into()));}continue;}};
        let Some((label, output)) = output else { break };
        match output {
            Ok(output) => {
                let text = match (
                    output.stdout.trim().is_empty(),
                    output.stderr.trim().is_empty(),
                ) {
                    (false, false) => format!("{}\n{}", output.stdout.trim(), output.stderr.trim()),
                    (false, true) => output.stdout,
                    (true, false) => output.stderr,
                    (true, true) => String::new(),
                };
                if text.trim().is_empty() {
                    lines.push(format!(
                        "{label}: {}",
                        if output.success {
                            "No diagnostics"
                        } else {
                            "Unverified: checker failed without output"
                        }
                    ));
                } else {
                    let all = text.lines().take(51).collect::<Vec<_>>();
                    let mut rendered = all.iter().take(50).copied().collect::<Vec<_>>().join("\n");
                    if all.len() > 50 {
                        rendered.push_str("\n(output limited to 50 lines)");
                    }
                    lines.push(format!("{label}:\n{rendered}"));
                }
            }
            Err(error) => lines.push(format!("{label}: spawn/check failure: {error}")),
        }
    }
    Ok(LspResult::new(input, lines.join("\n\n"), None))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_utf16_positions_and_occurrences() {
        assert_eq!(
            position("😀 foo foo\r\nnext", Some(1.0), Some("foo#2")).unwrap(),
            Position::new(0, 7)
        );
        assert_eq!(position("  foo", None, None).unwrap(), Position::new(0, 2));
        assert_eq!(
            position("foo", None, Some("foo#0")).unwrap(),
            Position::new(0, 0)
        );
        for line in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY, 3.0] {
            assert!(position("foo\n", Some(line), None).is_err());
        }
    }
    #[test]
    fn identifier_boundaries_and_case_priority() {
        assert_eq!(
            position("foobar FOO foo", None, Some("foo"))
                .unwrap()
                .character,
            11
        );
        assert_eq!(
            position("foobar FOO", None, Some("foo")).unwrap().character,
            7
        );
        assert!(position("foobar", None, Some("foo")).is_err());
        assert!(position("foo", None, Some("foo#2")).is_err());
    }
    #[test]
    fn hover_keeps_markdown_and_code() {
        assert_eq!(
            hover(
                &json!([{"language":"rust","value":"fn f()"},{"kind":"markdown","value":"**docs**"}])
            ),
            "```rust\nfn f()\n```\n\n**docs**"
        );
    }
    #[test]
    fn unicode_case_fallback_and_nonoverlapping_occurrences() {
        assert_eq!(position("É e", None, Some("é")).unwrap().character, 0);
        assert!(position("aaa", None, Some("aa#2")).is_err());
        assert_eq!(
            position("x\r\n😀 next", Some(2.0), Some("next")).unwrap(),
            Position::new(1, 3)
        );
    }
    #[tokio::test]
    async fn checker_capture_keeps_draining_after_line_limit() {
        let mut input: &[u8] = b"one\ntwo\nthree\nfour\n";
        let output = drain(&mut input, Some(2)).await.unwrap();
        assert!(input.is_empty());
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "one\ntwo\n\n(output limited to 2 lines)"
        );
    }
    #[tokio::test]
    async fn linter_capture_preserves_complete_json() {
        let text = format!("{{\"message\":\"{}\"}}", "x".repeat(1024 * 1024 + 1));
        let mut input = text.as_bytes();
        assert_eq!(drain(&mut input, None).await.unwrap(), text.as_bytes());
    }
}
