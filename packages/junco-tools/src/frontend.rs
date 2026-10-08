use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use marsh_core::shellmux::{FrontendEvent, OutputChannel, ShellFrontend, ShellMux};
use marsh_core::{Action, Event, PolicyDecision, Principal};
use napi::Status;
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use tokio::sync::{oneshot, watch};

use crate::NativePolicyDecision;

pub(crate) type OutputCallback = ThreadsafeFunction<Buffer, ()>;
pub(crate) type PolicyCallback =
    ThreadsafeFunction<NativePolicyDecision, (), NativePolicyDecision, Status, true, true>;

#[derive(Default)]
struct RouteProgress {
    pending: usize,
    closed: bool,
    failure: Option<String>,
}

/// Where a route delivers a shell's bytes: one-shot runs merge both pipe streams into one
/// callback, a persistent process keeps standard output and standard error apart.
enum Destination {
    Merged(OutputCallback),
    Separate {
        stdout: OutputCallback,
        stderr: OutputCallback,
    },
}

impl Destination {
    fn callback(&self, channel: OutputChannel) -> &OutputCallback {
        match (self, channel) {
            (Self::Merged(callback), _) => callback,
            (Self::Separate { stderr, .. }, OutputChannel::Stderr) => stderr,
            (Self::Separate { stdout, .. }, OutputChannel::Stdout | OutputChannel::Terminal) => {
                stdout
            }
        }
    }
}

/// One shell's output destination. Both streams share one progress record, so a single drain
/// fence covers every queued callback of either stream and the first failure of either stops it.
pub(crate) struct OutputRoute {
    destination: Mutex<Option<Destination>>,
    progress: Arc<watch::Sender<RouteProgress>>,
}

impl OutputRoute {
    pub(crate) fn new(callback: OutputCallback) -> Arc<Self> {
        Self::with(Destination::Merged(callback))
    }

    pub(crate) fn separate(stdout: OutputCallback, stderr: OutputCallback) -> Arc<Self> {
        Self::with(Destination::Separate { stdout, stderr })
    }

    fn with(destination: Destination) -> Arc<Self> {
        let (progress, _) = watch::channel(RouteProgress::default());
        Arc::new(Self {
            destination: Mutex::new(Some(destination)),
            progress: Arc::new(progress),
        })
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.progress.borrow().failure.clone()
    }

    pub(crate) async fn failed(&self) -> String {
        let mut progress = self.progress.subscribe();
        match progress.wait_for(|state| state.failure.is_some()).await {
            Ok(state) => state.failure.clone().expect("failure predicate is satisfied"),
            Err(_) => "ShellMux output route ended before reporting a failure".to_owned(),
        }
    }

    pub(crate) async fn drained(&self) -> Result<(), String> {
        let mut progress = self.progress.subscribe();
        let state = progress
            .wait_for(|state| state.closed && state.pending == 0)
            .await
            .map_err(|_| "ShellMux output route ended before frontend closure".to_owned())?;
        state.failure.clone().map_or(Ok(()), Err)
    }

    /// Records the first failure; later ones are dropped.
    fn fail(&self, error: String) {
        self.progress.send_if_modified(|state| {
            if state.failure.is_some() {
                return false;
            }
            state.failure = Some(error);
            true
        });
    }

    fn closed(&self) {
        // wait_closed() is earlier than this frontend event. In addition, a forced stop can
        // abandon native receipts while their JavaScript callbacks are still queued.
        self.progress.send_modify(|state| state.closed = true);
    }

    fn detach(&self) {
        let destination = self
            .destination
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        drop(destination);
    }

