//! One terminal-owning thread; JS callbacks only update its bounded display model.

use std::collections::{HashMap, HashSet, VecDeque, hash_map::DefaultHasher};
use std::fmt::Write as _;
use std::hash::{Hash, Hasher};
use std::io::{self, IsTerminal};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossterm::cursor::{Hide, Show};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
    is_raw_mode_enabled,
};
use napi::bindgen_prelude::PromiseRaw;
use napi::{Env, Error, Result};
use napi_derive::napi;
use ratatui::backend::{Backend, CrosstermBackend};
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use tokio::sync::{oneshot, watch};

static TERMINAL_OWNED: AtomicBool = AtomicBool::new(false);
const POLL_WAIT: Duration = Duration::from_millis(33);
// ponytail: 4 MiB formatted text, 4,096 records, 32 KiB per entry; persist history if these in-memory ceilings become limiting.
const HISTORY_BYTES: usize = 4 * 1024 * 1024;
const HISTORY_RECORDS: usize = 4096;
const ENTRY_BYTES: usize = 32 * 1024;
const TRUNCATED: &str = "[display truncated]";
const PALETTE: [(u8, u8, u8); 6] = [
    (0, 215, 255), (255, 0, 255), (0, 175, 255),
    (255, 215, 0), (255, 95, 95), (175, 135, 255),
];

/// A scoped identity. `nodeId` is the escaped display spelling, `key` the raw identity.
#[napi(object, object_to_js = false)]
pub struct NativeTuiNode {
    pub key: String,
    pub node_id: String,
    pub scope: String,
}

/// A full-canvas rectangle, validated before any numeric conversion.
#[napi(object, object_to_js = false)]
pub struct NativeTuiBox {
    pub node_key: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One chronological record or an update of an identified streaming/progress record.
#[napi(object, object_to_js = false)]
pub struct NativeTuiTrace {
    pub node_key: Option<String>,
    pub text: String,
    pub record_id: Option<String>,
    #[napi(ts_type = "\"append\" | \"replace\"")]
    pub mode: Option<String>,
    #[napi(ts_type = "\"normal\" | \"thinking\" | \"error\"")]
    pub tone: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Exit {
    Dismissed,
    Interrupted,
    Closed,
}

impl Exit {
    fn name(self) -> &'static str {
        match self {
            Self::Dismissed => "dismissed",
            Self::Interrupted => "interrupted",
            Self::Closed => "closed",
        }
    }
}

#[derive(Default)]
struct Progress {
    drawn: u64,
    ended: Option<std::result::Result<Exit, String>>,
}

struct Shared {
    model: Mutex<Model>,
    progress: watch::Sender<Progress>,
    failure: watch::Sender<Option<String>>,
    fenced: AtomicBool,
    close_requested: AtomicBool,
    exit_requested: AtomicBool,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Shared {
    fn new(name: String) -> Arc<Self> {
        Arc::new(Self {
            model: Mutex::new(Model::new(name)),
            progress: watch::channel(Progress::default()).0,
            failure: watch::channel(None).0,
            fenced: AtomicBool::new(false),
            close_requested: AtomicBool::new(false),
            exit_requested: AtomicBool::new(false),
            worker: Mutex::new(None),
        })
    }

    fn lock(&self) -> std::result::Result<MutexGuard<'_, Model>, String> {
        self.model.lock().map_err(|_| {
            let error = "TUI display model lock is poisoned".to_owned();
            self.fail(error.clone());
            error
        })
    }

    fn fail(&self, error: String) {
        self.fenced.store(true, Ordering::Release);
        self.failure.send_if_modified(|first| {
            if first.is_some() {
                false
            } else {
                *first = Some(error);
                true
            }
        });
    }

    fn update(&self, update: impl FnOnce(&mut Model) -> std::result::Result<(), String>) -> Result<()> {
        if self.fenced.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut model = self.lock().map_err(Error::from_reason)?;
        if self.fenced.load(Ordering::Acquire) {
            return Ok(());
        }
        update(&mut model).map_err(Error::from_reason)
    }

    fn begin_finish(&self) {
        if self.fenced.swap(true, Ordering::AcqRel) {
            return;
        }
        match self.lock() {
            Ok(mut model) => model.finish(),
            Err(error) => self.fail(error),
        }
    }

    fn begin_close(&self) {
        self.fenced.store(true, Ordering::Release);
        self.exit_requested.store(true, Ordering::Release);
        self.close_requested.store(true, Ordering::Release);
    }

    fn acknowledge(&self, generation: u64) {
        self.progress.send_modify(|progress| progress.drawn = progress.drawn.max(generation));
    }

    fn dirty(&self) -> std::result::Result<bool, String> {
        let generation = self.lock()?.generation;
        Ok(generation > self.progress.borrow().drawn)
    }

    fn barrier(&self) -> std::result::Result<u64, String> {
        if self.progress.borrow().ended.is_some() {
            return Ok(0);
        }
        Ok(self.lock()?.generation)
    }

    async fn wait_draw(&self, generation: u64) -> std::result::Result<(), String> {
        let mut progress = self.progress.subscribe();
        loop {
            {
                let state = progress.borrow_and_update();
                if let Some(ended) = &state.ended {
                    return ended.as_ref().map(|_| ()).map_err(Clone::clone);
                }
                // A latched failure is published only after terminal restoration.
                if self.failure.borrow().is_none() && !self.exit_requested.load(Ordering::Acquire) && state.drawn >= generation {
                    return Ok(());
                }
            }
            progress.changed().await.map_err(|_| "TUI worker ended without completion".to_owned())?;
        }
    }

    async fn wait_exit(&self) -> std::result::Result<Exit, String> {
        let mut progress = self.progress.subscribe();
        let result = loop {
            if let Some(ended) = &progress.borrow_and_update().ended {
                break ended.clone();
            }
            progress.changed().await.map_err(|_| "TUI worker ended without completion".to_owned())?;
        };
        // Completion is published after restoration; only the thread's return remains to join.
        let worker = self.worker.lock()
            .map_err(|_| "TUI worker handle lock is poisoned".to_owned())?.take();
        if let Some(worker) = worker {
            worker.join().map_err(|_| "TUI worker panicked".to_owned())?;
        }
        result
    }
}

/// A single, exclusive Ratatui terminal session, independent of all tool/mux collections.
#[napi]
pub struct NativeTui {
    shared: Arc<Shared>,
}

#[napi]
impl NativeTui {
    /// Reserves stdin/stdout and opens the screen on one dedicated native thread.
    #[napi(factory)]
    pub async fn open(name: String) -> Result<Self> {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            return Err(Error::from_reason("TuiTracer requires an interactive terminal on stdin and stdout"));
        }
        let reservation = Reservation::acquire().map_err(Error::from_reason)?;
        let shared = Shared::new(name);
        let owned = Arc::clone(&shared);
        let (startup, started) = oneshot::channel();
        let worker = thread::Builder::new().name("junco-tui".into())
            .spawn(move || run_worker(owned, reservation, startup))
            .map_err(|error| Error::from_reason(format!("failed to spawn TUI worker: {error}")))?;
        match shared.worker.lock() {
            Ok(mut handle) => *handle = Some(worker),
            Err(_) => {
                shared.begin_close();
                let _ = worker.join();
                return Err(Error::from_reason("TUI worker handle lock is poisoned"));
            }
        }
        match started.await {
            Ok(Ok(())) => Ok(Self { shared }),
            Ok(Err(error)) => {
                let _ = shared.wait_exit().await;
                Err(Error::from_reason(error))
            }
            Err(_) => {
                shared.begin_close();
                let result = shared.wait_exit().await;
                Err(Error::from_reason(result.err().unwrap_or_else(|| "TUI startup ended without a result".into())))
            }
        }
    }

