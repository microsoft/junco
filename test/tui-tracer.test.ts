import { test } from "bun:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, watch } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withNativeCleanup } from "./native-support.ts";

const root = join(import.meta.dir, "..");
const deadlineMs = 15_000;
const terminalError =
  "TuiTracer requires an interactive terminal on stdin and stdout";
type Phase = {
  phase: string;
  pid: number;
  stage?: string;
  node?: string;
  marker?: string;
  childId?: string;
  settled?: boolean;
};
type Cell = { text: string; color: string; bold: boolean };
type Screen = { cells: readonly (readonly Cell[])[]; rows: readonly string[] };

/** Decode the actual Crossterm screen, including diff frames; never count raw redraw bytes as text. */
class Terminal {
  width = 100;
  height = 30;
  x = 0;
  y = 0;
  color = "default";
  bold = false;
  alternate = false;
  cursorVisible = true;
  entered = 0;
  left = 0;
  pending = "";
  cells: Cell[][] = [];
  readonly frames: Screen[] = [];
  completedFrame: Screen | undefined;

  constructor() {
    this.clear();
  }
  clear() {
    this.cells = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({
        text: " ",
        color: "default",
        bold: false,
      })),
    );
  }
  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.completedFrame = undefined;
    this.clear();
    this.x = 0;
    this.y = 0;
  }
  screen(): Screen {
    return {
      cells: this.cells.map((row) => row.map((cell) => ({ ...cell }))),
      rows: this.cells.map((row) => row.map((cell) => cell.text).join("")),
    };
  }
  record() {
    if (this.alternate) this.frames.push(this.screen());
  }
  feed(chunk: string) {
    this.pending += chunk;
    let i = 0;
    while (i < this.pending.length) {
      const c = this.pending[i]!;
      if (c === "\x1b") {
        const next = this.pending[i + 1];
        if (next === undefined) break;
        if (next === "[") {
          const match = /^\[([0-9;:?<>=]*)([ -/]*)([@-~])/u.exec(
            this.pending.slice(i + 1),
          );
          if (!match) break;
          this.csi(match[1]!, match[3]!);
          i += match[0].length + 1;
          continue;
        }
        if (next === "]") {
          const bell = this.pending.indexOf("\x07", i + 2);
          const terminator = this.pending.indexOf("\x1b\\", i + 2);
          const end =
            bell < 0
              ? terminator
              : terminator < 0
                ? bell
                : Math.min(bell, terminator);
          if (end < 0) break;
          i = end + (end === bell ? 1 : 2);
          continue;
        }
        // Crossterm may designate the default character set; consume its third byte too.
        if (next === "(" || next === ")") {
          if (i + 2 >= this.pending.length) break;
          i += 3;
        } else i += 2;
        continue;
      }
      const point = this.pending.codePointAt(i)!;
      const text = String.fromCodePoint(point);
      i += text.length;
      if (c === "\r") this.x = 0;
      else if (c === "\n") this.y = Math.min(this.height - 1, this.y + 1);
      else if (c === "\b") this.x = Math.max(0, this.x - 1);
      else if (point >= 32 && point !== 127) {
        if (this.x >= this.width) {
          this.x = 0;
          this.y = Math.min(this.height - 1, this.y + 1);
        }
        const row = this.cells[this.y];
        if (row && this.x >= 0 && this.x < this.width)
          row[this.x] = { text, color: this.color, bold: this.bold };
        this.x++;
      }
    }
    this.pending = this.pending.slice(i);
    this.record();
  }
  csi(parameters: string, code: string) {
    const values = parameters
      .replace(/^\?/u, "")
      .split(";")
      .map((value) => Number(value || 0));
    const n = values[0] || 1;
    switch (code) {
      case "H":
      case "f":
        this.y = (values[0] || 1) - 1;
        this.x = (values[1] || 1) - 1;
        break;
      case "A":
        this.y = Math.max(0, this.y - n);
        break;
      case "B":
        this.y = Math.min(this.height - 1, this.y + n);
        break;
      case "C":
        this.x = Math.min(this.width - 1, this.x + n);
        break;
      case "D":
        this.x = Math.max(0, this.x - n);
        break;
      case "G":
        this.x = n - 1;
        break;
      case "d":
        this.y = n - 1;
        break;
      case "J":
        if (values[0] === 2 || values[0] === 3) this.clear();
        else if (values[0] === 0)
          for (let y = this.y; y < this.height; y++)
            this.erase(y, y === this.y ? this.x : 0, this.width);
        break;
      case "K":
        this.erase(
          this.y,
          values[0] === 1 || values[0] === 2 ? 0 : this.x,
          values[0] === 1 ? this.x + 1 : this.width,
        );
        break;
      case "m":
        this.style(values);
        break;
      case "h":
      case "l":
        if (parameters.startsWith("?") && values.includes(1049)) {
          if (code === "h") {
            this.alternate = true;
            this.entered++;
            this.clear();
            this.x = 0;
            this.y = 0;
          } else {
            this.record();
            this.alternate = false;
            this.left++;
          }
        }
        if (parameters.startsWith("?") && values.includes(25)) {
          this.cursorVisible = code === "h";
          // Native draws end with cursor-hide; a PTY read may stop halfway through a draw.
          if (!this.cursorVisible && this.alternate) this.completedFrame = this.screen();
        }
        break;
    }
  }
  erase(y: number, from: number, to: number) {
    const row = this.cells[y];
    if (!row) return;
    for (let x = Math.max(0, from); x < Math.min(this.width, to); x++)
      row[x] = { text: " ", color: this.color, bold: this.bold };
  }
  style(values: number[]) {
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      if (value === 0) {
        this.color = "default";
        this.bold = false;
      } else if (value === 1) this.bold = true;
      else if (value === 22) this.bold = false;
      else if (value === 39) this.color = "default";
      else if (value >= 30 && value <= 37)
        this.color =
          value === 32 ? "green" : value === 31 ? "red" : `ansi:${value - 30}`;
      else if (value >= 90 && value <= 97)
        this.color = `ansi:${value - 90 + 8}`;
      else if (value === 38 || value === 48) {
        const foreground = value === 38;
        if (values[i + 1] === 2) {
          if (foreground)
            this.color = `rgb:${values[i + 2]},${values[i + 3]},${values[i + 4]}`;
          i += 4;
        } else if (values[i + 1] === 5) {
          const index = values[i + 2];
          if (foreground)
            this.color =
              index === 2 ? "green" : index === 1 ? "red" : `ansi:${index}`;
          i += 2;
        }
      }
    }
  }
}

