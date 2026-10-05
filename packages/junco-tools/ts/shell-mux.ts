import type { NativeMux } from "../native/index.js";
import type { NativeModule } from "./native.js";

type Sandbox = "shared" | "always";

/** A consumer's hold on the application's one ShellMux. Releasing it never closes the mux. */
export interface ShellMuxLease {
  readonly mux: NativeMux;
  readonly native: NativeModule;
  /** True after release or application-generation shutdown. */
  readonly closed: boolean;
  release(): void;
}

interface AcquireOptions {
  readonly native?: NativeModule;
  readonly mux?: NativeMux;
  readonly sandbox?: Sandbox;
}

/**
 * One application lifetime of the singleton: opened at most once, closed at most once by
 * {@link shutdownShellMux}, and never reopened. A later generation starts only after this one's
 * shutdown completed.
 */
export interface ShellMuxGeneration {
  state: "idle" | "opening" | "open" | "closing" | "closed";
  /** The single raw open (or adoption) attempt, published before it is awaited. */
  opening?: Promise<NativeMux>;
  native?: NativeModule;
  sandbox?: Sandbox;
  mux?: NativeMux;
  shutdown?: Promise<void>;
}

interface Registry {
  readonly version: typeof PROTOCOL_VERSION;
  current: ShellMuxGeneration;
}

const PROTOCOL_VERSION = 1;
// Every copy of this module in one realm — source, dist, or a bundled package — shares this
// registry, so they share the one mux the loaded addon permits.
const REGISTRY = Symbol.for("junco-tools.shellmux");

function registry(): Registry {
  const global = globalThis as { [REGISTRY]?: Registry };
  const existing = global[REGISTRY];
  if (existing === undefined) {
    const created: Registry = {
      version: PROTOCOL_VERSION,
      current: { state: "idle" },
    };
    global[REGISTRY] = created;
    return created;
  }
  if (existing.version !== PROTOCOL_VERSION) {
    throw new Error(
      `Incompatible junco-tools ShellMux registry version ${String(existing.version)}; expected ${PROTOCOL_VERSION}`,
    );
  }
  return existing;
}

/**
 * The generation a lazy consumer created now will acquire from, captured synchronously. A
 * closed generation stays current — replaying its shutdown result — until this starts the next.
 */
export function currentShellMuxGeneration(): ShellMuxGeneration {
  const shared = registry();
  if (shared.current.state === "closed") shared.current = { state: "idle" };
  return shared.current;
}

function shutDown(): Error {
  return new Error("ShellMux session is closed");
}

function fenced(generation: ShellMuxGeneration): boolean {
  return generation.state === "closing" || generation.state === "closed";
}

/** Rejects a configuration the generation's open mux cannot serve, before anything runs. */
function checkConfiguration(
  generation: ShellMuxGeneration,
  options: AcquireOptions,
): void {
  if (options.native !== undefined && generation.native !== undefined) {
    if (options.native !== generation.native) {
      throw new Error(
        "acquireShellMux: a different native module cannot share the open ShellMux",
      );
    }
  }
  if (options.sandbox !== undefined && generation.sandbox !== undefined) {
    if (options.sandbox !== generation.sandbox) {
      throw new Error(
        `acquireShellMux: sandbox "${options.sandbox}" conflicts with the open ShellMux's "${generation.sandbox}"`,
      );
    }
  }
  if (options.mux !== undefined && generation.mux !== undefined) {
    if (options.mux !== generation.mux) {
      throw new Error(
        "acquireShellMux: a different mux cannot be adopted while another is open",
      );
    }
  }
}