    /// Replaces drawing geometry while retaining identity metadata and colors.
    #[napi]
    pub fn set_graph(&self, nodes: Vec<NativeTuiNode>, lines: Vec<String>, boxes: Vec<NativeTuiBox>) -> Result<()> {
        self.shared.update(move |model| model.set_graph(nodes, lines, boxes))
    }

    /// Highlights only the caller's currently executing node.
    #[napi]
    pub fn set_active(&self, node_key: String, active: bool) -> Result<()> {
        self.shared.update(move |model| model.set_active(&node_key, active))
    }

    /// Appends or coalesces one bounded, styled trace record.
    #[napi]
    pub fn trace(&self, record: NativeTuiTrace) -> Result<()> {
        self.shared.update(move |model| model.trace(record))
    }

    /// A draw barrier only: keyboard dismissal is never required.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn flush<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
        let shared = Arc::clone(&self.shared);
        let generation = shared.barrier();
        env.spawn_future_with_callback(async move {
            match generation {
                Ok(generation) => shared.wait_draw(generation).await.map_err(Error::from_reason),
                Err(error) => {
                    let _ = shared.wait_exit().await;
                    Err(Error::from_reason(error))
                }
            }
        }, |_, ()| Ok(()))
    }

    /// Marks completion on invocation; retains the final frame until q/Esc.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn finish<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
        self.shared.begin_finish();
        let shared = Arc::clone(&self.shared);
        env.spawn_future_with_callback(async move {
            shared.wait_exit().await.map(|_| ()).map_err(Error::from_reason)
        }, |_, ()| Ok(()))
    }

    /// Observes the same restored/joined completion as finish and close.
    #[napi(ts_return_type = "Promise<\"dismissed\" | \"interrupted\" | \"closed\">")]
    pub fn wait_for_exit<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, String>> {
        let shared = Arc::clone(&self.shared);
        env.spawn_future_with_callback(async move {
            shared.wait_exit().await.map(|exit| exit.name().to_owned()).map_err(Error::from_reason)
        }, |_, exit| Ok(exit))
    }

    /// Fences updates immediately and restores without requiring dismissal; idempotent.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn close<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
        self.shared.begin_close();
        let shared = Arc::clone(&self.shared);
        env.spawn_future_with_callback(async move {
            shared.wait_exit().await.map(|_| ()).map_err(Error::from_reason)
        }, |_, ()| Ok(()))
    }
}

impl Drop for NativeTui {
    fn drop(&mut self) {
        self.shared.begin_close();
    }
}

struct Reservation;

impl Reservation {
    fn acquire() -> std::result::Result<Self, String> {
        TERMINAL_OWNED.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "A TUI session already owns this terminal".to_owned())
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        TERMINAL_OWNED.store(false, Ordering::Release);
    }
}

struct Restoration {
    _reservation: Reservation,
    raw: bool,
    alternate: bool,
    cursor: bool,
}

impl Restoration {
    fn new(reservation: Reservation) -> Self {
        Self { _reservation: reservation, raw: false, alternate: false, cursor: false }
    }

    fn enter(&mut self) -> io::Result<Terminal<CrosstermBackend<io::Stdout>>> {
        if !is_raw_mode_enabled()? {
            self.raw = true;
            enable_raw_mode()?;
        }
        // Set before each command: even partial writes must be rolled back.
        self.alternate = true;
        execute!(io::stdout(), EnterAlternateScreen)?;
        self.cursor = true;
        execute!(io::stdout(), Hide)?;
        Terminal::new(CrosstermBackend::new(io::stdout()))
    }

    fn restore(&mut self) -> io::Result<()> {
        let mut first = None;
        if self.cursor {
            match execute!(io::stdout(), Show) {
                Ok(()) => self.cursor = false,
                Err(error) => first = Some(error),
            }
        }
        if self.alternate {
            match execute!(io::stdout(), LeaveAlternateScreen) {
                Ok(()) => self.alternate = false,
                Err(error) => { first.get_or_insert(error); }
            }
        }
        if self.raw {
            match disable_raw_mode() {
                Ok(()) => self.raw = false,
                Err(error) => { first.get_or_insert(error); }
            }
        }
        first.map_or(Ok(()), Err)
    }
}

impl Drop for Restoration {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

fn run_worker(shared: Arc<Shared>, reservation: Reservation, startup: oneshot::Sender<std::result::Result<(), String>>) {
    let mut startup = Some(startup);
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let mut restoration = Restoration::new(reservation);
        let session = (|| {
            let mut terminal = restoration.enter().map_err(|error| format!("failed to initialize TUI terminal: {error}"))?;
            draw(&mut terminal, &shared)?;
            if let Some(startup) = startup.take() {
                if startup.send(Ok(())).is_err() {
                    return Ok(Exit::Closed);
                }
            }
            display_loop(&mut terminal, &shared)
        })();
        if let Err(error) = &session {
            shared.fail(error.clone());
        }
        let restored = restoration.restore().map_err(|error| format!("failed to restore TUI terminal: {error}"));
        drop(restoration); // Release terminal ownership only after all restoration attempts.
        if let Err(error) = restored {
            shared.fail(error);
        }
        session
    }));
    if outcome.is_err() {
        shared.fail("TUI worker panicked".into());
    }
    shared.fenced.store(true, Ordering::Release);
    shared.exit_requested.store(true, Ordering::Release);
    let ended = match shared.failure.borrow().as_ref() {
        Some(error) => Err(error.clone()),
        None => outcome.unwrap_or_else(|_| Err("TUI worker panicked".into())),
    };
    shared.progress.send_modify(|progress| progress.ended = Some(ended.clone()));
    if let Some(startup) = startup {
        let _ = startup.send(Err(ended.err().unwrap_or_else(|| "TUI startup closed".into())));
    }
}

fn display_loop(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>, shared: &Shared) -> std::result::Result<Exit, String> {
    let mut dismissal = None;
    loop {
        if let Some(error) = shared.failure.borrow().as_ref() {
            return Err(error.clone());
        }
        if shared.close_requested.load(Ordering::Acquire) {
            return Ok(Exit::Closed);
        }
        if shared.dirty()? {
            draw(terminal, shared)?;
        }
        if let Some(exit) = dismissal {
            // A completion/dismissal race cannot skip the final dirty generation.
            if !shared.dirty()? {
                return Ok(exit);
            }
            continue;
        }
        if !event::poll(POLL_WAIT).map_err(|error| format!("TUI input polling failed: {error}"))? {
            continue;
        }
        let input = event::read().map_err(|error| format!("TUI input failed: {error}"))?;
        match input {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
                    shared.fenced.store(true, Ordering::Release);
                    shared.exit_requested.store(true, Ordering::Release);
                    return Ok(Exit::Interrupted);
                }
                if matches!(key.code, KeyCode::Char('q') | KeyCode::Esc) {
                    shared.fenced.store(true, Ordering::Release);
                    shared.exit_requested.store(true, Ordering::Release);
                    dismissal = Some(Exit::Dismissed);
                } else {
                    shared.lock()?.key(key.code);
                }
            }
            Event::Resize(_, _) => shared.lock()?.changed(),
            _ => {}
        }
    }
}