function occurrences(
  screen: Screen,
  text: string,
  from = 0,
  to = screen.rows.length,
): { x: number; y: number; cell: Cell }[] {
  const result: { x: number; y: number; cell: Cell }[] = [];
  for (let y = from; y < to; y++) {
    const row = screen.rows[y] ?? "";
    for (
      let x = row.indexOf(text);
      x >= 0;
      x = row.indexOf(text, x + text.length)
    )
      result.push({ x, y, cell: screen.cells[y]![x]! });
  }
  return result;
}
const graphText = (screen: Screen) => screen.rows.slice(1, 11).join("\n");
const traces = (screen: Screen) => screen.rows.slice(13, 29).join("\n");

/** Visible records for one concrete node, including their wrapped continuation rows. */
function nodeTraces(screen: Screen, node: string): string {
  const lines: string[] = [];
  let selected = false;
  for (const row of screen.rows.slice(13, 29)) {
    const badge = row.match(/\[(?:g\d+:[^\]]+|system)\]/u)?.[0];
    if (badge !== undefined) selected = badge === node;
    if (selected) lines.push(row.slice(1, -1).trim());
  }
  return lines.join("");
}
const green = (screen: Screen, id: string) =>
  occurrences(screen, id, 1, 11).some(
    ({ cell }) => cell.color === "green" && cell.bold,
  );

async function withPty(
  flags: readonly string[],
  body: (pty: Awaited<ReturnType<typeof openPty>>) => Promise<void>,
  env: Record<string, string> = {},
  width = 100,
) {
  await withNativeCleanup(async (defer) => {
    const pty = await openPty(flags, env, width);
    defer(() => pty.close());
    await body(pty);
  });
}

