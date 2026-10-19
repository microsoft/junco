//! Blocking work scheduling for N-API exports.
//!
//! Adapted from Oh My Pi `crates/pi-natives/src/task.rs` at revision
//! `7ae76f8e4daca0c8f409f61bcd514260cd522365` (see `LICENSE.oh-my-pi`).
//! The mapped-task/future APIs, profiling hooks, and crash-handler scope
//! integration are omitted; [`panic_payload`] is inlined from that revision's
//! `crates/pi-natives/src/crash_handler.rs`.
//!
//! # Overview
//! Runs CPU-bound or blocking Rust work on libuv's thread pool via napi's
//! `Task` trait, with cancellation support.
//!
//! # Cancellation
//! Pass a `CancelToken` to blocking tasks. Work must check
//! `CancelToken::heartbeat()` periodically to respect cancellation.

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Weak,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use napi::{Env, Error, Result, Status, Task, bindgen_prelude::*};

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

/// Reason for task abortion.
///
/// Discriminants are the values stored in [`Flag`]; `0` is the unset state, so
/// no variant may claim it.
#[derive(Debug, Clone, Copy)]
#[repr(u8)]
pub enum AbortReason {
    Unknown = 1,
    Timeout = 2,
    Signal = 3,
}

impl TryFrom<u8> for AbortReason {
    type Error = ();

    fn try_from(value: u8) -> std::result::Result<Self, ()> {
        match value {
            0 => Err(()),
            2 => Ok(Self::Timeout),
            3 => Ok(Self::Signal),
            _ => Ok(Self::Unknown),
        }
    }
}

/// Abort state shared between a [`CancelToken`] and its [`AbortToken`] handles.
#[derive(Default)]
struct Flag(AtomicU8);

impl Flag {
    fn cause(&self) -> Option<AbortReason> {
        self.0.load(Ordering::Relaxed).try_into().ok()
    }

    fn abort(&self, reason: AbortReason) {
        self.0.store(reason as u8, Ordering::SeqCst);
    }
}

/// Token for cooperative cancellation of blocking work.
///
/// Call `heartbeat()` periodically inside long-running work to check for
/// cancellation requests from timeouts or abort signals.
#[derive(Clone, Default)]
pub struct CancelToken {
    deadline: Option<Instant>,
    flag: Option<Arc<Flag>>,
}

impl From<()> for CancelToken {
    fn from((): ()) -> Self {
        Self::default()
    }
}

impl CancelToken {
    /// Create a new cancel token from optional timeout and abort signal.
    pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
        let mut result = Self {
            deadline: timeout_ms.map(|ms| Instant::now() + Duration::from_millis(u64::from(ms))),
            flag: None,
        };
        if let Some(signal) = signal.and_then(|value| AbortSignal::from_unknown(value).ok()) {
            let abort_token = result.emplace_abort_token();
            signal.on_abort(move || abort_token.abort(AbortReason::Signal));
        }
        result
    }

    /// Check if cancellation has been requested.
    ///
    /// Returns `Ok(())` if work should continue, or an error if cancelled.
    /// Call this periodically in long-running loops.
    pub fn heartbeat(&self) -> Result<()> {
        if let Some(flag) = &self.flag
            && let Some(reason) = flag.cause()
        {
            return Err(Error::from_reason(format!("Aborted: {reason:?}")));
        }
        if let Some(deadline) = self.deadline
            && deadline < Instant::now()
        {
            return Err(Error::from_reason("Aborted: Timeout"));
        }
        Ok(())
    }

    /// Emplaces an abort flag if there is none, returning a handle onto it.
    fn emplace_abort_token(&mut self) -> AbortToken {
        AbortToken(Arc::downgrade(self.flag.get_or_insert_default()))
    }
}

/// Handle for requesting cancellation from outside the task.
#[derive(Clone)]
struct AbortToken(Weak<Flag>);