// The lock ends inside the callback, before Terminal performs its diff/output I/O.
fn draw<B: Backend>(terminal: &mut Terminal<B>, shared: &Shared) -> std::result::Result<u64, String> {
    let mut generation = 0;
    let mut failure = None;
    terminal.draw(|frame| match render_frame(frame, shared) {
        Ok(rendered) => generation = rendered,
        Err(error) => failure = Some(error),
    }).map_err(|error| format!("TUI rendering failed: {error}"))?;
    if let Some(error) = failure {
        return Err(error);
    }
    shared.acknowledge(generation);
    Ok(generation)
}

fn render_frame(frame: &mut Frame<'_>, shared: &Shared) -> std::result::Result<u64, String> {
    let mut model = shared.lock()?;
    model.render(frame);
    Ok(model.generation)
}

struct Node {
    badge: String,
    color: Color,
    active: bool,
}

struct NodeBox {
    node: usize,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tone { Normal, Thinking, Error }

impl Tone {
    fn parse(tone: Option<&str>) -> std::result::Result<Self, String> {
        match tone {
            None | Some("normal") => Ok(Self::Normal),
            Some("thinking") => Ok(Self::Thinking),
            Some("error") => Ok(Self::Error),
            Some(other) => Err(format!("Invalid TUI trace tone: {other}")),
        }
    }

    fn style(self) -> Style {
        match self {
            Self::Normal => Style::default(),
            Self::Thinking => Style::default().add_modifier(Modifier::DIM),
            Self::Error => Style::default().fg(Color::Red),
        }
    }
}

type RecordKey = (Option<String>, String);

struct Record {
    serial: u64,
    key: Option<RecordKey>,
    badge: String,
    color: Color,
    body: String,
    tone: Tone,
    truncated: bool,
    paragraph: Paragraph<'static>,
    bytes: usize,
    wrapped_width: u16,
    height: usize,
    offset: u16,
}

impl Record {
    fn format(&mut self) {
        let mut lines = Vec::new();
        for (index, line) in self.body.split('\n').enumerate() {
            let mut spans = Vec::with_capacity(if index == 0 { 2 } else { 1 });
            if index == 0 {
                spans.push(Span::styled(self.badge.clone(), Style::default().fg(self.color)));
            }
            spans.push(Span::styled(line.to_owned(), self.tone.style()));
            lines.push(Line::from(spans));
        }
        self.bytes = self.badge.len() + self.body.len();
        self.paragraph = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
        self.wrapped_width = 0;
        self.offset = 0;
    }

    fn wrap(&mut self, width: u16) {
        if self.wrapped_width != width {
            self.height = self.paragraph.line_count(width).max(1);
            self.wrapped_width = width;
        }
    }

    fn scroll(&mut self, offset: u16) {
        if self.offset != offset {
            self.paragraph = std::mem::take(&mut self.paragraph).scroll((offset, 0));
            self.offset = offset;
        }
    }
}

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct Scroll {
    serial: u64,
    line: u16,
}

struct Model {
    name: String,
    generation: u64,
    finished: bool,
    nodes: Vec<Node>,
    node_index: HashMap<String, usize>,
    colors: HashSet<(u8, u8, u8)>,
    lines: Vec<String>,
    boxes: Vec<NodeBox>,
    canvas_width: u64,
    canvas_height: u64,
    pan_x: u64,
    pan_y: u64,
    graph_area: Rect,
    trace_area: Rect,
    wrapped_width: u16,
    wrapping_dirty: bool,
    total_height: usize,
    tail_height: u16,
    trace_focus: bool,
    graph_title: String,
    trace_title: String,
    records: VecDeque<Record>,
    record_index: HashMap<RecordKey, u64>,
    next_serial: u64,
    bytes: usize,
    omitted: u64,
    follow: bool,
    scroll: Scroll,
}

impl Model {
    fn new(name: String) -> Self {
        let mut model = Self {
            name: escape(name), generation: 1, finished: false,
            nodes: Vec::new(), node_index: HashMap::new(), colors: HashSet::new(),
            lines: vec!["(empty graph)".into()], boxes: Vec::new(),
            canvas_width: 13, canvas_height: 1, pan_x: 0, pan_y: 0,
            graph_area: Rect::default(), trace_area: Rect::default(), trace_focus: false,
            graph_title: String::new(), trace_title: String::new(),
            records: VecDeque::new(), record_index: HashMap::new(), next_serial: 1,
            bytes: 0, omitted: 0, follow: true, scroll: Scroll::default(),
            wrapped_width: 0, wrapping_dirty: true, total_height: 0, tail_height: 0,
        };
        model.titles();
        model
    }

    fn changed(&mut self) {
        self.generation = self.generation.saturating_add(1);
    }

    fn titles(&mut self) {
        self.graph_title.clear();
        self.graph_title.push_str("JuncoGraph");
        if !self.name.is_empty() {
            self.graph_title.push_str(" — ");
            self.graph_title.push_str(&self.name);
        }
        if self.finished {
            self.graph_title.push_str(" | complete");
        }
        let mut first = true;
        for node in &self.nodes {
            if node.active {
                self.graph_title.push_str(if first { " | active: " } else { ", " });
                self.graph_title.push_str(node.badge.trim());
                first = false;
            }
        }
        self.graph_title.push_str(if self.trace_focus { " | Tab: focus; q/Esc: dismiss" } else { " | focused: arrows/page/home/end pan; Tab; q/Esc" });
        self.trace_title.clear();
        self.trace_title.push_str("Agent traces");
        if !self.name.is_empty() {
            self.trace_title.push_str(" — ");
            self.trace_title.push_str(&self.name);
        }
        if self.omitted != 0 {
            let _ = write!(self.trace_title, " | {} omitted", self.omitted);
        }
        self.trace_title.push_str(if self.follow { " | following" } else { " | paused" });
        self.trace_title.push_str(if self.trace_focus { " | focused: arrows/page/home/end scroll; Tab; q/Esc" } else { " | Tab: focus; q/Esc: dismiss" });
    }

    fn color(&mut self, key: &str) -> Color {
        let rgb = if self.nodes.len() < PALETTE.len() {
            PALETTE[self.nodes.len()]
        } else {
            let mut salt = 0u64;
            loop {
                let mut hash = DefaultHasher::new();
                (key, salt).hash(&mut hash);
                let bytes = hash.finish().to_le_bytes();
                let scale = |byte: u8| 64 + (u16::from(byte) * 191 / 255) as u8;
                let rgb = (scale(bytes[0]), scale(bytes[1]), scale(bytes[2]));
                if !self.colors.contains(&rgb) { break rgb; }
                salt = salt.wrapping_add(1);
            }
        };
        self.colors.insert(rgb);
        Color::Rgb(rgb.0, rgb.1, rgb.2)
    }

