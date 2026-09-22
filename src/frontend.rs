use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use marsh_core::shellmux::{FrontendEvent, ShellFrontend, ShellMux, SnapshotUid};
use napi::Status;
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use tokio::sync::{oneshot, watch};

pub(crate) type OutputCallback = ThreadsafeFunction<Buffer, ()>;

#[derive(Default)]
struct RouteProgress {
    pending: usize,
    closed: bool,
    failure: Option<String>,
}

pub(crate) struct OutputRoute {
    callback: Mutex<Option<OutputCallback>>,
    progress: Arc<watch::Sender<RouteProgress>>,
}

impl OutputRoute {
    pub(crate) fn new(callback: OutputCallback) -> Arc<Self> {
        let (progress, _) = watch::channel(RouteProgress::default());
        Arc::new(Self {
            callback: Mutex::new(Some(callback)),
            progress: Arc::new(progress),
        })
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.progress.borrow().failure.clone()
    }

    pub(crate) async fn failed(&self) -> String {
        let mut progress = self.progress.subscribe();
        loop {
            if let Some(error) = progress.borrow_and_update().failure.clone() {
                return error;
            }
            // A receiver observes the current state before waiting, so cancellation and a new
            // waiter cannot lose an error reported between subscribing and polling changed().
            if progress.changed().await.is_err() {
                return "ShellMux output route ended before reporting a failure".to_owned();
            }
        }
    }

    pub(crate) async fn drained(&self) -> Result<(), String> {
        let mut progress = self.progress.subscribe();
        loop {
            {
                let state = progress.borrow_and_update();
                if state.closed && state.pending == 0 {
                    return state.failure.clone().map_or(Ok(()), Err);
                }
            }
            progress
                .changed()
                .await
                .map_err(|_| "ShellMux output route ended before frontend closure".to_owned())?;
        }
    }

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
        let callback = self
            .callback
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        drop(callback);
    }

    fn output(&self, bytes: &[u8]) -> oneshot::Receiver<()> {
        let (receipt, received) = oneshot::channel();
        let callback = self.callback.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(callback) = callback.as_ref() else {
            self.fail("ShellMux output route is detached".to_owned());
            // Dropping this sender is a failed receipt, never an acknowledgement of lost bytes.
            return received;
        };

        self.progress.send_modify(|state| state.pending += 1);
        let completion = Arc::new(CallbackCompletion {
            progress: Arc::downgrade(&self.progress),
            receipt: Mutex::new(Some(receipt)),
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

// Queued completions must not own the route, its TSFN, or a mux. In particular, napi 3.9 can
// retain the allocated callback when enqueueing fails; the synchronous failure path still
// settles this token and releases its receipt without retaining the session or JS function.
struct CallbackCompletion {
    progress: Weak<watch::Sender<RouteProgress>>,
    receipt: Mutex<Option<oneshot::Sender<()>>>,
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
        // Taking the sender is the once-only latch shared by enqueue failure, callback return,
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
        if successful {
            // A forced stop may already have dropped the native receiver. That does not make
            // a successful JS return an output error and must not escape to napi either.
            let _ = receipt.send(());
        }
    }
}

impl Drop for CallbackCompletion {
    fn drop(&mut self) {
        if self
            .receipt
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
        {
            self.complete(Err(
                "ShellMux output callback was dropped before returning".to_owned()
            ));
        }
    }
}

pub(crate) struct Frontend {
    geometry: (u16, u16),
    mux: Weak<ShellMux>,
    routes: HashMap<SnapshotUid, Arc<OutputRoute>>,
}

impl Frontend {
    pub(crate) fn register(&mut self, uid: SnapshotUid, route: Arc<OutputRoute>) {
        if let Some(previous) = self.routes.insert(uid, route) {
            previous.fail("ShellMux output route was replaced before removal".to_owned());
            previous.detach();
        }
    }

    pub(crate) fn remove(&mut self, uid: &SnapshotUid) {
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
            mux: Weak::new(),
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
        self.mux = mux;
    }

    fn update(&mut self, event: FrontendEvent<'_>) -> Option<oneshot::Receiver<()>> {
        match event {
            FrontendEvent::Output { shell, bytes, .. } => {
                if let Some(route) = self.routes.get(&shell.uid) {
                    return Some(route.output(bytes));
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
