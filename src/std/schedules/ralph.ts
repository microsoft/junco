// The Ralph round controller for `workflows.ralph`: availability hooks for `syntax`'s
// `BuildOptions.available`. Ralph runs once per round in the same agent session; only the last
// round (or, with `until`, the first successful one) reaches $sink. A native yield resumes the
// running node without counting as a round.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  EdgeId,
  type EdgeIdType,
  NodeId,
  type ParentView,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { JuncoAgent, TaskSchema } from "junco-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { JuncoGraph } from "../../junco-graph.js";
import { MockAgent } from "../../mock-agent.js";
import { type BuildOptions, finalText } from "../../syntax/build.js";

/** Synchronous success check of one completed Ralph result; `round` is one-based, `label` is the graph level's. */
export type RalphPredicate = (
  result: AssistantMessage,
  context: {
    /** The assignment's objectives in delivery order: one per prompt message on the assignment route. */
    readonly objectives: readonly string[];
    readonly round: number;
    readonly label: string;
  },
) => boolean;

/** Round control of `schedules.ralph`: a fixed `rounds` count, or an `until` success check with an optional `rounds` cap. */
export type RalphOptions = {
  /**
   * A positive safe integer. Without `until`: the full-assignment rounds to run, two when omitted.
   * With `until`: a hard cap (omitted: uncapped); a false decision at the cap fails Ralph.
   */
  readonly rounds?: number;
  /** Evaluated once per completed result: true publishes that result, false stages a revision. */
  readonly until?: RalphPredicate;
};
/** Ralph round control with bounded provider-error retries. */
export type RalphLoopOptions = RalphOptions & {
  /** Same-round re-runs after a provider-error result (`stopReason: "error"`), per Ralph level; 0 (default) keeps the error as the round's result. */
  readonly retries?: number;
};
/** Factories keyed by node id, the shape of `syntax.BuildOptions.available`. */
export type Availability = NonNullable<BuildOptions["available"]>;

type Progress = {
  completed: number;
  /** Provider-error results re-run so far. */
  retried: number;
  /** The next staging is a continuation of the same round. */
  retry: boolean;
  /** Ralph's latest retained result; `finalText` validates it before use. */
  last: unknown;
  /** One objective per admitted prompt message, in delivery order. */
  objectives: readonly string[] | undefined;
  /** The admitted objectives, numbered when there are several. */
  assignment: string | undefined;
  /** Ralph is over: its fixed rounds ran, or `until` accepted `last`. Both hooks read this one decision. */
  done: boolean;
  /** A cached success-mode failure, boxed so a falsy thrown value is still rethrown. */
  failure: { readonly error: unknown } | undefined;
};

const NODE = NodeId.create("Ralph");
const INPUT = EdgeId.create("$source~>Ralph");
const LOOP = "Ralph->Ralph";
const FIRST_ROUND =
  "Achieve the objectives in the user message(s) that follow this one, in order. Do your best and focus on depth (finish objectives well), not width (finish many objectives). Return the complete answer.";
export const RETRY =
  "Your previous attempt in this round ended with a provider error, not because the work was finished. Continue the same round: carry on with the objectives, in order, building on what you already did. Return the complete answer.";
const isProviderError = (result: unknown): boolean =>
  typeof result === "object" &&
  result !== null &&
  (result as { stopReason?: unknown }).stopReason === "error";

/** One objective verbatim; several as a numbered list in order. */
const listed = (objectives: readonly string[]): string =>
  objectives.length === 1
    ? objectives.join("")
    : objectives.map((text, i) => `${i + 1}. ${text}`).join("\n\n");

/**
 * @throws {RangeError} when `rounds` is not a positive safe integer or `retries` is not a non-negative safe integer.
 * @throws {TypeError} when `until` is not a function.
 */