    fn output(&self, channel: OutputChannel, bytes: &[u8]) -> oneshot::Receiver<()> {
        let (receipt, received) = oneshot::channel();
        let destination = self
            .destination
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(callback) = destination.as_ref().map(|it| it.callback(channel)) else {
            self.fail("ShellMux output route is detached".to_owned());
            // Dropping this sender is a failed receipt, never an acknowledgement of lost bytes.
            return received;
        };

        self.progress.send_modify(|state| state.pending += 1);
        let completion = Arc::new(CallbackCompletion {
            progress: Arc::downgrade(&self.progress),
            receipt: Mutex::new(Some(CallbackReceipt::Output(receipt))),
        });
        let returned = Arc::clone(&completion);
        let status = callback.call_with_return_value(
            Ok(Buffer::from(bytes.to_vec())),
            ThreadsafeFunctionCallMode::NonBlocking,
            move |result, _env| {
                returned.complete(
                    result.map_err(|error| format!("ShellMux output callback failed: {error}")),
                );
                // napi routes an Err returned by this completion into napi_fatal_exception.
                // The route carries the error to the runner instead; Node must remain usable.
                Ok(())
            },
        );
        if status != Status::Ok {
            completion.complete(Err(format!(
                "ShellMux output callback enqueue failed: {status}"
            )));
        }
        received
    }
}

/// One mux's policy-decision log: the JavaScript sink, whether grants are delivered, and the
/// pending/failure record close drains. A failed callback is reported at close and never
/// affects authorization or execution. The callback is weak: a mux-lifetime logger never keeps
/// Node alive; close's own promise does until every enqueued decision returned. The close task
/// owns the last reference and releases the callback once drained.
pub(crate) struct PolicyLog {
    callback: PolicyCallback,
    grants: bool,
    progress: Arc<watch::Sender<RouteProgress>>,
}

impl PolicyLog {
    pub(crate) fn new(callback: PolicyCallback, grants: bool) -> Arc<Self> {
        let (progress, _) = watch::channel(RouteProgress::default());
        Arc::new(Self {
            callback,
            grants,
            progress: Arc::new(progress),
        })
    }

    /// Enqueues one decision. Runs under the authority's write lock: never waits for JavaScript.
    pub(crate) fn observe(&self, event: &Event, decision: &PolicyDecision) {
        let (granted, failed_precondition, allowed_fixes) = match decision {
            PolicyDecision::Grant if !self.grants => return,
            PolicyDecision::Grant => (true, None, None),
            PolicyDecision::Deny {
                failed_precondition,
                allowed_fixes,
            } => (
                false,
                Some(failed_precondition.clone()),
                Some(allowed_fixes.clone()),
            ),
        };
        let data = NativePolicyDecision {
            granted,
            principal: event.principal.as_str().to_owned(),
            action: action_name(&event.action).to_owned(),
            resource: event.resource.segments().to_vec(),
            failed_precondition,
            allowed_fixes,
        };
        self.progress.send_modify(|state| state.pending += 1);
        let completion = Arc::new(CallbackCompletion {
            progress: Arc::downgrade(&self.progress),
            receipt: Mutex::new(Some(CallbackReceipt::Policy)),
        });
        let returned = Arc::clone(&completion);
        let status = self.callback.call_with_return_value(
            Ok(data),
            ThreadsafeFunctionCallMode::NonBlocking,
            move |result, _env| {
                returned.complete(
                    result.map_err(|error| format!("ShellMux policy log callback failed: {error}")),
                );
                Ok(())
            },
        );
        if status != Status::Ok {
            completion.complete(Err(format!(
                "ShellMux policy log callback enqueue failed: {status}"
            )));
        }
    }

    /// Resolves once every enqueued decision returned, with the first callback failure.
    pub(crate) async fn drained(&self) -> Result<(), String> {
        let mut progress = self.progress.subscribe();
        let state = progress
            .wait_for(|state| state.pending == 0)
            .await
            .map_err(|_| "ShellMux policy log ended before draining".to_owned())?;
        state.failure.clone().map_or(Ok(()), Err)
    }
}

const fn action_name(action: &Action) -> &'static str {
    match action {
        Action::Read => "Read",
        Action::Edit => "Edit",
        Action::Release => "Release",
        Action::Remove => "Remove",
    }
}

/// What a settled callback releases: an output chunk's acknowledgement, or nothing for a
/// policy record, which no producer waits on.
enum CallbackReceipt {
    Output(oneshot::Sender<()>),
    Policy,
}

