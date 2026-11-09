//! Stage 4: freeze redo, append complete evidence, then cross the durable intent boundary once.

use std::io::Write;
use std::path::Path;
use std::sync::atomic::Ordering;

use marsh_lib::{CheckedAdvance, RecoverPoison as _};
use marsh_wal::{Seq, SourceUid};

use super::ShellError;
use super::completion::Completion;
use super::execution::{ExecutedTransaction, PublicationMode};
use super::policy::AuthorizedTransaction;
use super::session::{GrantedCapability, PublishMeta, Session};
use super::snapshot::{CommandEvidence, PreparedCommand, Snapshot};

#[expect(
    clippy::significant_drop_tightening,
    reason = "`authority` only borrows the guard `authorized` owns, which `release_authority` drops once publication ends"
)]
pub(super) fn commit(
    mut authorized: Completion<AuthorizedTransaction<'_>>,
) -> Result<bool, ShellError> {
    let mut executed = authorized
        .payload
        .executed
        .take()
        .ok_or_else(|| ShellError::infrastructure("missing authorized execution"))?;
    let snapshot = executed.prepared.snapshot.clone();
    let session = &snapshot.session;
    let workspace_mutated = !authorized.payload.operations.is_empty()
        || executed
            .evidence
            .effects
            .iter()
            .any(|(_, effects)| effects.workspace_mutated);
    let mut redo = None;
    let mut durable = false;
    let mut committed_cleanup = None;
    let publication = (|| -> Result<(), ShellError> {
        let scope = session.tracing.internal_scope()?;
        let _guard = scope.enter();
        let authority = authorized
            .payload
            .guard
            .as_mut()
            .ok_or_else(|| ShellError::infrastructure("missing publication authority"))?;
        // A failed operation still authorizes all evidence, but its filesystem prefix is private.
        let operations = if executed.mode == PublicationMode::Apply {
            authorized.payload.operations.as_slice()
        } else {
            &[]
        };
        let physical = !operations.is_empty();
        let before = authority.tree_seq;
        if physical {
            before.next()?;
        }
        append_evidence(&snapshot, &executed.evidence)?;
        if physical || !authorized.payload.events.is_empty() {
            let seq = Seq::new(
                authority
                    .seq
                    .get()
                    .checked_add(1)
                    .ok_or_else(|| ShellError::infrastructure("ledger sequence exhaustion"))?,
            );
            let uid = source_uid(&executed.prepared, physical)?;
            let source = session.persistence.snap().join(uid.as_str());
            if physical {
                session.fs.snapshot_readonly(snapshot.path(), &source)?;
                redo = Some(source.clone());
            }
            let meta = PublishMeta {
                cmd: std::mem::take(&mut executed.command),
                principal: snapshot.owner.clone(),
                granted: authorized
                    .payload
                    .events
                    .iter()
                    .map(GrantedCapability::from)
                    .collect(),
            };
            let transaction = marsh_wal::prepare(
                &session.persistence.seed,
                &source,
                &session.log,
                &uid,
                seq,
                &meta,
                operations,
            )?;
            let _seal = executed.prepared.run.seal_publication(&executed.seal)?;
            // Even the first BEGIN write can partially succeed. Retain recovery resources until END.
            authority.recovery_required = true;
            snapshot.retained.store(true, Ordering::Release);
            match transaction.apply() {
                Ok(()) => {}
                Err(error @ marsh_wal::Error::CommittedCleanup { .. }) => {
                    committed_cleanup = Some(error);
                }
                Err(error) => return Err(error.into()),
            }
            durable = true;
            authorized.completed = true;
            authority.seq = seq;
            if physical {
                Session::record_versions(authority, operations)?;
            }
            authority.recovery_required = committed_cleanup.is_some();
            snapshot.retained.store(false, Ordering::Release);
        } else {
            let _seal = executed.prepared.run.seal_publication(&executed.seal)?;
        }
        authorized.completed = true;
        if executed.mode == PublicationMode::Apply {
            let mut state = snapshot.state.lock().recover();
            if executed.prepared.tree_seq == before {
                state.tree_seq = authority.tree_seq;
            }
            state.dirty = false;
        }
        Ok(())
    })();
    // No source deletion or post-commit work holds the policy/authority guard.
    authorized.release_authority();
    conclude(
        publication,
        durable,
        redo.as_deref(),
        &snapshot,
        &mut executed,
    )?;
    if let Some(error) = committed_cleanup {
        return Err(error.into());
    }
    Ok(workspace_mutated)
}

/// Names the ledger source: a per-command redo snapshot when physical, else the principal.
fn source_uid(prepared: &PreparedCommand, physical: bool) -> Result<SourceUid, ShellError> {
    let principal = &prepared.snapshot.uid;
    Ok(if physical {
        SourceUid::new(format!("{principal}-redo-{}", prepared.number))?
    } else {
        SourceUid::new(principal.as_str())?
    })
}

/// Appends the command's syscall evidence to its run trace log and syncs it to disk.
fn append_evidence(snapshot: &Snapshot, evidence: &CommandEvidence) -> Result<(), ShellError> {
    let records = snapshot
        .session
        .persistence
        .run_dir(snapshot.uid.as_str())?;
    std::fs::create_dir_all(&records)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(records.join("trace.log"))?;
    let mut output = std::io::BufWriter::new(file);
    for record in &evidence.records {
        serde_json::to_writer(&mut output, record)?;
        output.write_all(b"\n")?;
    }
    output.flush()?;
    output.get_ref().sync_all()?;
    Ok(())
}

/// Reclaims private redo and baseline resources, then maps the publication outcome to a result.
fn conclude(
    publication: Result<(), ShellError>,
    durable: bool,
    redo: Option<&Path>,
    snapshot: &Snapshot,
    executed: &mut ExecutedTransaction<'_>,
) -> Result<(), ShellError> {
    match publication {
        Err(error) if !durable => {
            if !snapshot.retained.load(Ordering::Acquire)
                && let Some(redo) = redo
            {
                let _ = snapshot.reclaim(redo);
            }
            Err(error)
        }
        result => {
            // END is the commit point: cleanup can retain private resources but cannot relabel
            // the completed command as unpublished or erase its process status.
            if durable || result.is_ok() {
                if let Some(redo) = redo {
                    let _ = snapshot.reclaim(redo);
                }
                let _ = executed.prepared.reclaim();
            }
            Ok(())
        }
    }
}