impl AbortToken {
    /// Request cancellation of the associated task.
    fn abort(&self, reason: AbortReason) {
        if let Some(flag) = self.0.upgrade() {
            flag.abort(reason);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocking Task - libuv thread pool integration
// ─────────────────────────────────────────────────────────────────────────────

/// Task that runs blocking work on libuv's thread pool.
///
/// This implements napi's `Task` trait, running `compute()` on a libuv worker
/// thread and `resolve()` on the main JS thread.
pub struct Blocking<T>
where
    T: Send + 'static,
{
    tag: &'static str,
    cancel_token: CancelToken,
    work: Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

impl<T> Task for Blocking<T>
where
    T: ToNapiValue + Send + 'static + TypeName,
{
    type JsValue = T;
    type Output = T;

    fn compute(&mut self) -> Result<Self::Output> {
        let work = self
            .work
            .take()
            .ok_or_else(|| Error::from_reason("BlockingTask: work already consumed"))?;
        let cancel_token = self.cancel_token.clone();
        let tag = self.tag;
        // Guard the napi-rs async-work FFI boundary. `execute` is registered as
        // a plain `unsafe extern "C" fn` (napi 3.9 `src/async_work.rs`), so an
        // unwind escaping this frame would cross a non-`C-unwind` FFI edge and
        // force-abort the host under Rust's stabilized C-unwind rules
        // (RFC 2945, stable since 1.81).
        match catch_unwind(AssertUnwindSafe(move || work(cancel_token))) {
            Ok(result) => result,
            Err(payload) => {
                // Extract the message BEFORE touching the payload's destructor:
                // disposal is the one remaining step that can panic again.
                let message = panic_payload(&*payload);
                dispose_panic_payload(payload);
                Err(Error::new(
                    Status::GenericFailure,
                    format!("native task `{tag}` panicked: {message}"),
                ))
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Extract a printable message from a panic payload captured by
/// [`std::panic::catch_unwind`]. Handles the two shapes `panic!` produces —
/// `&'static str` (literal) and `String` (formatted) — and degrades to a
/// sentinel for arbitrary [`panic_any`](std::panic::panic_any) payloads.
fn panic_payload(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_owned()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        String::from("<non-string panic payload>")
    }
}

/// Dispose of a caught panic payload without any possibility of a second
/// unwind escaping this frame.
///
/// A [`std::panic::panic_any`] payload is an arbitrary user type whose `Drop`
/// impl may itself panic. [`Blocking::compute`] runs inside napi's async-work
/// `extern "C"` frame, so a panic escaping the payload's destructor would
/// cross the same non-`C-unwind` FFI edge the surrounding [`catch_unwind`]
/// exists to guard — force-aborting the host and defeating the recovery. The
/// drop is therefore attempted under its own [`catch_unwind`].
///
/// Leak rationale: if the destructor panics, the *secondary* payload is
/// [`std::mem::forget`]-ten instead of dropped — dropping it could panic
/// again, unwinding out of this frame after the guard already fired once.
/// Leaking one payload on this pathological path is a bounded, acceptable
/// cost; aborting the whole host process is not. `forget` on a
/// `Box<dyn Any + Send>` is always memory-safe (it only skips the destructor
/// and leaks the allocation).
pub(crate) fn dispose_panic_payload(payload: Box<dyn std::any::Any + Send>) {
    if let Err(secondary) = catch_unwind(AssertUnwindSafe(|| drop(payload))) {
        std::mem::forget(secondary);
    }
}

pub type Promise<T> = AsyncTask<Blocking<T>>;

/// Create an `AsyncTask` that runs blocking work on libuv's thread pool.
///
/// Returns `AsyncTask<Blocking<T>>` which can be returned directly from
/// `#[napi]` functions - it becomes `Promise<T>` on the JS side.
///
/// # Arguments
/// - `tag`: Diagnostic tag for this work (appears in panic rejections)
/// - `cancel_token`: Token for cooperative cancellation
/// - `work`: Closure that performs the blocking work
pub fn blocking<T, F>(
    tag: &'static str,
    cancel_token: impl Into<CancelToken>,
    work: F,
) -> AsyncTask<Blocking<T>>
where
    F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
    T: ToNapiValue + TypeName + Send + 'static,
{
    AsyncTask::new(Blocking {
        tag,
        cancel_token: cancel_token.into(),
        work: Some(Box::new(work)),
    })
}

#[cfg(test)]
mod tests {
    //! Regression coverage for the FFI-boundary panic guard in
    //! [`Blocking::compute`]. These exercise the trait method directly on the
    //! caller thread — libuv's async-work queue isn't running under
    //! `cargo test`, but the guard sits inside `compute`, so calling it
    //! synchronously proves the invariant: a panicking closure MUST NOT unwind
    //! past this method.

    use super::*;
    use crate::testing::SilenceHook;

    fn blocking_task<T, F>(tag: &'static str, work: F) -> Blocking<T>
    where
        T: Send + 'static,
        F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
    {
        Blocking {
            tag,
            cancel_token: CancelToken::default(),
            work: Some(Box::new(work)),
        }
    }

    #[test]
    fn compute_forwards_ok_result() {
        let mut task = blocking_task("t_ok", |_| Ok(42_u32));
        assert_eq!(task.compute().unwrap(), 42);
    }

    #[test]
    fn compute_forwards_err_result() {
        let mut task = blocking_task::<u32, _>("t_err", |_| Err(Error::from_reason("boom")));
        let err = task.compute().unwrap_err();
        assert_eq!(err.status, Status::GenericFailure);
        assert_eq!(err.reason, "boom");
    }

    #[test]
    fn compute_catches_str_literal_panic() {
        let _silence = SilenceHook::new();
        let mut task = blocking_task::<u32, _>("t_panic_str", |_| panic!("kaboom"));
        let err = task.compute().unwrap_err();
        assert_eq!(err.status, Status::GenericFailure);
        assert!(
            err.reason.contains("t_panic_str"),
            "reason = {}",
            err.reason
        );
        assert!(err.reason.contains("kaboom"), "reason = {}", err.reason);
    }

    #[test]
    fn compute_catches_formatted_panic() {
        let _silence = SilenceHook::new();
        let mut task = blocking_task::<u32, _>("t_panic_fmt", |_| {
            let n = 7;
            panic!("fmt {n}");
        });
        let err = task.compute().unwrap_err();
        assert!(err.reason.contains("fmt 7"), "reason = {}", err.reason);
    }

    #[test]
    fn compute_catches_non_string_panic() {
        let _silence = SilenceHook::new();
        let mut task = blocking_task::<u32, _>("t_panic_any", |_| {
            std::panic::panic_any(0xdead_beef_u32);
        });
        let err = task.compute().unwrap_err();
        assert!(
            err.reason.contains("<non-string panic payload>"),
            "reason = {}",
            err.reason
        );
    }

    /// Payload whose destructor itself panics — the pathological
    /// `panic_any` shape that used to double-unwind out of `compute` and
    /// abort the host across the napi `extern "C"` boundary.
    ///
    /// `drop` records that it ran via `dropped`, then detonates. The
    /// [`std::thread::panicking`] guard keeps the detonation out of any
    /// *unrelated* unwind (e.g. a failing test assertion dropping the bomb),
    /// where a second panic would abort the whole test binary instead of
    /// failing one test; on the recovery path under test the thread is no
    /// longer panicking, so the bomb always fires there.
    struct DropBomb {
        dropped: &'static std::sync::atomic::AtomicBool,
    }

    impl Drop for DropBomb {
        fn drop(&mut self) {
            self.dropped
                .store(true, std::sync::atomic::Ordering::SeqCst);
            assert!(std::thread::panicking(), "DropBomb detonated in drop");
        }
    }

    #[test]
    fn compute_survives_payload_whose_drop_panics() {
        static DROPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let _silence = SilenceHook::new();
        let mut task = blocking_task::<u32, _>("t_drop_bomb", |_| {
            std::panic::panic_any(DropBomb { dropped: &DROPPED });
        });
        // Before the fix this aborted the process: the payload's Drop panicked
        // while `compute` returned, unwinding across napi's `extern "C"` frame.
        let err = task.compute().unwrap_err();
        assert_eq!(err.status, Status::GenericFailure);
        assert!(
            err.reason.contains("t_drop_bomb"),
            "reason = {}",
            err.reason
        );
        assert!(
            err.reason.contains("<non-string panic payload>"),
            "reason = {}",
            err.reason
        );
        assert!(
            DROPPED.load(std::sync::atomic::Ordering::SeqCst),
            "payload destructor must have run (and panicked) through the recovery path"
        );
    }

    #[test]
    fn dispose_panic_payload_swallows_drop_panic() {
        static DROPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let _silence = SilenceHook::new();
        let payload = catch_unwind(AssertUnwindSafe(|| {
            std::panic::panic_any(DropBomb { dropped: &DROPPED });
        }))
        .unwrap_err();
        assert!(
            !DROPPED.load(std::sync::atomic::Ordering::SeqCst),
            "bomb must still be armed"
        );
        // Must return normally despite the payload's Drop panicking.
        dispose_panic_payload(payload);
        assert!(
            DROPPED.load(std::sync::atomic::Ordering::SeqCst),
            "destructor ran"
        );
    }

    #[test]
    fn compute_rejects_second_call() {
        let mut task = blocking_task("t_double", |_| Ok(1_u32));
        assert_eq!(task.compute().unwrap(), 1);
        let err = task.compute().unwrap_err();
        assert!(
            err.reason.contains("work already consumed"),
            "reason = {}",
            err.reason
        );
    }
}
