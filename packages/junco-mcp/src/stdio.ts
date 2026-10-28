import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  type JsonRpcMessage,
  McpConnectionClosedError,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
  parseJsonRpcMessage,
  type StdioTransportOptions,
} from "@earendil-works/pi-mcp";
import type { NativeMux, NativeProcess, NativeRunResult } from "junco-tools";

/** pi-mcp's stdio message bound; upstream does not export its constant. */
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** pi-mcp's default stderr diagnostics bound. */
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Upstream stdio options with the working directory already resolved. */
export interface ShellMuxStdioTransportOptions extends StdioTransportOptions {
  readonly cwd: string;
  /**
   * Close by cancelling the server, discarding every effect of its managed command, instead
   * of ending standard input and publishing them. A server that exits on its own before
   * cancellation wins fails `closed`, because its effects may have published.
   */
  readonly discardOnClose?: boolean;
}

interface QueuedWrite {
  readonly data: Buffer;
  resolve(): void;
  reject(error: Error): void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The server environment, normalized as upstream's stdio transport does. */
function serverEnvironment(
  options: StdioTransportOptions,
): Record<string, string> {
  const merged =
    options.inheritEnv === false
      ? { ...options.env }
      : { ...process.env, ...options.env };
  return Object.fromEntries(
    Object.entries(merged).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * MCP stdio transport whose server runs as one managed job of the shared Junco ShellMux.
 *
 * Native output callbacks only enqueue work; framing, listeners, and teardown run on one
 * deferred delivery queue, so they never reenter the mux synchronously. Native code owns
 * EOF, TERM, and cancellation timing; `closed` settles after that queue and the native
 * final verdict, and rejects unless the process finalized successfully.
 */
export class ShellMuxStdioTransport implements McpTransport {
  readonly #mux: NativeMux;
  readonly #options: Readonly<ShellMuxStdioTransportOptions>;
  readonly #principal = `junco-mcp-${randomUUID()}`;
  readonly #maxMessageBytes: number;
  readonly #messageListeners = new Set<McpTransportMessageListener>();
  readonly #errorListeners = new Set<McpTransportErrorListener>();
  readonly #closeListeners = new Set<McpTransportCloseListener>();
  readonly #failures: Error[] = [];
  readonly #closed: Promise<void>;
  readonly #resolveClosed: () => void;
  readonly #rejectClosed: (error: Error) => void;
  readonly #stderrDecoder = new TextDecoder();
  #process: NativeProcess | undefined;
  #finishing: Promise<NativeRunResult> | undefined;
  #terminal: Error | undefined;
  #started = false;
  #closeRequested = false;
  #exited = false;
  #aborted = false;
  #failed = false;
  #closeEmitted = false;
  #settled = false;
  #queue: QueuedWrite[] = [];
  #writing: Promise<void> | undefined;
  #delivery: Promise<void> = Promise.resolve();
  #stdout: Buffer[] = [];
  #stdoutBytes = 0;
  #stderr: Buffer[] = [];
  #stderrBytes = 0;

  constructor(mux: NativeMux, options: ShellMuxStdioTransportOptions) {
    this.#mux = mux;
    this.#options = Object.freeze({
      ...options,
      args: options.args ? [...options.args] : undefined,
      env: options.env ? { ...options.env } : undefined,
    });
    this.#maxMessageBytes =
      options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#closed = promise;
    this.#resolveClosed = resolve;
    this.#rejectClosed = reject;
    // Observed here; callers still receive the original promise and its rejection.
    promise.catch(() => {});
  }

  /** Settles after output delivery and native finalization; rejects on any failure. */
  get closed(): Promise<void> {
    return this.#closed;
  }

  /** The failure that ended the connection, unless the client closed it first. */
  get terminalError(): Error | undefined {
    return this.#terminal;
  }

  /** The last `DEFAULT_MAX_STDERR_BYTES` of piped stderr, for diagnostics. */
  get stderr(): string {
    return Buffer.concat(this.#stderr, this.#stderrBytes).toString("utf8");
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("MCP stdio transport already started");
    if (this.#closeRequested) throw new McpConnectionClosedError();
    this.#started = true;
    const options = this.#options;
    let child: NativeProcess;
    try {
      child = await this.#mux.spawn(
        {
          command: options.command,
          ...(options.args ? { args: [...options.args] } : {}),
          cwd: options.cwd,
          principal: this.#principal,
          env: serverEnvironment(options),
        },
        (error, data) => this.#receive(error, data, false),
        (error, data) => this.#receive(error, data, true),
      );
    } catch (error) {
      const cause = toError(error);
      this.#record(cause);
      if (!this.#closeRequested) this.#terminal ??= cause;
      this.#exited = true;
      this.#defer(() => this.#finalize(undefined));
      throw cause;
    }
    this.#process = child;
    const natural = child.wait();
    const onExit = () => {
      this.#exited = true;
      const source = this.#finishing ?? natural;
      this.#defer(() => this.#finalize(source));
    };
    natural.then(onExit, onExit);
    if (this.#failed) {
      this.#abort();
      throw new McpConnectionClosedError();
    }
    if (this.#closeRequested) {
      // Closed during admission: still stop the process that was admitted.
      this.#requestFinish();
      throw new McpConnectionClosedError();
    }
  }

  send(message: JsonRpcMessage): Promise<void> {
    if (
      !this.#process ||
      this.#closeRequested ||
      this.#failed ||
      this.#exited
    ) {
      return Promise.reject(new McpConnectionClosedError());
    }
    let data: Buffer;
    try {
      data = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#queue.push({ data, resolve, reject });
    this.#pump();
    return promise;
  }

  /** Joins native finalization; a rejected finish aborts its process before close rejects. */
  close(): Promise<void> {
    if (!this.#closeRequested) {
      this.#closeRequested = true;
      this.#rejectQueued();
      if (!this.#started) {
        this.#exited = true;
        this.#emitClose();
        this.#settle();
      } else {
        this.#requestFinish();
      }
    }
    return this.#closed;
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    this.#messageListeners.add(listener);
    return () => {
      this.#messageListeners.delete(listener);
    };
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.#errorListeners.add(listener);
    return () => {
      this.#errorListeners.delete(listener);
    };
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  /** Native callback: enqueue only, never touch the mux or listeners synchronously. */
  #receive(error: Error | null, data: Buffer, stderr: boolean): void {
    if (error) {
      this.#defer(() => this.#fail(error));
      return;
    }
    this.#defer(() =>
      stderr ? this.#handleStderr(data) : this.#handleStdout(data),
    );
  }

  #defer(work: () => void | Promise<void>): void {
    this.#delivery = this.#delivery
      .then(work)
      .catch((error: unknown) => this.#fail(error));
  }

  #pump(): void {
    const child = this.#process;
    if (this.#writing || !child) return;
    const entry = this.#queue.shift();
    if (!entry) return;
    let write: Promise<void>;
    try {
      write = child.write(entry.data);
    } catch (error) {
      write = Promise.reject(error);
    }
    this.#writing = write
      .then(
        () => entry.resolve(),
        (error: unknown) => {
          const cause = toError(error);
          entry.reject(cause);
          // Behind queued output, so a final reply before exit is still delivered.
          this.#defer(() => {
            if (!this.#closeRequested && !this.#exited && !this.#failed) {
              this.#fail(cause);
            }
          });
        },
      )
      .finally(() => {
        this.#writing = undefined;
        this.#pump();
      });
  }

  #handleStdout(chunk: Buffer): void {
    if (this.#failed) return;
    const limit = this.#maxMessageBytes;
    let start = 0;
    for (
      let newline = chunk.indexOf(NEWLINE);
      newline >= 0;
      newline = chunk.indexOf(NEWLINE, start)
    ) {
      const length = this.#stdoutBytes + newline - start;
      if (length > limit) {
        throw new Error(`MCP stdio message exceeds ${limit} bytes`);
      }
      const segment = chunk.subarray(start, newline);
      const line =
        this.#stdout.length === 0
          ? segment
          : Buffer.concat([...this.#stdout, segment], length);
      this.#stdout = [];
      this.#stdoutBytes = 0;
      start = newline + 1;
      this.#handleLine(line);
      if (this.#failed) return;
    }
    if (start < chunk.length) {
      const length = this.#stdoutBytes + chunk.length - start;
      if (length > limit) {
        throw new Error(`MCP stdio message exceeds ${limit} bytes`);
      }
      this.#stdout.push(chunk.subarray(start));
      this.#stdoutBytes = length;
    }
  }

  #handleLine(line: Buffer): void {
    const end =
      line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN
        ? line.length - 1
        : line.length;
    let text: string;
    try {
      text = UTF8.decode(line.subarray(0, end));
    } catch (error) {
      throw new Error("MCP stdio server sent a frame that is not UTF-8", {
        cause: error,
      });
    }
    if (!text.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(JSON.parse(text));
    } catch (error) {
      throw new Error("MCP stdio server sent a malformed JSON-RPC message", {
        cause: error,
      });
    }
    for (const listener of [...this.#messageListeners]) listener(message);
  }

  #handleStderr(chunk: Buffer): void {
    if (this.#options.stderr === "inherit") {
      process.stderr.write(chunk);
      return;
    }
    this.#retainStderr(chunk);
    const text = this.#stderrDecoder.decode(chunk, { stream: true });
    if (text) this.#options.onStderr?.(text);
  }

  #retainStderr(chunk: Buffer): void {
    const limit = DEFAULT_MAX_STDERR_BYTES;
    if (chunk.length >= limit) {
      this.#stderr = [chunk.subarray(chunk.length - limit)];
      this.#stderrBytes = limit;
      return;
    }
    this.#stderr.push(chunk);
    this.#stderrBytes += chunk.length;
    while (this.#stderrBytes > limit) {
      const excess = this.#stderrBytes - limit;
      const first = this.#stderr[0] as Buffer;
      if (first.length <= excess) {
        this.#stderr.shift();
        this.#stderrBytes -= first.length;
      } else {
        this.#stderr[0] = first.subarray(excess);
        this.#stderrBytes -= excess;
      }
    }
  }

  /** A fatal frame, write, callback, or listener failure: stop only this process. */
  #fail(error: unknown): void {
    const cause = toError(error);
    this.#record(cause);
    if (this.#failed) return;
    this.#failed = true;
    if (!this.#closeRequested) this.#terminal ??= cause;
    this.#rejectQueued();
    this.#abort();
    this.#emitError(cause);
    this.#emitClose();
  }

  #abort(): void {
    const child = this.#process;
    if (!child || this.#exited || this.#aborted) return;
    this.#aborted = true;
    try {
      child.abort();
    } catch (error) {
      this.#record(toError(error));
    }
  }

  #requestFinish(): void {
    const child = this.#process;
    if (!child || this.#exited || this.#aborted || this.#finishing) return;
    if (this.#options.discardOnClose) {
      // The natural `wait()` already finalizes; it reports the cancellation.
      this.#abort();
      return;
    }
    try {
      const finishing = child.finish(this.#options.closeTimeoutMs);
      this.#finishing = finishing;
      // Rejection may mean termination was never requested; do not leave the process running.
      finishing.catch((error: unknown) => {
        this.#record(toError(error));
        this.#abort();
      });
    } catch (error) {
      this.#record(toError(error));
      this.#abort();
    }
  }

  #rejectQueued(): void {
    for (const entry of this.#queue.splice(0)) {
      entry.reject(new McpConnectionClosedError());
    }
  }

  /** Runs on the delivery queue, after every output delivery queued before exit. */
  async #finalize(source: Promise<NativeRunResult> | undefined): Promise<void> {
    let result: NativeRunResult | undefined;
    if (source) {
      try {
        result = await source;
      } catch (error) {
        this.#record(toError(error));
      }
    }
    this.#rejectQueued();
    await this.#writing;
    if (!this.#failed && this.#stdoutBytes > 0) {
      const rest = Buffer.concat(this.#stdout, this.#stdoutBytes);
      if (rest.toString("utf8").trim()) {
        const incomplete = new Error(
          "MCP stdio server closed with an incomplete JSON-RPC message",
        );
        this.#record(incomplete);
        this.#emitError(incomplete);
      }
    }
    this.#stdout = [];
    this.#stdoutBytes = 0;
    if (this.#options.stderr !== "inherit") {
      try {
        const text = this.#stderrDecoder.decode();
        if (text) this.#options.onStderr?.(text);
      } catch (error) {
        this.#record(toError(error));
      }
    }
    if (result?.cancelled && !this.#aborted) {
      this.#record(new Error("MCP stdio server was cancelled"));
    }
    if (!this.#closeRequested) {
      this.#terminal ??= this.#failures[0] ?? this.#exitError(result);
    }
    if (this.#options.discardOnClose && result && !result.cancelled) {
      this.#record(
        new Error(
          "MCP stdio server exited before its effects could be discarded",
        ),
      );
    }
    this.#emitClose();
    this.#settle();
  }

  #exitError(result: NativeRunResult | undefined): Error {
    const status =
      result?.exitCode === undefined
        ? "without an exit code"
        : `with code ${result.exitCode}`;
    const stderr = this.stderr.trim();
    return new Error(
      `MCP stdio server exited ${status}${stderr ? `\n${stderr}` : ""}`,
    );
  }

  #record(error: Error): void {
    if (!this.#failures.includes(error)) this.#failures.push(error);
  }

  #emitError(error: Error): void {
    for (const listener of [...this.#errorListeners]) {
      try {
        listener(error);
      } catch (listenerError) {
        this.#record(toError(listenerError));
      }
    }
  }

  #emitClose(): void {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    for (const listener of [...this.#closeListeners]) {
      try {
        listener();
      } catch (listenerError) {
        this.#record(toError(listenerError));
      }
    }
  }

  #settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    const [first] = this.#failures;
    if (!first) {
      this.#resolveClosed();
    } else if (this.#failures.length === 1) {
      this.#rejectClosed(first);
    } else {
      this.#rejectClosed(
        new AggregateError(this.#failures, "MCP stdio server cleanup failed", {
          cause: first,
        }),
      );
    }
  }
}
