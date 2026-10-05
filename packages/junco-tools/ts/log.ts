import { DefaultLogLevels, type ILogObj, Logger } from "tslog";
import type { NativePolicyDecision } from "../native/index.js";

/** `LOG_LEVEL`, read once at startup: blank or missing is INFO; anything unknown is refused. */
function startupLevel(): DefaultLogLevels {
  const name = (process.env.LOG_LEVEL ?? "").trim().toUpperCase() || "INFO";
  // Numeric names (`"2"`) resolve to reverse-enum strings, not levels.
  const level = DefaultLogLevels[name as keyof typeof DefaultLogLevels];
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

function shared(): Logger<ILogObj> {
  const global = globalThis as { [SLOT]?: Logger<ILogObj> };
  global[SLOT] ??= new Logger<ILogObj>({
    name: "junco",
    type: "pretty",
    minLevel: startupLevel(),
    prettyLogTemplate: "{{logLevelName}} ",
    stylePrettyLogs: false,
    hideLogPositionForProduction: true,
    prettyInspectOptions: {
      colors: false,
      depth: null,
      maxArrayLength: null,
      maxStringLength: null,
      compact: true,
      breakLength: Number.POSITIVE_INFINITY,
      getters: false,
      customInspect: false,
    },
  });
  return global[SLOT];
}

/** The application's one stdout logger: trace records, policy decisions and warnings. */
export const log: Logger<ILogObj> = shared();

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

/** Resolve once everything already written to stdout has been handed to the stream. */
export async function flushLog(): Promise<void> {
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
