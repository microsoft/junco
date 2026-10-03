import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import {
  always,
  type DataflowScheduler,
  type Edge,
  from,
  msg,
  type NodeGenerator,
  NodeId,
  type NodeIdType,
  type NodeOptions,
  type NodeSchedule,
  type ParentView,
  triggerInputs,
  UNBOUNDED,
  when,
  Width,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type JuncoAgent, JuncoAgentError } from "junco-agent";
import { createScheduler } from "junco-scheduler";
import type { AgenticInput } from "../agentic.js";
import { graphNode } from "../graph-node.js";
import { JuncoGraph } from "../junco-graph.js";

/** Registration options for {@link ralph}; trigger and availability are owned by the workflow. */
export type RalphOptions = Pick<
  NodeOptions<AgenticInput, AssistantMessage>,
  "id" | "description"
> & {
  /** Caller-owned message edge carrying the one prompt assignment into the workflow. */
  readonly input: Edge<AgenticInput, AssistantMessage>;
  /** Caller-owned message edge receiving only the final round's answer, as one prompt. */
  readonly output: Edge<AgenticInput, AssistantMessage>;
  /** Full-assignment rounds to run; a positive safe integer, two when omitted. */
  readonly rounds?: number;
};

const assignmentError = () => new Error("Ralph requires exactly one prompt assignment");

/** A round's answer counts only when its run finished normally with text. */
function finalText(message: AssistantMessage | undefined): string {
  if (message?.stopReason !== "stop") {
    throw new Error(`Ralph did not finish normally: ${message?.stopReason ?? "no final message"}`);
  }
  const text = contentText(message.content).trim();
  if (!text) throw new Error("Ralph produced an empty report");
  return text;
}

/** Scheduler-owned progress: one assignment, the completed round count, and the latest draft. */
class RalphState {
  assignment: string | undefined;
  round = 0;
  draft: AssistantMessage | undefined;

  constructor(
    readonly input: Edge<AgenticInput, AssistantMessage>,
    readonly rounds: number,
  ) {}

  /** Retain the one text prompt delivered on `input`; empty continuation deliveries are no-ops. */
  receive(view: ParentView<AgenticInput, AssistantMessage>): void {
    const inputs = from(view, this.input);
    if (inputs.length === 0) return;
    const [input] = inputs;
    if (
      inputs.length !== 1 ||
      input?.kind !== "prompt" ||
      (input.images !== undefined && input.images.length > 0) ||
      this.assignment !== undefined
    ) {
      throw assignmentError();
    }
    this.assignment = input.text;
  }

  /** The assignment itself for the first round; afterwards the assignment plus the previous draft. */
  nextPrompt(): string {
    const assignment = this.assignment;
    if (assignment === undefined) throw assignmentError();
    if (this.round === 0) return assignment;
    const previous = finalText(this.draft);
    return `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;
  }
}

/**
 * Register a Ralph workflow in `parent`: a nested one-worker `JuncoGraph` that runs `agent` over the
 * full assignment `rounds` times (default two), each later round revising the previous complete
 * draft in the same session, then emits only the final answer on `output`.
 *
 * The registered node's state is the child graph, whose sole worker's state is `agent`, so closing
 * `parent` closes both. `agent` must be idle and is lent exclusively to the workflow while it runs.
 * Wire `input` into and `output` out of the returned id before driving `parent`; the final
 * `AssistantMessage` is `parent.result(id)`. Registration makes no model request.
 *
 * @throws {RangeError} before registering anything when `rounds` is not a positive safe integer.
 */
export function ralph<EH, Q extends DataflowScheduler<AgenticInput, AssistantMessage>>(
  parent: JuncoGraph<AgenticInput, AssistantMessage, EH, Q>,
  agent: JuncoAgent,
  options: RalphOptions,
): NodeIdType {
  const { input, output } = options;
  const rounds = options.rounds === undefined ? 2 : options.rounds;
  if (!(Number.isSafeInteger(rounds) && rounds >= 1)) {
    throw new RangeError("Ralph rounds must be a positive safe integer");
  }

  const scheduler = createScheduler<RalphState, AgenticInput, AssistantMessage>({
    state: new RalphState(input, rounds),
    schedule: (available) => {
      const lanes: NodeSchedule[][] = [];
      for (const [id, candidate] of available) lanes.push([{ id, inputs: triggerInputs(candidate) }]);
      return lanes;
    },
  });
  const child = new JuncoGraph(scheduler, Width(1), UNBOUNDED);

  /** One full native run of `text`, resuming through native yields, and its settled final message. */
  const runOnce = async (text: string): Promise<AssistantMessage> => {
    const signal = child.signal;
    signal.throwIfAborted();
    if (agent.status !== "idle") throw new JuncoAgentError("invalid_state", "Ralph requires an idle agent");
    // Its settlement, success or failure, arrives through agent.next().
    agent.prompt(text).catch(() => undefined);
    while (true) {
      const result = await agent.next();
      signal.throwIfAborted();
      if (result.done === true) throw new JuncoAgentError("closed", "Ralph closed before prompt settlement");
      const boundary = result.value;
      if (boundary.kind === "failed") throw boundary.error;
      if (boundary.kind === "settled") return boundary.message;
    }
  };

  async function* step(): NodeGenerator<AgenticInput, AssistantMessage> {
    yield [];
    const state = scheduler.state;
    while (true) {
      const message = await runOnce(state.nextPrompt());
      finalText(message);
      state.draft = message;
      state.round++;
      if (state.round === state.rounds) return message;
      yield [];
    }
  }

  const workerId = child.addNode({
    id: NodeId("RalphStep"),
    state: agent,
    trigger: always(),
    step,
    is_available: () => scheduler.state.assignment !== undefined,
  });

  const nodeId: NodeIdType = parent.addNode(graphNode(child, {
    id: options.id,
    description: options.description,
    trigger: when(input),
  }, {
    result: workerId,
    receive: (view) => scheduler.state.receive(view),
    afterStep: () => {
      const retained = child.result(workerId);
      if (O.isNone(retained)) return;
      parent.emit(nodeId, msg(output, { kind: "prompt", text: finalText(retained.value) }));
    },
  }));
  return nodeId;
}
