// The Ralph round controller for `workflows.ralph`: availability hooks for `syntax`'s
// `BuildOptions.available`. Ralph runs once per round in the same agent session; only the last
// round reaches $sink. A native yield resumes the running node without counting as a round.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type AvailabilityFn,
  type Edge,
  EdgeId,
  NodeId,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import type { JuncoAgent } from "junco-agent";
import type { AgenticInput } from "../../agentic.js";
import type { JuncoGraph } from "../../junco-graph.js";
import type { MockAgent } from "../../mock-agent.js";
import { finalText } from "../../syntax/build.js";

export type RalphOptions = {
  /** Full-assignment rounds to run; a positive safe integer, two when omitted. */
  readonly rounds?: number;
};
/** Factories keyed by node id, the shape of `syntax.BuildOptions.available`. */
export type Availability = Readonly<
  Record<
    string,
    (context: {
      graph: JuncoGraph;
      edges: ReadonlyMap<string, Edge<AgenticInput, AssistantMessage>>;
    }) => AvailabilityFn<AgenticInput, AssistantMessage> | undefined
  >
>;

type Progress = {
  completed: number;
  last: AssistantMessage | undefined;
  assignment: string | undefined;
};
type Prompt = NonNullable<Parameters<JuncoAgent["stagePrompt"]>[0]>;

const NODE = NodeId.create("Ralph");
const INPUT = EdgeId.create("$source~>Ralph");
const LOOP = "Ralph->Ralph";

/** @throws {RangeError} when `rounds` is not a positive safe integer. */
export function ralph(options: RalphOptions = {}): {
  readonly available: Availability;
} {
  const rounds = options.rounds ?? 2;
  if (!(Number.isSafeInteger(rounds) && rounds >= 1))
    throw new RangeError("Ralph rounds must be a positive safe integer");
  const progress = new WeakMap<JuncoGraph, Progress>();
  /** Every distinct retained result of Ralph completes one round on this graph level. */
  const track = (graph: JuncoGraph): Progress => {
    let p = progress.get(graph);
    if (p === undefined) {
      p = { completed: 0, last: undefined, assignment: undefined };
      progress.set(graph, p);
    }
    const current = O.toUndefined(graph.result(NODE));
    if (current !== undefined && current !== p.last) {
      p.last = current;
      p.completed++;
    }
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
        assignment!.kind !== "prompt" ||
        (assignment!.images?.length ?? 0) > 0
      )
        throw new Error("Ralph requires exactly one prompt assignment");
      p.assignment = assignment!.text;
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
      Ralph: ({ graph, edges }) =>
        edges.has(LOOP)
          ? (_view, triggered) => {
              const node = graph.getNode(NODE)!;
              if (node.status === "running") return true;
              const p = track(graph);
              if (!triggered || p.completed >= rounds) return false;
              const agent = node.state as JuncoAgent | MockAgent;
              // Only an idle agent is staged, once per round; repeated availability probes are safe.
              if (agent.status === "idle")
                agent.stagePrompt(p.completed === 0 ? first(p) : revision(p));
              return agent.status === "ready";
            }
          : undefined,
      $sink: ({ graph, edges }) =>
        edges.has(LOOP)
          ? (_view, triggered) => triggered && track(graph).completed >= rounds
          : undefined,
    },
  };
}
