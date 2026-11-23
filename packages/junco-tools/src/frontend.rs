use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use marsh_core::shellmux::{FrontendEvent, OutputChannel, ShellFrontend, ShellMux};
use marsh_core::{Action, Event, PolicyDecision, Principal, ResourceEvent, ResourceSample};
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Status, bindgen_prelude::ToNapiValue};
use tokio::sync::{oneshot, watch};

use crate::{NativePolicyDecision, NativeResourceEvent, NativeResourceSample};

pub(crate) type OutputCallback = ThreadsafeFunction<Buffer, ()>;
pub(crate) type PolicyCallback =
    ThreadsafeFunction<NativePolicyDecision, (), NativePolicyDecision, Status, true, true>;
pub(crate) type ResourceCallback =
    ThreadsafeFunction<NativeResourceEvent, (), NativeResourceEvent, Status, true, true>;
pub(crate) type MemoryPeakCallback = ThreadsafeFunction<f64, (), f64, Status, true, true>;

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
            Ok(state) => state
                .failure
                .clone()
                .expect("failure predicate is satisfied"),
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

/// One mux's JavaScript record sink: a weak callback that never keeps Node alive, the pending
/// count close drains, and the first callback failure.
pub(crate) struct RecordSink<T: ToNapiValue + 'static> {
    callback: ThreadsafeFunction<T, (), T, Status, true, true>,
    progress: Arc<watch::Sender<RouteProgress>>,
}

impl<T: ToNapiValue + 'static> RecordSink<T> {
    fn new(callback: ThreadsafeFunction<T, (), T, Status, true, true>) -> Self {
        let (progress, _) = watch::channel(RouteProgress::default());
        Self {
            callback,
            progress: Arc::new(progress),
        }
    }

    /// Enqueues one record; never waits for JavaScript.
    fn enqueue(&self, data: T, label: &'static str) {
        self.progress.send_modify(|state| state.pending += 1);
        let completion = Arc::new(CallbackCompletion {
            progress: Arc::downgrade(&self.progress),
            receipt: Mutex::new(Some(CallbackReceipt::Record(label))),
        });
        let returned = Arc::clone(&completion);
        let status = self.callback.call_with_return_value(
            Ok(data),
            ThreadsafeFunctionCallMode::NonBlocking,
            move |result, _env| {
                returned.complete(
                    result.map_err(|error| format!("ShellMux {label} callback failed: {error}")),
                );
                Ok(())
            },
        );
        if status != Status::Ok {
            completion.complete(Err(format!(
                "ShellMux {label} callback enqueue failed: {status}"
            )));
        }
    }

    async fn drained(&self, label: &'static str) -> Result<(), String> {
        let mut progress = self.progress.subscribe();
        let state = progress
            .wait_for(|state| state.pending == 0)
            .await
            .map_err(|_| format!("ShellMux {label} ended before draining"))?;
        state.failure.clone().map_or(Ok(()), Err)
    }
}

/// One mux's policy log. Callback failures are reported at close, never to authorization.
pub(crate) struct PolicyLog {
    sink: RecordSink<NativePolicyDecision>,
    grants: bool,
}

impl PolicyLog {
    pub(crate) fn new(callback: PolicyCallback, grants: bool) -> Arc<Self> {
        Arc::new(Self {
            sink: RecordSink::new(callback),
            grants,
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
        self.sink.enqueue(data, "policy log");
    }

    pub(crate) async fn drained(&self) -> Result<(), String> {
        self.sink.drained("policy log").await
    }
}

/// One mux's resource-event sink; the session forwards its monitor's channel into it.
pub(crate) struct ResourceLog(RecordSink<NativeResourceEvent>);

impl ResourceLog {
    pub(crate) fn new(callback: ResourceCallback) -> Arc<Self> {
        Arc::new(Self(RecordSink::new(callback)))
    }

    /// Enqueues one event; never waits for JavaScript. Unknown future variants are ignored.
    pub(crate) fn observe(&self, owner: Option<String>, event: ResourceEvent) {
        let (kind, pipeline_id, command, sample) = match event {
            ResourceEvent::Started {
                pipeline_id,
                command,
            } => ("started", pipeline_id, Some(command), None),
            ResourceEvent::Sample {
                pipeline_id,
                sample,
            } => ("sample", pipeline_id, None, Some(sample)),
            ResourceEvent::Finished {
                pipeline_id,
                sample,
            } => ("finished", pipeline_id, None, Some(sample)),
            _ => return,
        };
        self.0.enqueue(
            NativeResourceEvent {
                kind: kind.to_owned(),
                pipeline_id: pipeline_id as f64,
                owner,
                command,
                sample: sample.map(resource_sample),
            },
            "resource event",
        );
    }

    pub(crate) async fn drained(&self) -> Result<(), String> {
        self.0.drained("resource event").await
    }
}

fn resource_sample(sample: ResourceSample) -> NativeResourceSample {
    NativeResourceSample {
        elapsed_ms: sample.elapsed.as_secs_f64() * 1000.0,
        memory_bytes: sample.memory_bytes as f64,
        memory_peak_bytes: sample.memory_peak_bytes as f64,
        cpu_usage_ms: sample.cpu_usage.as_secs_f64() * 1000.0,
        cpu_user_ms: sample.cpu_user.as_secs_f64() * 1000.0,
        cpu_system_ms: sample.cpu_system.as_secs_f64() * 1000.0,
        cpu_throttled_ms: sample.cpu_throttled.as_secs_f64() * 1000.0,
        pids: sample.pids,
        oom_kills: sample.oom_kills as f64,
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
/// record, which no producer waits on.
enum CallbackReceipt {
    Output(oneshot::Sender<()>),
    Record(&'static str),
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
                "ShellMux output callback was dropped before returning".to_owned()
            }
            Some(CallbackReceipt::Record(label)) => {
                format!("ShellMux {label} callback was dropped before returning")
            }
        };
        self.complete(Err(dropped));
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
