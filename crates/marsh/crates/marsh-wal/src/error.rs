//! Infrastructure failures.
//!
//! Every variant names a condition the publication layer could not proceed through: a log that
//! cannot be written or replayed, or an I/O failure underneath one. A command that merely failed is
//! not represented here — this crate never runs one.

use std::io::ErrorKind;
use std::path::PathBuf;

/// Failure raised while logging or publishing a transaction.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The write-ahead log is unusable or its recovery failed.
    #[error("write-ahead log failure: {0}")]
    Wal(String),
    /// Filesystem I/O failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// A metadata append failed and its rollback or checkpoint cleanup also failed. The source
    /// remains in doubt until repaired; both failures and the saved boundary remain available.
    #[error("metadata receipt is in doubt at {checkpoint:?}: append failed: {append}; abort failed: {rollback}")]
    AppendRollback {
        /// The write or durability error that prevented the metadata receipt.
        #[source]
        append: std::io::Error,
        /// The error while restoring the prior log or clearing its checkpoint.
        rollback: std::io::Error,
        /// Retained checkpoint that blocks further publication and recovery.
        checkpoint: PathBuf,
    },
    /// END was durably committed, but removing or syncing its checkpoint failed. This diagnostic
    /// must never cause the committed transaction's history to be rolled back.
    #[error("metadata receipt committed; checkpoint cleanup failed at {checkpoint:?}: {cleanup}")]
    CommittedCleanup {
        /// Checkpoint retained after the receipt was durably committed.
        checkpoint: PathBuf,
        /// The failure removing or syncing the committed checkpoint.
        #[source]
        cleanup: std::io::Error,
    },
}

impl From<rustix::io::Errno> for Error {
    fn from(error: rustix::io::Errno) -> Self {
        Self::Io(error.into())
    }
}

/// The lookup failures that mean a path names nothing: it is absent, or an ancestor is no
/// directory.
pub(crate) const ABSENT: &[ErrorKind] = &[ErrorKind::NotFound, ErrorKind::NotADirectory];

/// A fallible result some of whose I/O failures are expected outcomes rather than errors.
pub(crate) trait Tolerate<T> {
    /// The value on success, `None` for an I/O failure of one of `kinds`, and any other failure
    /// as the [`Error`] it is.
    fn tolerate(self, kinds: &[ErrorKind]) -> Result<Option<T>, Error>;
}

impl<T, E: Into<Error>> Tolerate<T> for Result<T, E> {
    fn tolerate(self, kinds: &[ErrorKind]) -> Result<Option<T>, Error> {
        match self.map_err(Into::<Error>::into) {
            Ok(value) => Ok(Some(value)),
            Err(Error::Io(error)) if kinds.contains(&error.kind()) => Ok(None),
            Err(error) => Err(error),
        }
    }
}
