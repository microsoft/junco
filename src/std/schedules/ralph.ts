// The Ralph round controller for `workflows.ralph`: availability hooks for `syntax`'s
// `BuildOptions.available`. Ralph runs once per round in the same agent session; only the last
// round (or, with `until`, the first successful one) reaches $sink. A native yield resumes the
// running node without counting as a round.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EdgeId, NodeId, type ParentView } from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { AgenticInputSchema, JuncoAgent } from "junco-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { JuncoGraph } from "../../junco-graph.js";
import { MockAgent } from "../../mock-agent.js";
import { type BuildOptions, finalText } from "../../syntax/build.js";

/** Synchronous success check of one completed Ralph result; `round` is one-based, `label` is the graph level's. */
export type RalphPredicate = (
  result: AssistantMessage,
  context: {
    readonly assignment: string;
    readonly round: number;
    readonly label: string;
  },
) => boolean;

export type RalphOptions = {
  /**
   * A positive safe integer. Without `until`: the full-assignment rounds to run, two when omitted.
   * With `until`: a hard cap (omitted: uncapped); a false decision at the cap fails Ralph.
   */
  readonly rounds?: number;
  /** Evaluated once per completed result: true publishes that result, false stages a revision. */
  readonly until?: RalphPredicate;
};
/** Factories keyed by node id, the shape of `syntax.BuildOptions.available`. */
export type Availability = NonNullable<BuildOptions["available"]>;

type Progress = {
  completed: number;
  /** Ralph's latest retained result; `finalText` validates it before use. */
  last: unknown;
  assignment: string | undefined;
  /** Ralph is over: its fixed rounds ran, or `until` accepted `last`. Both hooks read this one decision. */
  done: boolean;
  /** A cached success-mode failure, boxed so a falsy thrown value is still rethrown. */
  failure: { readonly error: unknown } | undefined;
};
type Prompt = (inputs: ParentView<TSchema, unknown>) => string;

const NODE = NodeId.create("Ralph");
const INPUT = EdgeId.create("$source~>Ralph");
const LOOP = "Ralph->Ralph";

/**
 * @throws {RangeError} when `rounds` is not a positive safe integer.
 * @throws {TypeError} when `until` is not a function.
 */
export function ralph(options: RalphOptions = {}): {
  readonly available: Availability;
} {
  const { until } = options;
  const rounds = options.rounds ?? (until === undefined ? 2 : undefined);
  if (rounds !== undefined && !(Number.isSafeInteger(rounds) && rounds >= 1))
    throw new RangeError("Ralph rounds must be a positive safe integer");
  if (until !== undefined && typeof until !== "function")
    throw new TypeError("Ralph until must be a function");
  const progress = new WeakMap<JuncoGraph<TSchema, unknown>, Progress>();
  /**
   * Every distinct retained result of Ralph completes one round on this graph level and is decided
   * once; a success-mode failure is cached so later probes rethrow it without another call.
   */
  const track = (
    graph: JuncoGraph<TSchema, unknown>,
    label: string,
  ): Progress => {
    let p = progress.get(graph);
    if (p === undefined) {
      p = {
        completed: 0,
        last: undefined,
        assignment: undefined,
        done: false,
        failure: undefined,
      };
      progress.set(graph, p);
    }
    const current = O.toUndefined(graph.result(NODE));
    if (
      p.failure === undefined &&
      current !== undefined &&
      current !== p.last
    ) {
      // Identity first: user code never sees, and so never re-decides, the same result twice.
      p.last = current;
      p.completed++;
      if (until === undefined) p.done = p.completed >= (rounds ?? Infinity);
      else
        try {
          finalText(current, "Ralph");
          if (p.assignment === undefined)
            throw new Error("Ralph requires exactly one prompt assignment");
          const decision: unknown = until(current as AssistantMessage, {
            assignment: p.assignment,
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
  const first =
    (p: Progress): Prompt =>
    (inputs) => {
      const batch = inputs.messages.get(INPUT) ?? [];
      const foreign =
        [...inputs.messages.keys()].some(
          (id) => id !== INPUT && (inputs.messages.get(id)?.length ?? 0) > 0,
        ) || [...inputs.values.keys()].length > 0;
      const [assignment] = batch;
      if (
        foreign ||
        batch.length !== 1 ||
        !Value.Check(AgenticInputSchema, assignment) ||
        assignment.kind !== "prompt" ||
        (assignment.images?.length ?? 0) > 0
      )
        throw new Error("Ralph requires exactly one prompt assignment");
      p.assignment = assignment.text;
      return p.assignment;
    };
  const revision =
    (p: Progress): Prompt =>
    () => {
      if (p.assignment === undefined)
        throw new Error("Ralph requires exactly one prompt assignment");
      const previous = finalText(p.last, "Ralph");
      return `${p.assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;
    };
  return {
    available: {
      Ralph: ({ graph, edges, label }) =>
        edges.has(LOOP)
          ? (_view, triggered) => {
              const node = graph.getNode(NODE);
              if (node === undefined) throw new Error("Ralph node missing");
              if (node.status === "running") return true;
              const p = track(graph, label);
              if (!triggered || p.done) return false;
              const agent = node.state;
              if (!(agent instanceof JuncoAgent || agent instanceof MockAgent))
                throw new TypeError("Ralph must be an agent node");
              // Only an idle agent is staged, once per round; repeated availability probes are safe.
              if (agent.status === "idle")
                agent.stagePrompt(p.completed === 0 ? first(p) : revision(p));
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