    fn set_graph(&mut self, nodes: Vec<NativeTuiNode>, lines: Vec<String>, boxes: Vec<NativeTuiBox>) -> std::result::Result<(), String> {
        // Validate the whole replacement before altering any retained metadata.
        let keys: HashSet<&str> = nodes.iter().map(|node| node.key.as_str()).collect();
        let mut geometry = Vec::with_capacity(boxes.len());
        for rect in boxes {
            if !keys.contains(rect.node_key.as_str()) && !self.node_index.contains_key(&rect.node_key) {
                return Err(format!("Unknown TUI node key: {}", rect.node_key));
            }
            let x = coordinate(rect.x, false)?;
            let y = coordinate(rect.y, false)?;
            let width = coordinate(rect.width, true)?;
            let height = coordinate(rect.height, true)?;
            if x.checked_add(width).is_none() || y.checked_add(height).is_none() {
                return Err("Invalid TUI geometry: rectangle exceeds the coordinate range".into());
            }
            geometry.push((rect.node_key, x, y, width, height));
        }
        for node in nodes {
            let badge = format!("[{}:{}] ", escape(node.scope), escape(node.node_id));
            if let Some(&index) = self.node_index.get(&node.key) {
                self.nodes[index].badge = badge;
            } else {
                let color = self.color(&node.key);
                self.node_index.insert(node.key, self.nodes.len());
                self.nodes.push(Node { badge, color, active: false });
            }
        }
        self.boxes = geometry.into_iter().map(|(key, x, y, width, height)| NodeBox {
            node: self.node_index[&key], x, y, width, height,
        }).collect();
        self.lines = if lines.is_empty() { vec!["(empty graph)".into()] } else {
            lines.into_iter().map(escape).collect()
        };
        self.canvas_width = self.lines.iter().map(|line| Line::raw(line.as_str()).width() as u64).max().unwrap_or(0);
        self.canvas_height = self.lines.len() as u64;
        self.clamp_pan();
        self.titles();
        self.changed();
        Ok(())
    }

    fn set_active(&mut self, key: &str, active: bool) -> std::result::Result<(), String> {
        let index = *self.node_index.get(key).ok_or_else(|| format!("Unknown TUI node key: {key}"))?;
        if self.nodes[index].active != active {
            self.nodes[index].active = active;
            self.titles();
            self.changed();
        }
        Ok(())
    }

    fn finish(&mut self) {
        self.finished = true;
        for node in &mut self.nodes { node.active = false; }
        self.titles();
        self.changed();
    }

    fn trace(&mut self, trace: NativeTuiTrace) -> std::result::Result<(), String> {
        let replace = match trace.mode.as_deref() {
            None | Some("append") => false,
            Some("replace") => true,
            Some(other) => return Err(format!("Invalid TUI trace mode: {other}")),
        };
        let tone = Tone::parse(trace.tone.as_deref())?;
        let node = match trace.node_key.as_ref() {
            Some(key) => Some(&self.nodes[*self.node_index.get(key).ok_or_else(|| format!("Unknown TUI node key: {key}"))?]),
            None => None,
        };
        let key = trace.record_id.map(|id| (trace.node_key, id));
        let existing = key.as_ref().and_then(|key| self.record_index.get(key)).copied()
            .and_then(|serial| self.record_offset(serial));
        if let Some(index) = existing {
            let record = &mut self.records[index];
            self.bytes -= record.bytes;
            if replace {
                record.body.clear();
                record.truncated = false;
            }
            append_escaped(&mut record.body, &trace.text, ENTRY_BYTES - record.badge.len(), &mut record.truncated);
            record.tone = tone;
            record.format();
            self.bytes += record.bytes;
        } else {
            let (badge, color) = node.map_or_else(|| ("[system] ".to_owned(), Color::Gray), |node| (node.badge.clone(), node.color));
            let mut record = Record {
                serial: self.next_serial, key, badge: capped_badge(badge), color,
                body: String::new(), tone, truncated: false,
                paragraph: Paragraph::default(), bytes: 0, wrapped_width: 0, height: 1, offset: 0,
            };
            append_escaped(&mut record.body, &trace.text, ENTRY_BYTES - record.badge.len(), &mut record.truncated);
            record.format();
            self.next_serial = self.next_serial.checked_add(1).ok_or_else(|| "TUI record serial exhausted".to_owned())?;
            if let Some(key) = &record.key { self.record_index.insert(key.clone(), record.serial); }
            self.bytes += record.bytes;
            self.records.push_back(record);
        }
        while self.bytes > HISTORY_BYTES || self.records.len() > HISTORY_RECORDS {
            if let Some(record) = self.records.pop_front() {
                self.bytes -= record.bytes;
                if let Some(key) = record.key { self.record_index.remove(&key); }
                self.omitted = self.omitted.saturating_add(1);
            }
        }
        self.wrapping_dirty = true;
        self.clamp_scroll();
        self.titles();
        self.changed();
        Ok(())
    }

    fn record_offset(&self, serial: u64) -> Option<usize> {
        let offset = serial.checked_sub(self.records.front()?.serial)?;
        let offset = usize::try_from(offset).ok()?;
        (offset < self.records.len()).then_some(offset)
    }

    fn clamp_pan(&mut self) {
        self.pan_x = self.pan_x.min(self.canvas_width.saturating_sub(u64::from(self.graph_area.width)));
        self.pan_y = self.pan_y.min(self.canvas_height.saturating_sub(u64::from(self.graph_area.height)));
    }

    fn clamp_scroll(&mut self) {
        let Some(first) = self.records.front() else { self.scroll = Scroll::default(); return; };
        if self.record_offset(self.scroll.serial).is_none() {
            self.scroll = Scroll { serial: first.serial, line: 0 };
        }
        if let Some(index) = self.record_offset(self.scroll.serial) {
            self.scroll.line = self.scroll.line.min(u16::try_from(self.records[index].height.saturating_sub(1)).unwrap_or(u16::MAX));
        }
    }

    fn wrap_records(&mut self) {
        let width = self.trace_area.width;
        if width == 0 { return; }
        let changed = self.wrapping_dirty || self.wrapped_width != width;
        if changed {
            self.total_height = 0;
            for record in &mut self.records {
                record.wrap(width);
                self.total_height += record.height;
            }
            self.wrapped_width = width;
            self.wrapping_dirty = false;
            self.clamp_scroll();
        }
        if self.follow && (changed || self.tail_height != self.trace_area.height) {
            self.tail();
            self.tail_height = self.trace_area.height;
        }
    }

    fn scroll_position(&self) -> usize {
        let mut line = 0;
        for record in &self.records {
            if record.serial == self.scroll.serial { return line + usize::from(self.scroll.line); }
            line += record.height;
        }
        0
    }

    fn position(&mut self, mut line: usize) {
        for record in &self.records {
            if line < record.height {
                self.scroll = Scroll { serial: record.serial, line: u16::try_from(line).unwrap_or(u16::MAX) };
                return;
            }
            line -= record.height;
        }
        if let Some(last) = self.records.back() {
            self.scroll = Scroll { serial: last.serial, line: u16::try_from(last.height.saturating_sub(1)).unwrap_or(u16::MAX) };
        }
    }

    fn tail(&mut self) {
        self.position(self.total_height.saturating_sub(usize::from(self.trace_area.height)));
    }

