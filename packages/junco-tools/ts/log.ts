import { type ILogObj, Logger, LogLevel } from "tslog";
import type { NativePolicyDecision } from "../native/index.js";

/** `LOG_LEVEL`, read once at startup: blank or missing is INFO; anything unknown is refused. */
function startupLevel(): LogLevel {
  const name = (process.env.LOG_LEVEL ?? "").trim().toUpperCase() || "INFO";
  // Numeric names (`"2"`) resolve to reverse-enum strings, not levels.
  const level = LogLevel[name as keyof typeof LogLevel];
  if (typeof level !== "number") {
    throw new Error(
      "Junco LOG_LEVEL must be one of SILLY, TRACE, DEBUG, INFO, WARN, ERROR, FATAL",
    );
  }
  return level;
}

// Every copy of this module in one realm — source, dist, or a bundled package — shares this
// logger, exactly as the ShellMux registry is shared.
const SLOT = Symbol.for("junco-tools.log");
const OUTPUT_SLOT = Symbol.for("junco-tools.log.output");
type LogOutput = { write(line: string): void; flush(): Promise<void> };
const outputRegistry = globalThis as typeof globalThis & {
  [OUTPUT_SLOT]?: LogOutput;
};

function shared(): Logger<ILogObj> {
  const global = globalThis as { [SLOT]?: Logger<ILogObj> };
  global[SLOT] ??= new Logger<ILogObj>({
    name: "junco",
    type: "pretty",
    minLevel: startupLevel(),
    pretty: {
      template: "{{logLevelName}} ",
      style: false,
      inspectOptions: {
        colors: false,
        depth: null,
        maxArrayLength: null,
        maxStringLength: null,
        compact: true,
        breakLength: Number.POSITIVE_INFINITY,
        getters: false,
        customInspect: false,
      },
    },
    stack: { capture: "off" },
    // Keep tslog 4's record shape and default masking; v5 renamed `_meta` and masks nothing.
    meta: { property: "_meta" },
    mask: { keys: ["password"] },
  });
  return global[SLOT];
}

/** The application's one stdout logger: trace records, policy decisions and warnings. */
export const log: Logger<ILogObj> = shared();

/** Own the logger's output until the returned idempotent release restores its method table. */
export function redirectLog(output: LogOutput): () => void {
  if (outputRegistry[OUTPUT_SLOT] !== undefined) {
    throw new Error("Junco log output is already redirected");
  }
  const previous = log.settings.pretty.levelMethod;
  outputRegistry[OUTPUT_SLOT] = output;
  log.settings.pretty.levelMethod = {
    "*": (line) => output.write(line as string),
  };
  let released = false;
  return () => {
    if (released) return;
    released = true;
    log.settings.pretty.levelMethod = previous;
    delete outputRegistry[OUTPUT_SLOT];
  };
}

/**
 * The native `onPolicyDecision` sink. Grants are tentative and DEBUG; violations are INFO. A
 * callback error is rethrown so the native drain latches it and reports it at mux close.
 */
export function logPolicyDecision(
  error: Error | null,
  data: NativePolicyDecision,
): void {
  if (error !== null) throw error;
  if (data.granted) {
    log.debug("junco-policy authorize: capability granted (tentative)", data);
  } else {
    log.info("junco-policy authorize: policy violated", data);
  }
}

/** Fence the owned sink, or stdout when output has not been redirected. */
export async function flushLog(): Promise<void> {
  const output = outputRegistry[OUTPUT_SLOT];
  if (output !== undefined) {
    await output.flush();
    return;
  }
  const stdout = process.stdout;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  // Consumes the stream's own `error` event for this barrier's failed write.
  const onError = (error: Error): void => reject(error);
  stdout.once("error", onError);
  try {
    stdout.write("", (error) => {
      if (error == null) {
        stdout.off("error", onError);
        resolve();
      } else {
        reject(error);
      }
    });
  } catch (error) {
    stdout.off("error", onError);
    reject(error);
  }
  await promise;
}