function beginOpening(
  generation: ShellMuxGeneration,
  cwd: string,
  options: AcquireOptions,
): Promise<NativeMux> {
  const adopted = options.mux;
  generation.state = "opening";
  generation.native = options.native;
  generation.sandbox = options.sandbox ?? adopted?.sandbox ?? "shared";
  const opening = (async () => {
    if (adopted !== undefined) {
      // Strict adoption: its own mode and seed, still open. A refusal leaves it the caller's.
      if (
        options.sandbox !== undefined &&
        options.sandbox !== adopted.sandbox
      ) {
        throw new Error(
          `acquireShellMux: sandbox "${options.sandbox}" conflicts with the adopted mux's "${adopted.sandbox}"`,
        );
      }
      await adopted.validateCwd(cwd);
      return adopted;
    }
    // Dynamic by design: importing junco-tools must not load the addon.
    const native = options.native ?? (await import("junco-tools/native"));
    generation.native = native;
    return native.NativeMux.open(cwd, { sandbox: generation.sandbox });
  })();
  generation.opening = opening;
  opening.then(
    (mux) => {
      if (generation.opening !== opening) return;
      generation.mux = mux;
      // A shutdown that fenced the attempt closes this mux itself.
      if (generation.state === "opening") generation.state = "open";
    },
    () => {
      // No handle exists; the attempt's callers receive its failure. A later acquisition of
      // this still-unfenced generation may try again.
      if (generation.opening !== opening || generation.state !== "opening")
        return;
      generation.state = "idle";
      generation.opening = undefined;
      generation.native = undefined;
      generation.sandbox = undefined;
    },
  );
  return opening;
}

class Lease implements ShellMuxLease {
  #released = false;

  constructor(
    readonly mux: NativeMux,
    readonly native: NativeModule,
    readonly generation: ShellMuxGeneration,
  ) {}

  get closed(): boolean {
    return this.#released || fenced(this.generation);
  }

  release(): void {
    this.#released = true;
  }
}

/** {@link acquireShellMux} against an already captured generation. */
export async function acquireShellMuxFrom(
  generation: ShellMuxGeneration,
  cwd: string,
  options: AcquireOptions = {},
): Promise<ShellMuxLease> {
  if (options.mux !== undefined && options.native === undefined) {
    throw new Error(
      "acquireShellMux: an adopted mux requires the native module that created it",
    );
  }
  if (fenced(generation)) throw shutDown();
  checkConfiguration(generation, options);
  // An opening or open generation retains its one attempt.
  const opening =
    generation.state === "idle"
      ? beginOpening(generation, cwd, options)
      : generation.opening;
  if (opening === undefined) throw shutDown();
  const mux = await opening;
  if (fenced(generation)) throw shutDown();
  checkConfiguration(generation, options);
  // Every acquisition validates its own cwd; a refusal affects only this caller.
  await mux.validateCwd(cwd);
  const native = generation.native;
  if (fenced(generation) || native === undefined) throw shutDown();
  return new Lease(mux, native, generation);
}

/**
 * A lease on the application's one ShellMux: every agent, graph, tool collection, operations
 * owner and MCP connection in this JavaScript realm receives the same `NativeMux` object.
 *
 * The first acquisition opens it at `cwd` (default sandbox `"shared"`), or adopts a pre-opened
 * `mux`, which then belongs to this boundary. Later acquisitions inherit its native module and
 * mode; an explicitly different native module, sandbox, or mux is refused before anything
 * runs. Every acquisition validates its own `cwd` against the mux's seed.
 */
export function acquireShellMux(
  cwd: string,
  options?: {
    readonly native?: NativeModule;
    /** Adopts this pre-opened mux as the application singleton; requires native. */
    readonly mux?: NativeMux;
    /** First acquisition defaults to shared; omission later inherits the active mode. */
    readonly sandbox?: "shared" | "always";
  },
): Promise<ShellMuxLease> {
  return acquireShellMuxFrom(currentShellMuxGeneration(), cwd, options);
}

/**
 * Application shutdown: fences the current generation at once — every lease, operations owner,
 * collection and connection of it stays closed forever — awaits an in-flight open, and closes
 * the mux exactly once. Every caller until a new consumer starts joins one result, including a
 * close failure. Only a consumer created after this resolves may open a new generation.
 */
export function shutdownShellMux(): Promise<void> {
  const generation = registry().current;
  generation.shutdown ??= (async () => {
    const opening = generation.opening;
    generation.state = "closing";
    try {
      let mux = generation.mux;
      if (mux === undefined && opening !== undefined) {
        try {
          mux = await opening;
        } catch {
          // A failed open holds no handle; its acquisition reported the failure.
        }
      }
      await mux?.close();
    } finally {
      generation.state = "closed";
    }
  })();
  return generation.shutdown;
}
