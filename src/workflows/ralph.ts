import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import {
  type DataflowTracer,
  Edge,
  from,
  Message,
  type NodeGenerator,
  NodeId,
  type NodeIdType,
  type NodeOptions,
  type ParentView,
  Source,
  Sink,
  TriggerRule,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type JuncoAgent, JuncoAgentError } from "junco-agent";
import { parallel } from "junco-scheduler";
import type { ToolCollection } from "junco-tools";
import type { AgenticInput, AgenticNode } from "../agentic.js";
import { JuncoGraph } from "../junco-graph.js";
import { context } from "../node-policy.js";

/** Registration options for `Ralph.register`; trigger and availability are owned by the workflow. */
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
  /**
   * Policy of the child graph and its worker node (the outer node is authorized by the child
   * graph's policy); must equal `agent.collection.policy` when the agent has a collection.
   */
  readonly policy: ToolCollection["policy"];
};

/** A directly mappable Ralph assignment, using the child's policy and tracer. */
export type RalphNodeOptions = NodeOptions<AgenticInput, AssistantMessage> & {
  readonly assignment:
    | string
    | ((inputs: ParentView<AgenticInput, AssistantMessage>) => string);
  readonly rounds?: number;
  readonly policy: ToolCollection["policy"];
  readonly tracer: DataflowTracer;
};

const assignmentError = () =>
  new Error("Ralph requires exactly one prompt assignment");

/** A round's answer counts only when its run finished normally with text. */
function finalText(message: AssistantMessage | undefined): string {
  if (message?.stopReason !== "stop") {
    throw new Error(
      `Ralph did not finish normally: ${message?.stopReason ?? "no final message"}`,
    );
  }
  const text = contentText(message.content).trim();
  if (!text) throw new Error("Ralph produced an empty report");
  return text;
}

/** Lexical workflow progress: one assignment, completed rounds and the latest draft. */
class RalphState {
  assignment: string | undefined;
  round = 0;
  draft: AssistantMessage | undefined;

  constructor(readonly rounds: number) {}


  /** The assignment itself for the first round; afterwards the assignment plus the previous draft. */
  nextPrompt(): string {
    const assignment = this.assignment;
    if (assignment === undefined) throw assignmentError();
    if (this.round === 0) return assignment;
    const previous = finalText(this.draft);
    return `${assignment}\n\nRevise your previous answer to improve coverage, correctness, and clarity for every goal. Return the complete revised answer.\n\nPrevious answer:\n${previous}`;
  }
}

function createRalphGraph(
  agent: JuncoAgent,
  rounds: number,
  policy: ToolCollection["policy"],
  tracer: DataflowTracer,
  admit: (view: ParentView<AgenticInput, AssistantMessage>, state: RalphState) => void,
  output?: Edge<AgenticInput, AssistantMessage>,
  initialize?: (state: RalphState) => void,
) {
  if (!(Number.isSafeInteger(rounds) && rounds >= 1)) {
    throw new RangeError("Ralph rounds must be a positive safe integer");
  }

  const state = new RalphState(rounds);
  const workerId = NodeId.create("RalphStep");
  const final = Edge.value<AgenticInput, AssistantMessage>("RalphStep->$sink");
  const source = new Source<AgenticInput, AssistantMessage>((view) => {
    admit(view, state);
    return [];
  }, { id: NodeId.create("$source") });
  const sink: Sink<AgenticInput, AssistantMessage> = new Sink<AgenticInput, AssistantMessage>(async function* (port): NodeGenerator<AgenticInput, AssistantMessage> {
    yield [];
    const retained = child.result(workerId);
    if (O.isNone(retained)) throw new Error("Ralph stopped without a final result");
    const text = finalText(retained.value);
    if (output) port.send(Message.create(output, { kind: "prompt", text }));
    return retained.value;
  }, { id: NodeId.create("$sink"), trigger: TriggerRule.when(final) });
  const child: JuncoGraph<AgenticInput, AssistantMessage> = new JuncoGraph(
    source,
    sink,
    Width.create(1),
    UNBOUNDED,
    tracer,
    policy,
    agent.collection,
  );

  /** One full native run of `text`, resuming through native yields, and its settled final message. */
  const runOnce = async (text: string): Promise<AssistantMessage> => {
    const signal = child.signal;
    signal.throwIfAborted();
    if (agent.status !== "idle")
      throw new JuncoAgentError(
        "invalid_state",
        "Ralph requires an idle agent",
      );
    // Its settlement, success or failure, arrives through agent.next().
    agent.prompt(text).catch(() => undefined);
    while (true) {
      const result = await agent.next();
      signal.throwIfAborted();
      if (result.done === true)
        throw new JuncoAgentError(
          "closed",
          "Ralph closed before prompt settlement",
        );
      const boundary = result.value;
      if (boundary.kind === "failed") throw boundary.error;
      if (boundary.kind === "settled") return boundary.message;
    }
  };

  async function* step(): NodeGenerator<AgenticInput, AssistantMessage> {
    if (state.assignment === undefined) initialize?.(state);
    yield [];
    while (true) {
      const message = await runOnce(state.nextPrompt());
      finalText(message);
      state.draft = message;
      state.round++;
      if (state.round === state.rounds) return message;
      yield [];
    }
  }

  child.addNode({
    id: workerId,
    state: agent,
    policy,
    trigger: TriggerRule.always(),
    step,
    is_available: () => source.peek() === undefined && (state.assignment !== undefined || initialize !== undefined),
  });
  child.addEdge(workerId, sink.id, final);
  return { execution: context({ graph: child, scheduler: parallel() }), state };
}