export function createRalphController(options: RalphOptions = {}, retries = 0) {
  if (!(Number.isSafeInteger(retries) && retries >= 0))
    throw new RangeError("Ralph retries must be a non-negative safe integer");
  const { until } = options;
  const rounds = options.rounds ?? (until === undefined ? 2 : undefined);
  if (rounds !== undefined && !(Number.isSafeInteger(rounds) && rounds >= 1))
    throw new RangeError("Ralph rounds must be a positive safe integer");
  if (until !== undefined && typeof until !== "function")
    throw new TypeError("Ralph until must be a function");
  const levels = new WeakMap<JuncoGraph<TSchema, unknown>, Progress>();
  const progress = (graph: JuncoGraph<TSchema, unknown>): Progress => {
    let p = levels.get(graph);
    if (p === undefined) {
      p = {
        completed: 0,
        retried: 0,
        retry: false,
        last: undefined,
        objectives: undefined,
        assignment: undefined,
        done: false,
        failure: undefined,
      };
      levels.set(graph, p);
    }
    if (p.failure !== undefined) throw p.failure.error;
    return p;
  };
  /** Records a same-round re-run when `current` is a provider-error result and retries remain. */
  const retry = (p: Progress, current: unknown): boolean => {
    if (!(isProviderError(current) && p.retried < retries)) return false;
    p.retried++;
    return true;
  };
  /**
   * Every distinct retained result completes one round unless retried after a provider error;
   * a success-mode failure is cached so later probes rethrow it without another call.
   */
  const track = (
    graph: JuncoGraph<TSchema, unknown>,
    label: string,
  ): Progress => {
    const p = progress(graph);
    const current = O.toUndefined(graph.result(NODE));
    if (
      p.failure === undefined &&
      current !== undefined &&
      current !== p.last
    ) {
      // Identity first: user code never sees, and so never re-decides, the same result twice.
      p.last = current;
      if (retry(p, current)) {
        p.retry = true;
        return p; // the same round runs again; nothing was decided
      }
      p.completed++;
      if (until === undefined) p.done = p.completed >= (rounds ?? Infinity);
      else
        try {
          finalText(current, "Ralph");
          if (p.objectives === undefined)
            throw new Error("Ralph requires one or more prompt objectives");
          const decision: unknown = until(current as AssistantMessage, {
            objectives: p.objectives,
            round: p.completed,
            label,
          });
          if (typeof decision !== "boolean")
            throw new TypeError("Ralph until must return a boolean");
          p.done = decision;
          if (!decision && rounds !== undefined && p.completed >= rounds)
            throw new Error("Ralph reached the round limit without success");
        } catch (error) {
          p.failure = { error };
        }
    }
    if (p.failure !== undefined) throw p.failure.error;
    return p;
  };
  /** Admits the assignment: every message on `input`, in delivery order, is one image-free prompt objective. */
  const admit = (
    p: Progress,
    view: ParentView<TSchema, unknown>,
    input: EdgeIdType,
  ): string => {
    const batch = view.messages.get(input) ?? [];
    const foreign =
      [...view.messages.keys()].some(
        (id) => id !== input && (view.messages.get(id)?.length ?? 0) > 0,
      ) || [...view.values.keys()].length > 0;
    const objectives: string[] = [];
    for (const objective of batch) {
      if (
        !Value.Check(TaskSchema, objective) ||
        objective.kind !== "prompt" ||
        (objective.images?.length ?? 0) > 0
      )
        break;
      objectives.push(objective.text);
    }
    if (foreign || batch.length === 0 || objectives.length !== batch.length)
      throw new Error("Ralph requires one or more prompt objectives");
    p.objectives = objectives;
    p.assignment = listed(p.objectives);
    return p.assignment;
  };
  // The last answer is already in session history; repeating it doubles context.
  const revision = (p: Progress): string => {
    if (p.objectives === undefined)
      throw new Error("Ralph requires one or more prompt objectives");
    finalText(p.last, "Ralph");
    return `Take another try at achieving some of these objectives, in order, building on your previous answer (your last message above):\n\n${listed(p.objectives)}\n\nDo your best and focus on depth (finish objectives well), not width (finish many objectives). Return the complete revised answer.`;
  };
  return { progress, track, admit, revision, retry };
}

/** Availability hooks for the original, non-memory Ralph workflow. */
export function ralph(options: RalphLoopOptions = {}): {
  readonly available: Availability;
} {
  const { track, admit, revision } = createRalphController(
    options,
    options.retries ?? 0,
  );
  return {
    available: {
      Ralph: ({ graph, edges, label }) =>
        edges.has(LOOP)
          ? (view, triggered) => {
              const node = graph.getNode(NODE);
              if (node === undefined) throw new Error("Ralph node missing");
              if (node.status === "running") return true;
              const p = track(graph, label);
              if (!triggered || p.done) return false;
              const agent = node.state;
              if (!(agent instanceof JuncoAgent || agent instanceof MockAgent))
                throw new TypeError("Ralph must be an agent node");
              // Only an idle agent is staged, once per round; repeated availability probes are safe.
              if (agent.status === "idle") {
                if (p.retry) {
                  p.retry = false;
                  agent.stagePrompt(RETRY);
                } else {
                  if (p.completed === 0) admit(p, view, INPUT);
                  agent.stagePrompt(
                    p.completed === 0 ? FIRST_ROUND : revision(p),
                  );
                }
              }
              return agent.status === "ready";
            }
          : undefined,
      $sink: ({ graph, edges, label }) =>
        edges.has(LOOP)
          ? (_view, triggered) => triggered && track(graph, label).done
          : undefined,
    },
  };
}