// Queued completions must not own the route, its TSFN, or a mux. In particular, napi 3.9 can
// retain the allocated callback when enqueueing fails; the synchronous failure path still
// settles this token and releases its receipt without retaining the session or JS function.
struct CallbackCompletion {
    progress: Weak<watch::Sender<RouteProgress>>,
    receipt: Mutex<Option<CallbackReceipt>>,
}

impl CallbackCompletion {
    fn complete(&self, result: Result<(), String>) {
        let receipt = self
            .receipt
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let Some(receipt) = receipt else {
            return;
        };
        // Taking the receipt is the once-only latch shared by enqueue failure, callback return,
        // and callback destruction. Even a callback racing the enqueue result decrements once.
        let successful = result.is_ok();
        if let Some(progress) = self.progress.upgrade() {
            progress.send_modify(|state| {
                state.pending -= 1;
                if state.failure.is_none() {
                    state.failure = result.err();
                }
            });
        }
        if successful && let CallbackReceipt::Output(receipt) = receipt {
            // A forced stop may already have dropped the native receiver. That does not make
            // a successful JS return an output error and must not escape to napi either.
            let _ = receipt.send(());
        }
    }
}

impl Drop for CallbackCompletion {
    fn drop(&mut self) {
        let dropped = match self
            .receipt
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
        {
            None => return,
            Some(CallbackReceipt::Output(_)) => {
                "ShellMux output callback was dropped before returning"
            }
            Some(CallbackReceipt::Policy) => {
                "ShellMux policy log callback was dropped before returning"
            }
        };
        self.complete(Err(dropped.to_owned()));
    }
}

pub(crate) struct Frontend {
    geometry: (u16, u16),
    routes: HashMap<Principal, Arc<OutputRoute>>,
}

impl Frontend {
    pub(crate) fn register(&mut self, uid: Principal, route: Arc<OutputRoute>) {
        if let Some(previous) = self.routes.insert(uid, route) {
            previous.fail("ShellMux output route was replaced before removal".to_owned());
            previous.detach();
        }
    }

    pub(crate) fn remove(&mut self, uid: &Principal) {
        if let Some(route) = self.routes.remove(uid) {
            // The runner removes a route only after its Closed event and callback fence.
            route.detach();
        }
    }
}

impl ShellFrontend for Frontend {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            geometry: (rows, cols),
            routes: HashMap::new(),
        }
    }

    fn size(&self) -> (u16, u16) {
        self.geometry
    }

    fn bind(&mut self, mux: Weak<ShellMux>) {
        if mux.upgrade().is_none() {
            for (_, route) in self.routes.drain() {
                route.detach();
            }
        }
    }

    fn update(&mut self, event: FrontendEvent<'_>) -> Option<oneshot::Receiver<()>> {
        match event {
            FrontendEvent::Output {
                shell,
                channel,
                bytes,
            } => {
                if let Some(route) = self.routes.get(&shell.uid) {
                    return Some(route.output(channel, bytes));
                }
                // An unregistered consumer cannot truthfully acknowledge these bytes.
                let (receipt, received) = oneshot::channel();
                drop(receipt);
                return Some(received);
            }
            FrontendEvent::Closed { end } => {
                if let Some(route) = self.routes.get(&end.shell.uid) {
                    route.closed();
                }
            }
            FrontendEvent::IoError {
                shell,
                channel,
                error,
            } => {
                if let Some(route) = self.routes.get(&shell.uid) {
                    route.fail(format!("ShellMux {channel:?} output failed: {error}"));
                }
            }
            FrontendEvent::DefaultResized { geometry } => {
                self.geometry = (geometry.rows, geometry.cols);
            }
            FrontendEvent::Changed
            | FrontendEvent::Opened(_)
            | FrontendEvent::CommandAccepted { .. }
            | FrontendEvent::Finished { .. }
            | FrontendEvent::Resized { .. } => {}
        }
        None
    }
}