/** The Ralph workflow: repeated full-assignment revision rounds of one agent in a nested graph. */
export const Ralph = {
  /** Return a step-less nested spec; evaluate its complete assignment only on first delivery. */
  node(
    agent: JuncoAgent,
    options: RalphNodeOptions,
  ): AgenticNode<AgenticInput, AssistantMessage> {
    const { assignment, rounds = 2, policy, tracer, ...nodeOptions } = options;
    const admit = (view: ParentView<AgenticInput, AssistantMessage>, state: RalphState) => {
      if (state.assignment !== undefined) return;
      const text = typeof assignment === "function" ? assignment(view) : assignment;
      if (typeof text !== "string") throw new TypeError("Ralph assignment must be a string");
      state.assignment = text;
    };
    const { execution } = createRalphGraph(
      agent, rounds, policy, tracer, admit, undefined,
      (state) => admit({ messages: new Map(), values: new Map() }, state),
    );
    return { ...nodeOptions, state: execution };
  },

  /**
   * Register a Ralph workflow in `parent`: a nested one-worker `JuncoGraph` that runs `agent` over
   * the full assignment `rounds` times (default two), each later round revising the previous
   * complete draft in the same session, then emits only the final answer on `output`.
   *
   * The registered node's state is the child graph, whose sole worker's state is `agent`, so
   * closing `parent` closes both. The child graph borrows `agent.collection`. `agent` must be idle
   * and is lent exclusively to the workflow while it runs.
   * Wire `input` into and `output` out of the returned id before driving `parent`; the final
   * `AssistantMessage` is `parent.result(id)`. Registration makes no model request.
   *
   * @throws {RangeError} before registering anything when `rounds` is not a positive safe integer.
   * @throws {TypeError} before registering anything when `agent.collection` has another policy
   *   than `options.policy`.
   */
  register<EH>(
    parent: JuncoGraph<AgenticInput, AssistantMessage, EH>,
    agent: JuncoAgent,
    options: RalphOptions,
  ): NodeIdType {
    const { input, output } = options;
    const { execution } = createRalphGraph(
      agent,
      options.rounds === undefined ? 2 : options.rounds,
      options.policy,
      parent.tracer,
      (view, state) => {
        const inputs = from(view, input);
        const [assignment] = inputs;
        if ([...view.values.keys()].length !== 0 ||
          [...view.messages.keys()].some((id) => id !== input.id) ||
          inputs.length !== 1 || assignment?.kind !== "prompt" ||
          (assignment.images !== undefined && assignment.images.length > 0) ||
          state.assignment !== undefined) throw assignmentError();
        state.assignment = assignment.text;
      },
      output,
    );

    const nodeId: NodeIdType = parent.addNode({
      id: options.id,
      description: options.description,
      trigger: TriggerRule.when(input),
      state: execution,
      contract: (edgeId) => {
        if (edgeId !== input.id)
          throw new JuncoAgentError(
            "invalid_state",
            `No contract for edge "${edgeId}"`,
          );
        return {
          expect:
            "Exactly one image-free prompt containing the complete assignment; duplicate assignments are rejected, and the final revised draft is emitted after all rounds.",
        };
      },
    });
    return nodeId;
  },
};