    fn key(&mut self, key: KeyCode) {
        if key == KeyCode::Tab {
            self.trace_focus = !self.trace_focus;
        } else if self.trace_focus {
            self.wrap_records();
            let max = self.total_height.saturating_sub(usize::from(self.trace_area.height));
            let current = self.scroll_position();
            let page = usize::from(self.trace_area.height).max(1);
            let line = match key {
                KeyCode::Up | KeyCode::Left => current.saturating_sub(1),
                KeyCode::Down | KeyCode::Right => current.saturating_add(1).min(max),
                KeyCode::PageUp => current.saturating_sub(page),
                KeyCode::PageDown => current.saturating_add(page).min(max),
                KeyCode::Home => 0,
                KeyCode::End => { self.follow = true; self.tail(); self.titles(); self.changed(); return; }
                _ => return,
            };
            self.follow = false;
            self.position(line.min(max));
        } else {
            let page = u64::from(self.graph_area.height).max(1);
            match key {
                KeyCode::Up => self.pan_y = self.pan_y.saturating_sub(1),
                KeyCode::Down => self.pan_y = self.pan_y.saturating_add(1),
                KeyCode::Left => self.pan_x = self.pan_x.saturating_sub(1),
                KeyCode::Right => self.pan_x = self.pan_x.saturating_add(1),
                KeyCode::PageUp => self.pan_y = self.pan_y.saturating_sub(page),
                KeyCode::PageDown => self.pan_y = self.pan_y.saturating_add(page),
                KeyCode::Home => { self.pan_x = 0; self.pan_y = 0; }
                KeyCode::End => { self.pan_x = self.canvas_width; self.pan_y = self.canvas_height; }
                _ => return,
            }
            self.clamp_pan();
        }
        self.titles();
        self.changed();
    }

    fn render(&mut self, frame: &mut Frame<'_>) {
        let [graph, traces] = Layout::vertical([Constraint::Percentage(40), Constraint::Percentage(60)]).areas(frame.area());
        let graph_block = Block::bordered().title(self.graph_title.as_str())
            .border_style(if self.trace_focus { Style::default() } else { Style::default().add_modifier(Modifier::BOLD) });
        let trace_block = Block::bordered().title(self.trace_title.as_str())
            .border_style(if self.trace_focus { Style::default().add_modifier(Modifier::BOLD) } else { Style::default() });
        self.graph_area = graph_block.inner(graph);
        self.trace_area = trace_block.inner(traces);
        frame.render_widget(graph_block, graph);
        frame.render_widget(trace_block, traces);
        self.clamp_pan();
        self.render_graph(frame.buffer_mut());
        self.wrap_records();
        if self.records.is_empty() {
            frame.render_widget(Paragraph::new("(no traces yet)"), self.trace_area);
            return;
        }
        let Some(start) = self.record_offset(self.scroll.serial) else { return; };
        let mut y = self.trace_area.y;
        let bottom = self.trace_area.bottom();
        for (index, record) in self.records.iter_mut().enumerate().skip(start) {
            if y >= bottom { break; }
            let offset = if index == start { self.scroll.line } else { 0 };
            record.scroll(offset);
            let height = record.height.saturating_sub(usize::from(offset)).min(usize::from(bottom - y));
            let height = u16::try_from(height).unwrap_or(bottom - y);
            frame.render_widget(&record.paragraph, Rect::new(self.trace_area.x, y, self.trace_area.width, height));
            y += height;
        }
    }