async function openPty(
  flags: readonly string[],
  env: Record<string, string>,
  width: number,
) {
  const directory = await mkdtemp(join(tmpdir(), "junco-tui-"));
  const stateFile = join(directory, "state.ndjson");
  const commandFile = join(directory, "commands.ndjson");
  await Promise.all([writeFile(stateFile, ""), writeFile(commandFile, "")]);
  const phases: Phase[] = [];
  const terminal = new Terminal();
  terminal.resize(width, 30);
  const subscribers = new Set<() => void>();
  const notify = () => {
    for (const subscriber of subscribers) subscriber();
  };
  let consumed = 0;
  const readPhases = () => {
    const lines = readFileSync(stateFile, "utf8").split("\n").slice(0, -1);
    for (const line of lines.slice(consumed)) phases.push(JSON.parse(line));
    consumed = lines.length;
    notify();
  };
  const watcher = watch(stateFile, readPhases);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `stty rows 30 cols ${width}; exec ${quote(process.execPath)} run test/tui-tracer.fixture.ts ${flags.map(quote).join(" ")}`;
  const child = Bun.spawn(
    ["script", "--quiet", "--return", "--command", command, "/dev/null"],
    {
      cwd: root,
      env: {
        ...process.env,
        NAPI_RS_NATIVE_LIBRARY_PATH: "",
        NAPI_RS_FORCE_WASI: "",
        NAPI_RS_WASI_FLAVOR: "",
        TERM: "xterm-256color",
        LOG_LEVEL: "INFO",
        NO_COLOR: "",
        JUNCO_TUI_SMOKE_STATE: stateFile,
        JUNCO_TUI_SMOKE_COMMAND: commandFile,
        ...env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = Date.now() + deadlineMs;
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  let timedOut = false;
  const terminate = () => {
    const pid = phases[0]?.pid;
    if (pid && !phases.some((phase) => phase.phase === "restored")) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (exitCode === undefined) child.kill("SIGKILL");
  };
  const kill = setTimeout(() => {
    timedOut = true;
    terminate();
    notify();
  }, deadlineMs);
  const output = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      stdout += text;
      terminal.feed(text);
      readPhases();
    }
    const text = decoder.decode();
    stdout += text;
    terminal.feed(text);
    readPhases();
  })();
  const errors = new Response(child.stderr).text().then((text) => {
    stderr = text;
  });
  const exited = child.exited.then((code) => {
    exitCode = code;
    readPhases();
    notify();
    return code;
  });
  async function until(predicate: () => boolean, description: string) {
    readPhases();
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          subscribers.delete(check);
          reject(
            new Error(`15s PTY deadline: ${description}\n${stderr}\n${stdout}`),
          );
        },
        Math.max(1, deadline - Date.now()),
      );
      const check = () => {
        if (predicate()) {
          clearTimeout(timer);
          subscribers.delete(check);
          resolve();
        } else if (exitCode !== undefined || timedOut) {
          clearTimeout(timer);
          subscribers.delete(check);
          reject(
            new Error(
              `PTY ended before ${description}: ${exitCode}\n${stderr}\n${stdout}`,
            ),
          );
        }
      };
      subscribers.add(check);
      check();
    });
  }
  return {
    terminal,
    phases,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get exited() {
      return exitCode !== undefined;
    },
    hasPhase(name: string, stage?: string) {
      return phases.some(
        (phase) =>
          phase.phase === name &&
          (stage === undefined || phase.stage === stage),
      );
    },
    async phase(name: string, stage?: string) {
      await until(
        () =>
          phases.some(
            (phase) =>
              phase.phase === name &&
              (stage === undefined || phase.stage === stage),
          ),
        `${name}${stage ? `:${stage}` : ""}`,
      );
      return phases.find(
        (phase) =>
          phase.phase === name &&
          (stage === undefined || phase.stage === stage),
      )!;
    },
    async screen(predicate: (screen: Screen) => boolean, description: string) {
      let result: Screen | undefined;
      await until(() => {
        const frame = terminal.completedFrame;
        if (frame === undefined || !predicate(frame)) return false;
        result = frame;
        return true;
      }, description);
      assert.ok(result);
      return result;
    },
    async input(bytes: string) {
      assert.ok(
        phases.some(
          (phase) =>
            phase.phase === "active" || phase.phase === "awaiting-dismissal",
        ),
        "input requires a complete phase line",
      );
      child.stdin.write(bytes);
      await child.stdin.flush();
    },
    command(command: string) {
      appendFileSync(commandFile, `${JSON.stringify({ command })}\n`);
    },
    async done(marker: string) {
      await until(() => exitCode !== undefined, "subprocess completion");
      await Promise.all([output, errors, exited]);
      assert.equal(exitCode, 0, `${stderr}\n${stdout}`);
      assert.ok(
        phases.some(
          (phase) => phase.phase === "restored" && phase.marker === marker,
        ),
      );
      assert.ok(stdout.includes(marker));
      assert.equal(terminal.alternate, false);
      assert.equal(terminal.cursorVisible, true);
      assert.equal(
        terminal.entered,
        terminal.left,
        "every alternate-screen acquisition must be restored",
      );
    },
    async close() {
      clearTimeout(kill);
      watcher.close();
      if (exitCode === undefined) terminate();
      child.stdin.end();
      await Promise.allSettled([output, errors, exited]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const [flag, level, marker] of [
  ["", "INFO", "TUI_SMOKE_OK"],
  ["--explicit", "INFO", "TUI_SMOKE_OK"],
  ["--fail", "INFO", "TUI_FAILURE_OK"],
  ["", "ERROR", "TUI_SMOKE_OK"],
] as const) {
  test(
    `real PTY ${flag || "automatic"} at LOG_LEVEL=${level}: lazy acquisition, live traces and retained final frame`,
    async () => {
      await withPty(
        flag ? [flag] : [],
        async (pty) => {
          if (flag !== "--explicit") await pty.phase("constructed");
          await pty.phase("active");
          const completeTopology = (screen: Screen) => {
            const canvas = graphText(screen);
            return canvas.includes("terminal->$sink (value)") &&
              canvas.includes("alpha=>beta (value)");
          };
          const alpha = await pty.screen(
            (screen) => green(screen, "Alpha") && completeTopology(screen),
            "Alpha actively green",
          );
          assert.equal(
            green(alpha, "Beta"),
            false,
            "a future available/dependent node is not active",
          );
          assert.ok(alpha.rows[0]!.includes("JuncoGraph"));
          assert.ok(alpha.rows[12]!.includes("Agent traces"));
          const betaTitle = await pty.screen(
            (screen) =>
              screen.rows[0]!.includes("active: [g1:Beta]") &&
              !green(screen, "Alpha") && completeTopology(screen),
            "Beta scheduled after Alpha ends",
          );
          assert.equal(
            graphText(betaTitle),
            graphText(alpha),
            "trace/activity changes must not relayout or erase the upper canvas",
          );
          await pty.input("\x1b[6~");
          await pty.screen(
            (screen) => green(screen, "Beta"),
            "panning reveals the executing Beta rectangle",
          );
          await pty.phase("awaiting-dismissal");
          await pty.input("\x1b[H");
          const final = await pty.screen(
            (screen) =>
              screen.rows[0]!.includes("complete") &&
              !screen.rows[0]!.includes("active:") &&
              !green(screen, "Alpha") &&
              graphText(screen).includes("Alpha") && completeTopology(screen),
            "final inactive topology restored to its original viewport",
          );
          assert.equal(graphText(final), graphText(alpha));
          if (flag === "--fail") await pty.input("\t\x1b[H\x1b[6~");
          const messages = await pty.screen(
            (screen) => screen.rows[0]!.includes("complete") &&
              !screen.rows[0]!.includes("active:") &&
              nodeTraces(screen, "[g1:Beta]").includes("beta done"),
            "finalized Beta message remains in trace history",
          );
          assert.equal(
            nodeTraces(messages, "[g1:Beta]").replace(/\s+/gu, "").split("betadone").length - 1,
            1,
            "Beta stream finalization must not duplicate Beta's message in another Beta record",
          );
          const betaBadge = occurrences(messages, ":Beta]", 13, 29);
          assert.ok(betaBadge.length > 0);
          assert.ok(
            betaBadge.every(
              ({ cell }) => cell.color !== "default" && cell.color !== "green",
            ),
          );
          if (flag === "--fail") {
            await pty.screen(
              (screen) =>
                occurrences(screen, "tui smoke failure", 13, 29).some(
                  ({ cell }) => cell.color === "red",
                ),
              "retained computation failure in red",
            );
          }
          assert.equal(
            pty.exited,
            false,
            "flush must still be pending before dismissal",
          );
          assert.equal(
            pty.phases.some((phase) => phase.phase === "restored"),
            false,
          );
          assert.equal(
            pty.phases.find((phase) => phase.phase === "awaiting-dismissal")
              ?.settled,
            false,
          );
          await pty.input("q");
          await pty.done(marker);
          assert.equal(
            pty.terminal.entered,
            1,
            "steps share one alternate-screen session",
          );
          const historicalAlpha = pty.terminal.frames
            .flatMap((screen) => occurrences(screen, ":Alpha]", 13, 29))
            .map(({ cell }) => cell.color)
            .find((color) => color !== "default");
          const historicalBeta = pty.terminal.frames
            .flatMap((screen) => occurrences(screen, ":Beta]", 13, 29))
            .map(({ cell }) => cell.color)
            .find((color) => color !== "default");
          assert.ok(
            historicalAlpha &&
              historicalBeta &&
              historicalAlpha !== historicalBeta,
            "member badges have distinct identity colors",
          );
        },
        { LOG_LEVEL: level },
      );
    },
    deadlineMs + 1_000,
  );
}

test(
  "task promotion preserves the parent scene and observes the actual task NodeId",
  async () => {
    await withPty(
      ["--tasks"],
      async (pty) => {
        await pty.phase("active", "worker");
        const active = await pty.screen(
          (screen) =>
            graphText(screen).includes("caller") &&
            graphText(screen).includes("terminal->$sink") &&
            screen.rows[0]!.includes("task-"),
          "parent scene retained while the promoted child runs",
        );
        const task = active.rows[0]!.match(/\[(g\d+):(task-[^\]]+)\]/u);
        const taskScope = task?.[1];
        const taskId = task?.[2];
        assert.ok(taskScope && taskId, "active title identifies the actual promoted task and scope");
        let childScene = active;
        while (!occurrences(childScene, taskId, 1, 11).some(({ cell }) => cell.color !== "default")) {
          const previous = graphText(childScene);
          await pty.input("\x1b[6~");
          childScene = await pty.screen(
            (screen) => graphText(screen) !== previous,
            "panning toward the actual promoted task node",
          );
        }
        assert.equal(
          occurrences(childScene, taskId, 1, 11).filter(
            ({ cell }) => cell.color !== "default",
          ).length,
          1,
          "one identity-colored task node, independent of edge labels",
        );
        await pty.input("\x1b[H");
        await pty.screen(
          (screen) => graphText(screen) === graphText(active),
          "panning back retains the parent geometry",
        );
        pty.command("worker");
        const complete = await pty.phase("tasks-complete");
        assert.equal(complete.childId, taskId);
        await pty.phase("awaiting-dismissal");
        const finalized = await pty.screen(
          (screen) =>
            screen.rows[0]?.includes("complete") === true &&
            !screen.rows[0]!.includes("active:") &&
            graphText(screen) === graphText(active),
          "completed promoted-agent scene retains the parent geometry",
        );
        const wrapperText = nodeTraces(finalized, "[g1:caller]");
        assert.ok(wrapperText.includes("return"), "the parent wrapper publishes its native return");
        assert.equal(wrapperText.replace(/\s+/gu, "").split("combined:workerdone").length - 1, 0,
          "the wrapper return does not replay the inner root's streamed message");
        await pty.input("\t");
        let tracePage = finalized;
        const revealMessage = async (node: string, message: string): Promise<Screen> => {
          const previous = traces(tracePage);
          await pty.input("\x1b[H");
          tracePage = await pty.screen((screen) => traces(screen) !== previous, "trace history at Home");
          const expected = message.replace(/\s+/gu, "");
          while (!nodeTraces(tracePage, node).replace(/\s+/gu, "").includes(expected)) {
            const before = traces(tracePage);
            await pty.input("\x1b[6~");
            tracePage = await pty.screen((screen) => traces(screen) !== before,
              `panning to ${node}'s retained message`);
          }
          return tracePage;
        };
        const rootMessage = await revealMessage(`[${taskScope}:root]`, "assistant: combined: worker done");
        assert.equal(
          nodeTraces(rootMessage, `[${taskScope}:root]`).replace(/\s+/gu, "").split("combined:workerdone").length - 1,
          1,
          "promotion finalizes the actual root's streamed assistant message once",
        );
        const workerMessage = await revealMessage(`[${taskScope}:${taskId}]`, "assistant: worker done");
        assert.ok(occurrences(workerMessage, `${taskId}]`, 13, 29).some(
          ({ cell }) => cell.color !== "default",
        ), "worker text retains its actual scoped task identity");
        assert.equal(pty.exited, false);
        await pty.input("q");
        await pty.done("TUI_TASKS_OK");
        assert.equal(pty.terminal.entered, 1);
      },
      {},
      180,
    );
  },
  deadlineMs + 1_000,
);

test(
  "concurrent roots retain distinct repeated IDs, clear only their own activations and replace completed scenes",
  async () => {
    await withPty(["--scopes"], async (pty) => {
      await pty.phase("active", "scoped-both");
      await pty.screen(
        (screen) =>
          screen.rows[0]!.includes("g1:A") && screen.rows[0]!.includes("g2:A"),
        "both scoped activations reach the native display",
      );
      await pty.input("\x1b[B");
      const both = await pty.screen(
        (screen) =>
          occurrences(screen, "A", 1, 11).filter(
            ({ cell }) => cell.color === "green" && cell.bold,
          ).length >= 2 &&
          screen.rows[0]!.includes("g1:A") &&
          screen.rows[0]!.includes("g2:A"),
        "both concrete A nodes active concurrently",
      );
      pty.command("left");
      await pty.phase("active", "scoped-right");
      const right = await pty.screen(
        (screen) =>
          occurrences(screen, "A", 1, 11).filter(
            ({ cell }) => cell.color === "green" && cell.bold,
          ).length === 1 &&
          screen.rows[0]!.includes("g2:A") &&
          !screen.rows[0]!.includes("g1:A"),
        "only the surviving activation remains green",
      );
      assert.equal(graphText(right), graphText(both));
      pty.command("right");
      await pty.phase("active", "replacement");
      await pty.phase("awaiting-dismissal");
      await pty.screen(
        (screen) =>
          graphText(screen).includes("Replacement") &&
          !/\bA\b/u.test(graphText(screen)),
        "new unrelated root replaces both completed roots",
      );
      await pty.input("\t\x1b[H");
      const history = await pty.screen(
        (screen) =>
          occurrences(screen, "[g1:A]", 13, 29).length > 0 &&
          occurrences(screen, "[g2:A]", 13, 29).length > 0,
        "historical scoped badges survive root replacement",
      );
      const first = occurrences(history, "[g1:A]", 13, 29);
      const second = occurrences(history, "[g2:A]", 13, 29);
      assert.notEqual(first[0]!.cell.color, second[0]!.cell.color);
      await pty.input("q");
      await pty.done("TUI_SCOPES_OK");
    });
  },
  deadlineMs + 1_000,
);

test(
  "production NativeTui draw barriers, coalesced streams, keyboard scrolling/panning and validation cleanup",
  async () => {
    await withPty(["--native"], async (pty) => {
      await pty.phase("active", "native-both");
      const both = await pty.screen(
        (screen) =>
          green(screen, "A") &&
          occurrences(screen, "A", 1, 11).filter(
            ({ cell }) => cell.color === "green",
          ).length === 2,
        "two native activations",
      );
      assert.ok(
        both.rows[0]!.includes("JuncoGraph") &&
          both.rows[12]!.includes("Agent traces"),
      );
      pty.command("yield");
      await pty.phase("active", "native-right");
      const right = await pty.screen(
        (screen) =>
          traces(screen).includes("streamed complete") &&
          occurrences(screen, "A", 1, 11).filter(
            ({ cell }) => cell.color === "green",
          ).length === 1,
        "append updates one streaming entry and clears only left",
      );
      assert.equal(graphText(right), graphText(both));
      assert.equal(occurrences(right, "streamed complete", 13, 29).length, 1);
      assert.notEqual(
        occurrences(right, "[g1:A]", 13, 29)[0]!.cell.color,
        occurrences(right, "[g2:A]", 13, 29)[0]!.cell.color,
      );
      pty.command("fail");
      await pty.phase("active", "keyboard");
      await pty.input("\t\x1b[H");
      const home = await pty.screen(
        (screen) =>
          screen.rows[12]!.includes("paused") &&
          traces(screen).includes("streamed complete"),
        "Home freezes trace tail-follow and exposes oldest entry",
      );
      assert.ok(
        occurrences(home, "native failure", 13, 29).some(
          ({ cell }) => cell.color === "red",
        ),
      );
      await pty.input("\x1b[6~");
      await pty.screen(
        (screen) => !traces(screen).includes("streamed complete"),
        "PageDown moves the trace viewport",
      );
      await pty.input("\x1b[F");
      await pty.screen(
        (screen) =>
          screen.rows[12]!.includes("following") &&
          traces(screen).includes("scroll record 79"),
        "End restores tail-follow",
      );
      await pty.input("\t\x1b[C");
      await pty.screen(
        (screen) => graphText(screen) !== graphText(home),
        "arrows pan only the graph canvas",
      );
      await pty.input("\x1b[H");
      await pty.screen(
        (screen) => graphText(screen) === graphText(home),
        "Home restores graph origin",
      );
      pty.terminal.resize(2, 2);
      pty.command("tiny");
      await pty.phase("active", "tiny");
      await pty.screen(
        (screen) =>
          screen.rows.length === 2 &&
          screen.rows.some((row) => row.trim().length > 0),
        "tiny viewport renders without underflow or panic",
      );
      pty.terminal.resize(100, 30);
      pty.command("resize");
      await pty.phase("active", "resized");
      await pty.screen(
        (screen) =>
          screen.rows[0]!.includes("JuncoGraph") &&
          screen.rows[12]!.includes("Agent traces") &&
          traces(screen).includes("resized safely"),
        "resize redraws both complete panes",
      );
      pty.command("finish");
      await pty.phase("awaiting-dismissal");
      assert.equal(pty.exited, false);
      await pty.input("q");
      await pty.done("TUI_NATIVE_OK");
      assert.ok(
        pty.terminal.frames.some((screen) =>
          screen.rows[0]?.includes("complete"),
        ),
        "queued dismissal still draws the final frame before restoration",
      );
    });
  },
  deadlineMs + 1_000,
);

for (const [flags, input, marker] of [
  [["--early-dismiss"], "q", "TUI_SMOKE_OK"],
  [[], "\x03", "TUI_CANCELLED"],
] as const) {
  test(
    `early ${input === "q" ? "dismissal does not cancel computation or reopen" : "Ctrl-C cancels and restores"}`,
    async () => {
      await withPty(flags, async (pty) => {
        await pty.phase("active");
        await pty.screen(
          (screen) => green(screen, "Alpha"),
          "active Alpha before early input",
        );
        await pty.input(input);
        await pty.done(marker);
        assert.equal(pty.terminal.entered, 1);
      });
    },
    deadlineMs + 1_000,
  );
}

test(
  "Esc dismisses a completed display",
  async () => {
    await withPty([], async (pty) => {
      await pty.phase("awaiting-dismissal");
      await pty.input("\x1b");
      await pty.done("TUI_SMOKE_OK");
    });
  },
  deadlineMs + 1_000,
);

test(
  "close and async disposal settle an opened finish without keyboard dismissal",
  async () => {
    await withPty(["--close"], async (pty) => {
      await pty.done("TUI_SMOKE_OK");
    });
  },
  deadlineMs + 1_000,
);

test(
  "second explicit acquisition refuses while the lazy session opens or is open",
  async () => {
    await withPty(["--second-session"], async (pty) => {
      await pty.phase("awaiting-dismissal");
      await pty.input("q");
      await pty.done("TUI_SMOKE_OK");
    });
  },
  deadlineMs + 1_000,
);

test(
  "graph rendering failure retains computation, diagnostic and original error through restored flush/close",
  async () => {
    await withPty(["--display-failure"], async (pty) => {
      await pty.phase("active", "render-failure");
      await pty.screen(
        (screen) =>
          graphText(screen).includes("(graph rendering failed)") &&
          screen.rows
            .slice(13, 29)
            .map((row) => row.trim())
            .join(" ")
            .replace(/\s+/g, " ")
            .includes("tui retained rendering failure") &&
          occurrences(screen, "tui retained", 13, 29).some(
            ({ cell }) => cell.color === "red",
          ),
        "real graph-render failure diagnostic across wrapped lines",
      );
      pty.command("finish");
      await pty.phase("awaiting-dismissal");
      assert.equal(pty.exited, false);
      await pty.input("q");
      await pty.done("TUI_DISPLAY_FAILURE_OK");
    });
  },
  deadlineMs + 1_000,
);

for (const lazy of [false, true]) {
  test(
    `interactive missing binding ${lazy ? "lazy flush/close" : "explicit create"} rejects without Dummy recovery and releases logger/terminal`,
    async () => {
      await withPty(
        [lazy ? "--missing-lazy" : "--missing"],
        async (pty) => {
          await pty.done(
            lazy ? "TUI_LAZY_FAILURE_OK" : "TUI_STARTUP_FAILURE_OK",
          );
          assert.equal(pty.terminal.entered, 0);
        },
        {
          NAPI_RS_NATIVE_LIBRARY_PATH: join(
            tmpdir(),
            "junco-tui-binding-does-not-exist.node",
          ),
        },
      );
    },
    deadlineMs + 1_000,
  );
}

for (const [flag, marker, term] of [
  ["--unused", "TUI_UNUSED_OK", "xterm-256color"],
  ["--dumb", "TUI_DUMB_OK", "dumb"],
] as const) {
  test(
    `real PTY ${flag}: no terminal acquisition or native import`,
    async () => {
      await withPty(
        [flag],
        async (pty) => {
          await pty.done(marker);
          assert.equal(pty.terminal.entered, 0);
          assert.equal(pty.stdout.includes("\x1b"), false);
        },
        {
          TERM: term,
          LOG_LEVEL: "ERROR",
          NAPI_RS_NATIVE_LIBRARY_PATH: join(
            tmpdir(),
            "junco-tui-binding-does-not-exist.node",
          ),
        },
      );
    },
    deadlineMs + 1_000,
  );
}

const portable = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Existing Pi peers may own process cleanup hooks; importing/selecting the tracer adds none.
import "junco-agent";
import "junco-tools";
import "junco-scheduler";
import "junco-mcp";
const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal));
const addons = Object.keys(require.cache).filter((path) => path.endsWith(".node"));
// Loading-boundary test: static root import would execute before the captured baselines.
const { JuncoGraph, Deterministic, tracer, graph, trigger, schedulers } = await import("junco-agency");
import { LockPolicy } from "junco-tools";
assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal)), listeners);
assert.deepEqual(Object.keys(require.cache).filter((path) => path.endsWith(".node")), addons);
assert.ok(tracer.TuiTracer.shared() instanceof tracer.DummyTracer);
const resultEdge = graph.Edge.value("quiet->$sink");
const source = new graph.nodes.Source(() => { throw new graph.DataflowDefinitionError("Portable graph does not accept external input"); }, { id: graph.NodeId.create("$source") });
const sink = new graph.nodes.Sink(async function* () { yield []; const result = flow.result(graph.NodeId.create("quiet")); if (result._tag !== "Some") throw new Error("quiet result is absent"); return result.value; }, { id: graph.NodeId.create("$sink"), trigger: trigger.TriggerRule.when(resultEdge) });
const flow = new JuncoGraph(source, sink, graph.Width.create(1), graph.UNBOUNDED, undefined, LockPolicy);
const execution = schedulers.context({ graph: flow, scheduler: schedulers.parallel() });
const id = flow.addNode({ id: graph.NodeId.create("quiet"), trigger: trigger.TriggerRule.always(), state: new Deterministic(async function* () { yield []; return "done"; }, LockPolicy) });
flow.addEdge(id, sink.id, resultEdge);
assert.equal((await execution.run()).get(id), "done");
await flow.close();
await tracer.TuiTracer.shared().flush();
await assert.rejects(tracer.TuiTracer.create(), (error) => error instanceof Error && error.message === ${JSON.stringify(terminalError)});
assert.deepEqual(Object.keys(require.cache).filter((path) => path.endsWith(".node")), addons);
// The loader is real and configured with an absent binary: no stub or mocked native module.
await assert.rejects(import("junco-tools/native"));
console.log("TUI_PORTABLE_OK");
`;

for (const term of ["xterm-256color", "dumb"]) {
  test(
    `piped execution with TERM=${term} imports and computes without native bindings, traces or terminal escapes`,
    async () => {
      const child = Bun.spawn(
        [process.execPath, "--no-install", "--eval", portable],
        {
          cwd: root,
          env: {
            ...process.env,
            TERM: term,
            LOG_LEVEL: "ERROR",
            NAPI_RS_NATIVE_LIBRARY_PATH: join(
              tmpdir(),
              "junco-tui-binding-does-not-exist.node",
            ),
            NAPI_RS_FORCE_WASI: "",
            NAPI_RS_WASI_FLAVOR: "",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        assert.equal(code, 0, `${stderr}\n${stdout}`);
        assert.equal(stdout.trim(), "TUI_PORTABLE_OK");
        assert.equal(stderr, "");
        assert.equal(stdout.includes("\x1b"), false);
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    },
    deadlineMs + 1_000,
  );
}