    fn render_graph(&self, buffer: &mut Buffer) {
        let area = self.graph_area;
        if area.is_empty() { return; }
        for row in 0..area.height {
            let index = self.pan_y.saturating_add(u64::from(row));
            let Some(line) = usize::try_from(index).ok().and_then(|index| self.lines.get(index)) else { break; };
            let mut x = 0u64;
            for character in line.chars() {
                let mut encoded = [0u8; 4];
                let text = character.encode_utf8(&mut encoded);
                let width = Span::raw(&*text).width() as u64;
                let end = x.saturating_add(width);
                if x >= self.pan_x && end <= self.pan_x + u64::from(area.width) {
                    let column = u16::try_from(x - self.pan_x).unwrap_or(area.width);
                    if column < area.width {
                        buffer.set_stringn(area.x + column, area.y + row, &*text, usize::from(area.width - column), Style::default());
                    }
                }
                x = end;
                if x >= self.pan_x + u64::from(area.width) { break; }
            }
        }
        let right = self.pan_x + u64::from(area.width);
        let bottom = self.pan_y + u64::from(area.height);
        for rect in &self.boxes {
            let left = u64::from(rect.x).max(self.pan_x);
            let top = u64::from(rect.y).max(self.pan_y);
            let clipped_right = (u64::from(rect.x) + u64::from(rect.width)).min(right);
            let clipped_bottom = (u64::from(rect.y) + u64::from(rect.height)).min(bottom);
            if left >= clipped_right || top >= clipped_bottom { continue; }
            // All conversion happens after intersection with the u16 viewport.
            let viewport = Rect::new(
                area.x + u16::try_from(left - self.pan_x).unwrap_or(0),
                area.y + u16::try_from(top - self.pan_y).unwrap_or(0),
                u16::try_from(clipped_right - left).unwrap_or(0),
                u16::try_from(clipped_bottom - top).unwrap_or(0),
            );
            let node = &self.nodes[rect.node];
            let style = if node.active { Style::default().fg(Color::Green).add_modifier(Modifier::BOLD) }
                else { Style::default().fg(node.color) };
            buffer.set_style(viewport, style);
        }
    }
}

fn coordinate(value: f64, positive: bool) -> std::result::Result<u32, String> {
    let minimum = if positive { 1.0 } else { 0.0 };
    if !value.is_finite() || value.fract() != 0.0 || value < minimum || value > f64::from(u32::MAX) {
        return Err("Invalid TUI geometry: coordinates must be non-negative integers and sizes positive integers within the u32 range".into());
    }
    Ok(value as u32)
}

fn escape(text: String) -> String {
    if !text.chars().any(char::is_control) { return text; }
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\t' => escaped.push_str("    "),
            character if character.is_control() => {
                let _ = write!(escaped, "\\u{:04X}", u32::from(character));
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn utf8_prefix(text: &str, mut bytes: usize) -> &str {
    bytes = bytes.min(text.len());
    while !text.is_char_boundary(bytes) { bytes -= 1; }
    &text[..bytes]
}

fn capped_badge(mut badge: String) -> String {
    let max = ENTRY_BYTES - TRUNCATED.len() - 1;
    if badge.len() > max {
        let length = utf8_prefix(&badge, max - TRUNCATED.len()).len();
        badge.truncate(length);
        badge.push_str(TRUNCATED);
        badge.push(' ');
    }
    badge
}

// Escape directly into the bounded entry, never allocate an unbounded delta copy.
fn append_escaped(body: &mut String, text: &str, max: usize, truncated: &mut bool) {
    if *truncated { return; }
    for character in text.chars() {
        let bytes = match character {
            '\t' => 4,
            '\n' => 1,
            character if character.is_control() => 6,
            character => character.len_utf8(),
        };
        if body.len() + bytes > max {
            let length = utf8_prefix(body, max.saturating_sub(TRUNCATED.len())).len();
            body.truncate(length);
            body.push_str(TRUNCATED);
            *truncated = true;
            break;
        }
        match character {
            '\n' => body.push('\n'),
            '\t' => body.push_str("    "),
            character if character.is_control() => { let _ = write!(body, "\\u{:04X}", u32::from(character)); }
            character => body.push(character),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    fn node(key: &str, id: &str, scope: &str) -> NativeTuiNode {
        NativeTuiNode { key: key.into(), node_id: id.into(), scope: scope.into() }
    }

    fn rect(key: &str, x: f64, y: f64, width: f64, height: f64) -> NativeTuiBox {
        NativeTuiBox { node_key: key.into(), x, y, width, height }
    }

    fn record(key: Option<&str>, text: &str, id: Option<&str>, mode: Option<&str>, tone: Option<&str>) -> NativeTuiTrace {
        NativeTuiTrace {
            node_key: key.map(str::to_owned), text: text.into(), record_id: id.map(str::to_owned),
            mode: mode.map(str::to_owned), tone: tone.map(str::to_owned),
        }
    }

    fn scene() -> Arc<Shared> {
        let shared = Shared::new("test".into());
        shared.update(|model| model.set_graph(
            vec![node("alpha", "Alpha", "g1"), node("beta", "Beta", "g1")],
            vec![
                "+-------+           +------+".into(),
                "| Alpha |----edge-->| Beta |".into(),
                "+-------+           +------+".into(),
            ],
            vec![rect("alpha", 0.0, 0.0, 9.0, 3.0), rect("beta", 20.0, 0.0, 8.0, 3.0)],
        )).unwrap();
        shared
    }

    fn test_terminal(width: u16, height: u16) -> Terminal<TestBackend> {
        Terminal::new(TestBackend::new(width, height)).unwrap()
    }

    fn row(buffer: &Buffer, y: u16) -> String {
        (0..buffer.area.width).map(|x| buffer[(x, y)].symbol()).collect()
    }

    fn visible(buffer: &Buffer, area: Rect) -> String {
        let mut text = String::new();
        for y in area.y..area.bottom() {
            for x in area.x..area.right() { text.push_str(buffer[(x, y)].symbol()); }
            text.push('\n');
        }
        text
    }

    fn cell_for<'a>(buffer: &'a Buffer, text: &str) -> &'a ratatui::buffer::Cell {
        for y in (0..buffer.area.height).rev() {
            let line = row(buffer, y);
            if let Some(byte) = line.find(text) {
                let x = u16::try_from(line[..byte].chars().count()).unwrap();
                return &buffer[(x, y)];
            }
        }
        panic!("missing visible text: {text}");
    }

    #[test]
    fn two_panes_preserve_topology_and_highlight_only_active_intervals() {
        let shared = scene();
        let mut terminal = test_terminal(100, 30);
        draw(&mut terminal, &shared).unwrap();
        let graph_area = shared.lock().unwrap().graph_area;
        let trace_area = shared.lock().unwrap().trace_area;
        assert_eq!(graph_area, Rect::new(1, 1, 98, 10));
        assert_eq!(trace_area, Rect::new(1, 13, 98, 16));
        assert!(row(terminal.backend().buffer(), 0).contains("JuncoGraph"));
        assert!(row(terminal.backend().buffer(), 12).contains("Agent traces"));
        let topology = visible(terminal.backend().buffer(), graph_area);
        let colors = {
            let model = shared.lock().unwrap();
            (model.nodes[0].color, model.nodes[1].color)
        };
        assert_ne!(colors.0, colors.1);
        assert_eq!(terminal.backend().buffer()[(3, 2)].fg, colors.0);
        assert_eq!(terminal.backend().buffer()[(23, 2)].fg, colors.1);

        shared.update(|model| { model.set_active("alpha", true)?; model.set_active("beta", true) }).unwrap();
        shared.update(|model| {
            model.trace(record(Some("alpha"), "alpha ", Some("message"), None, None))?;
            model.trace(record(Some("beta"), "beta text", Some("message"), None, None))?;
            model.trace(record(Some("alpha"), "text", Some("message"), None, None))
        }).unwrap();
        draw(&mut terminal, &shared).unwrap();
        for coordinate in [(3, 2), (23, 2)] {
            let cell = &terminal.backend().buffer()[coordinate];
            assert_eq!(cell.fg, Color::Green);
            assert!(cell.modifier.contains(Modifier::BOLD));
        }
        assert!(row(terminal.backend().buffer(), 0).contains("[g1:Alpha]"));
        assert!(row(terminal.backend().buffer(), 0).contains("[g1:Beta]"));
        assert_eq!(cell_for(terminal.backend().buffer(), "[g1:Alpha]").fg, colors.0);
        assert_eq!(cell_for(terminal.backend().buffer(), "[g1:Beta]").fg, colors.1);
        assert!(visible(terminal.backend().buffer(), trace_area).contains("alpha text"));
        assert!(visible(terminal.backend().buffer(), trace_area).contains("beta text"));
        assert_eq!(visible(terminal.backend().buffer(), graph_area), topology);
        assert_eq!(shared.lock().unwrap().records.len(), 2);

        // Yield/end clears one activation without clearing its concurrently running peer.
        shared.update(|model| model.set_active("alpha", false)).unwrap();
        draw(&mut terminal, &shared).unwrap();
        assert_eq!(terminal.backend().buffer()[(3, 2)].fg, colors.0);
        assert_eq!(terminal.backend().buffer()[(23, 2)].fg, Color::Green);
        shared.update(|model| {
            model.set_active("beta", false)?;
            model.trace(record(Some("beta"), "failed", None, None, Some("error")))
        }).unwrap();
        draw(&mut terminal, &shared).unwrap();
        assert_eq!(terminal.backend().buffer()[(23, 2)].fg, colors.1);
        assert!(!terminal.backend().buffer().content.iter().any(|cell| cell.fg == Color::Green));
        assert_eq!(cell_for(terminal.backend().buffer(), "failed").fg, Color::Red);
        assert_eq!(visible(terminal.backend().buffer(), graph_area), topology);
    }

    #[test]
    fn duplicate_local_ids_keep_distinct_scoped_badges_and_stable_colors() {
        let shared = Shared::new(String::new());
        shared.update(|model| model.set_graph(
            vec![node("[1,\"A\"]", "A", "g1"), node("[2,\"A\"]", "A", "g2")],
            vec!["A --> A".into()],
            vec![rect("[1,\"A\"]", 0.0, 0.0, 1.0, 1.0), rect("[2,\"A\"]", 6.0, 0.0, 1.0, 1.0)],
        )).unwrap();
        shared.update(|model| {
            model.trace(record(Some("[1,\"A\"]"), "first", Some("same-id"), None, None))?;
            model.trace(record(Some("[2,\"A\"]"), "second", Some("same-id"), None, None))
        }).unwrap();
        let mut terminal = test_terminal(100, 30);
        draw(&mut terminal, &shared).unwrap();
        let first = cell_for(terminal.backend().buffer(), "[g1:A]").fg;
        let second = cell_for(terminal.backend().buffer(), "[g2:A]").fg;
        assert_ne!(first, second);
        shared.update(|model| model.set_graph(
            vec![node("[1,\"A\"]", "A", "new-scope")], vec!["A".into()],
            vec![rect("[1,\"A\"]", 0.0, 0.0, 1.0, 1.0)],
        )).unwrap();
        shared.update(|model| model.trace(record(Some("[2,\"A\"]"), " retained", Some("same-id"), None, None))).unwrap();
        draw(&mut terminal, &shared).unwrap();
        assert_eq!(cell_for(terminal.backend().buffer(), "[g1:A]").fg, first);
        assert_eq!(cell_for(terminal.backend().buffer(), "[g2:A]").fg, second);
        assert_eq!(terminal.backend().buffer()[(1, 1)].fg, first);
        let mut model = shared.lock().unwrap();
        let added = (0..100).map(|index| node(&format!("extra-{index}"), "A", "g3")).collect();
        model.set_graph(added, Vec::new(), Vec::new()).unwrap();
        assert_eq!(model.colors.len(), 102);
        assert_eq!(model.nodes[0].color, first);
        assert_eq!(model.nodes[1].color, second);
    }

    #[test]
    fn empty_topology_controls_and_body_tones_render_safely() {
        let shared = Shared::new("session\x1b\n\tname".into());
        let mut terminal = test_terminal(100, 30);
        draw(&mut terminal, &shared).unwrap();
        assert!(visible(terminal.backend().buffer(), shared.lock().unwrap().graph_area).contains("(empty graph)"));
        assert!(visible(terminal.backend().buffer(), shared.lock().unwrap().trace_area).contains("(no traces yet)"));
        assert!(!shared.lock().unwrap().graph_title.chars().any(char::is_control));
        shared.update(|model| {
            model.set_graph(vec![node("a", "A\x1b", "g1")], vec!["A\x1b".into()], vec![rect("a", 0.0, 0.0, 7.0, 1.0)])?;
            model.trace(record(Some("a"), "ideas\t\x1b[31m\r\u{0085}\n分析🤖", Some("thinking"), None, Some("thinking")))?;
            model.trace(record(None, "operational", None, None, None))
        }).unwrap();
        draw(&mut terminal, &shared).unwrap();
        let area = shared.lock().unwrap().trace_area;
        let text = visible(terminal.backend().buffer(), area);
        assert!(text.contains("ideas    \\u001B[31m\\u000D\\u0085"));
        let (x, y) = (area.y..area.bottom()).find_map(|y| {
            (area.x..area.right()).find(|&x| terminal.backend().buffer()[(x, y)].symbol() == "分").map(|x| (x, y))
        }).expect("Unicode body must remain visible");
        assert_eq!(terminal.backend().buffer()[(x + 2, y)].symbol(), "析");
        assert_eq!(terminal.backend().buffer()[(x + 4, y)].symbol(), "🤖");
        assert_eq!(cell_for(terminal.backend().buffer(), "[system]").fg, Color::Gray);
        assert!(cell_for(terminal.backend().buffer(), "ideas").modifier.contains(Modifier::DIM));
        assert!(!cell_for(terminal.backend().buffer(), "[g1:A\\u001B]").modifier.contains(Modifier::DIM));
        assert!(!terminal.backend().buffer().content.iter().any(|cell| cell.symbol().contains('\x1b')));
        shared.update(|model| model.trace(record(Some("a"), "broken", Some("thinking"), Some("replace"), Some("error")))).unwrap();
        draw(&mut terminal, &shared).unwrap();
        assert_eq!(cell_for(terminal.backend().buffer(), "broken").fg, Color::Red);
        assert_ne!(cell_for(terminal.backend().buffer(), "[g1:A\\u001B]").fg, Color::Red);
        assert!(!visible(terminal.backend().buffer(), area).contains("ideas"));
    }

    #[test]
    fn validates_geometry_and_unknown_record_fields_without_partial_graph_updates() {
        let mut model = Model::new(String::new());
        for value in [-1.0, 0.5, f64::NAN, f64::INFINITY, f64::from(u32::MAX) + 1.0] {
            assert!(model.set_graph(vec![node("a", "A", "g1")], vec!["A".into()], vec![rect("a", value, 0.0, 1.0, 1.0)]).is_err());
            assert!(model.nodes.is_empty());
        }
        for size in [0.0, -1.0, 0.5, f64::NAN, f64::INFINITY] {
            assert!(model.set_graph(vec![node("a", "A", "g1")], vec!["A".into()], vec![rect("a", 0.0, 0.0, size, 1.0)]).is_err());
            assert!(model.set_graph(vec![node("a", "A", "g1")], vec!["A".into()], vec![rect("a", 0.0, 0.0, 1.0, size)]).is_err());
        }
        assert!(model.set_graph(vec![node("a", "A", "g1")], Vec::new(), vec![rect("a", f64::from(u32::MAX), 0.0, 1.0, 1.0)]).is_err());
        assert!(model.set_graph(Vec::new(), Vec::new(), vec![rect("missing", 0.0, 0.0, 1.0, 1.0)]).is_err());
        assert!(model.set_active("missing", true).is_err());
        assert!(model.trace(record(Some("missing"), "x", None, None, None)).is_err());
        assert!(model.trace(record(None, "x", None, Some("unknown"), None)).is_err());
        assert!(model.trace(record(None, "x", None, None, Some("unknown"))).is_err());
        assert!(model.records.is_empty());
    }

    #[test]
    fn bounded_history_truncates_utf8_evicts_indexes_and_clamps_frozen_scroll() {
        let shared = Shared::new(String::new());
        shared.update(|model| {
            for index in 0..=HISTORY_RECORDS {
                model.trace(record(None, "line", Some(&index.to_string()), None, None))?;
            }
            Ok(())
        }).unwrap();
        let mut terminal = test_terminal(100, 30);
        draw(&mut terminal, &shared).unwrap();
        assert!(row(terminal.backend().buffer(), 12).contains("1 omitted"));
        {
            let mut model = shared.lock().unwrap();
            assert_eq!(model.records.len(), HISTORY_RECORDS);
            assert_eq!(model.record_index.len(), HISTORY_RECORDS);
            assert!(!model.record_index.contains_key(&(None, "0".into())));
            model.key(KeyCode::Tab);
            model.key(KeyCode::Home);
            assert!(!model.follow);
            let first = model.records.front().unwrap().serial;
            assert_eq!(model.scroll, Scroll { serial: first, line: 0 });
            model.trace(record(None, "next", Some("next"), None, None)).unwrap();
            assert_eq!(model.scroll.serial, first + 1);
            model.trace(record(None, "new surviving zero", Some("0"), None, None)).unwrap();
            assert_eq!(model.records.back().unwrap().body, "new surviving zero");
        }
        let shared = Shared::new(String::new());
        let long = "分析🤖".repeat(ENTRY_BYTES);
        shared.update(|model| {
            model.trace(record(None, &long, Some("big"), None, None))?;
            let first = model.records.front().unwrap();
            assert!(first.body.ends_with(TRUNCATED));
            assert!(first.body.is_char_boundary(first.body.len() - TRUNCATED.len()));
            assert!(first.bytes <= ENTRY_BYTES);
            let capped = first.body.clone();
            model.trace(record(None, "discarded after truncation", Some("big"), None, None))?;
            assert_eq!(model.records.front().unwrap().body, capped);
            model.trace(record(None, "replacement", Some("big"), Some("replace"), None))?;
            assert_eq!(model.records.front().unwrap().body, "replacement");
            assert!(!model.records.front().unwrap().truncated);
            for _ in 0..140 { model.trace(record(None, &long, None, None, None))?; }
            assert!(model.bytes <= HISTORY_BYTES);
            assert!(model.records.len() <= HISTORY_RECORDS);
            assert!(model.omitted > 0);
            assert!(!model.record_index.contains_key(&(None, "big".into())));
            Ok(())
        }).unwrap();
        draw(&mut terminal, &shared).unwrap();
        assert!(row(terminal.backend().buffer(), 12).contains("omitted"));
        assert!(visible(terminal.backend().buffer(), shared.lock().unwrap().trace_area).contains(TRUNCATED));
    }

    #[test]
    fn unicode_wrapping_scrolls_by_stable_record_and_resize_not_topology() {
        let shared = scene();
        shared.update(|model| {
            for index in 0..30 {
                model.trace(record(Some("alpha"), &format!("{index}: 分析🤖 café e\u{0301} mixed words and spaces"), None, None, None))?;
            }
            Ok(())
        }).unwrap();
        let mut terminal = test_terminal(100, 30);
        draw(&mut terminal, &shared).unwrap();
        let wide_height = shared.lock().unwrap().records[0].height;
        let lines = shared.lock().unwrap().lines.clone();
        shared.update(|model| { model.key(KeyCode::Tab); model.key(KeyCode::Home); Ok(()) }).unwrap();
        draw(&mut terminal, &shared).unwrap();
        let first = shared.lock().unwrap().scroll;
        shared.update(|model| { model.key(KeyCode::PageDown); Ok(()) }).unwrap();
        draw(&mut terminal, &shared).unwrap();
        assert!(shared.lock().unwrap().scroll.serial > first.serial);
        let frozen = shared.lock().unwrap().scroll;
        shared.update(|model| model.trace(record(Some("beta"), "new tail", None, None, None))).unwrap();
        draw(&mut terminal, &shared).unwrap();
        assert_eq!(shared.lock().unwrap().scroll, frozen);
        let mut narrow = test_terminal(20, 12);
        draw(&mut narrow, &shared).unwrap();
        {
            let model = shared.lock().unwrap();
            assert_eq!(model.lines, lines);
            assert!(model.records[0].height > wide_height);
            assert_eq!(model.records[0].height, model.records[0].paragraph.line_count(model.trace_area.width));
            assert_eq!(model.scroll.serial, frozen.serial);
            assert!(model.records.iter().all(|entry| entry.height <= usize::from(u16::MAX)));
        }
        shared.update(|model| { model.key(KeyCode::End); Ok(()) }).unwrap();
        draw(&mut terminal, &shared).unwrap();
        assert!(shared.lock().unwrap().follow);
        assert!(visible(terminal.backend().buffer(), shared.lock().unwrap().trace_area).contains("new tail"));
    }

    #[test]
    fn full_canvas_panning_clips_before_u16_conversion_and_tiny_viewports_do_not_underflow() {
        let shared = Shared::new(String::new());
        shared.update(|model| model.set_graph(
            vec![node("far", "ABC", "g1")], vec![format!("{}ABC", " ".repeat(70_000))],
            vec![rect("far", 70_000.0, 0.0, 3.0, 1.0)],
        )).unwrap();
        let mut terminal = test_terminal(100, 30);
        draw(&mut terminal, &shared).unwrap();
        shared.update(|model| { model.set_active("far", true)?; model.key(KeyCode::End); Ok(()) }).unwrap();
        draw(&mut terminal, &shared).unwrap();
        assert!(visible(terminal.backend().buffer(), shared.lock().unwrap().graph_area).contains("ABC"));
        assert_eq!(cell_for(terminal.backend().buffer(), "ABC").fg, Color::Green);
        assert!(shared.lock().unwrap().pan_x > u64::from(u16::MAX));
        for (width, height) in [(0, 0), (1, 1), (2, 2), (3, 1), (1, 3), (10, 5)] {
            let mut tiny = test_terminal(width, height);
            draw(&mut tiny, &shared).unwrap();
            shared.update(|model| { model.key(KeyCode::Home); model.key(KeyCode::Tab); model.key(KeyCode::PageUp); Ok(()) }).unwrap();
            draw(&mut tiny, &shared).unwrap();
        }
    }

    #[tokio::test]
    async fn generation_race_never_acknowledges_a_new_update_with_an_older_frame() {
        let shared = scene();
        let mut terminal = test_terminal(100, 30);
        let mut captured = 0;
        terminal.draw(|frame| {
            captured = render_frame(frame, &shared).unwrap();
            assert!(shared.model.try_lock().is_ok(), "render lock must end before terminal I/O");
            shared.update(|model| model.trace(record(Some("alpha"), "arrived during output", None, None, None))).unwrap();
        }).unwrap();
        let latest = shared.barrier().unwrap();
        assert!(latest > captured);
        shared.acknowledge(captured);
        assert!(shared.dirty().unwrap());
        assert!(tokio::time::timeout(Duration::from_millis(1), shared.wait_draw(latest)).await.is_err());
        assert!(!visible(terminal.backend().buffer(), shared.lock().unwrap().trace_area).contains("arrived during output"));
        assert_eq!(draw(&mut terminal, &shared).unwrap(), latest);
        shared.wait_draw(latest).await.unwrap();
        assert!(!shared.dirty().unwrap());
        assert!(visible(terminal.backend().buffer(), shared.lock().unwrap().trace_area).contains("arrived during output"));
    }

    #[tokio::test]
    async fn finish_is_synchronous_and_close_failure_barriers_wait_for_restoration_publication() {
        let shared = scene();
        let mut terminal = test_terminal(100, 30);
        shared.update(|model| model.set_active("alpha", true)).unwrap();
        shared.begin_finish();
        assert!(shared.lock().unwrap().finished);
        assert!(!shared.lock().unwrap().nodes[0].active);
        let generation = shared.barrier().unwrap();
        shared.begin_finish();
        assert_eq!(shared.barrier().unwrap(), generation);
        draw(&mut terminal, &shared).unwrap();
        shared.wait_draw(generation).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(1), shared.wait_exit()).await.is_err());
        shared.begin_close();
        shared.begin_close();
        let mut called = false;
        shared.update(|_| { called = true; Err("must be discarded".into()) }).unwrap();
        assert!(!called);
        assert!(tokio::time::timeout(Duration::from_millis(1), shared.wait_draw(generation)).await.is_err());
        shared.progress.send_modify(|progress| progress.ended = Some(Ok(Exit::Closed)));
        shared.wait_draw(generation).await.unwrap();
        assert_eq!(shared.wait_exit().await.unwrap(), Exit::Closed);
        assert_eq!(shared.wait_exit().await.unwrap(), Exit::Closed);

        let failed = Shared::new(String::new());
        draw(&mut terminal, &failed).unwrap();
        let generation = failed.barrier().unwrap();
        failed.fail("first rendering failure".into());
        failed.fail("later cleanup failure".into());
        assert!(tokio::time::timeout(Duration::from_millis(1), failed.wait_draw(generation)).await.is_err());
        failed.progress.send_modify(|progress| progress.ended = Some(Err(failed.failure.borrow().as_ref().unwrap().clone())));
        assert_eq!(failed.wait_draw(generation).await.unwrap_err(), "first rendering failure");
        assert_eq!(failed.wait_exit().await.unwrap_err(), "first rendering failure");
    }

    #[test]
    fn poisoned_model_latches_display_failure_instead_of_panicking() {
        let shared = Shared::new(String::new());
        let poisoned = Arc::clone(&shared);
        assert!(thread::spawn(move || {
            let _guard = poisoned.model.lock().unwrap();
            panic!("poison model for test");
        }).join().is_err());
        assert!(shared.lock().is_err());
        assert_eq!(shared.failure.borrow().as_deref(), Some("TUI display model lock is poisoned"));
        let mut terminal = test_terminal(100, 30);
        assert!(draw(&mut terminal, &shared).is_err());
        assert_eq!(shared.progress.borrow().drawn, 0);
    }

    #[test]
    fn terminal_reservation_is_exclusive_and_releases_on_drop() {
        let reservation = Reservation::acquire().unwrap();
        assert_eq!(Reservation::acquire().err().unwrap(), "A TUI session already owns this terminal");
        drop(reservation);
        drop(Reservation::acquire().unwrap());
        assert!(!TERMINAL_OWNED.load(Ordering::Acquire));
    }
}
