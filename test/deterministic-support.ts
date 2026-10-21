import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  DummyTracer,
  Edge,
  NodeId,
  type NodeIdType,
  Sink,
  Source,
  TriggerRule,
  UNBOUNDED,
  Width,
  type WidthType,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import {
  type Agentic,
  type AgenticInput,
  JuncoGraph,
  type MockFrame,
  type MockRequest,
  type MockRun,
  type MockTerminal,
  schedules,
} from "junco-agency";
import type { AgenticYieldReason } from "junco-agent";
import {
  context as nativeContext,
  parallel,
  roundRobin,
  type Scheduler,
} from "junco-scheduler";
import { LockPolicy } from "junco-tools";
import type { AgencyNodeMetadata } from "../src/node-policy.ts";

// Deterministic agency scaffolding: real junco-scheduler policies and real JuncoGraphs whose node
// states are mock agents, coroutines or nested graphs. No provider is involved.

export type Strategy = "round-robin" | "parallel";
export const STRATEGIES: readonly Strategy[] = ["round-robin", "parallel"];

/** These helpers' graphs stay untraced, keeping deterministic output quiet. */
const quiet = new DummyTracer();

/** Stateless policy functions; cursor state comes from each context's history. */
export function policy<C>(
  strategy: Strategy,
): Scheduler<
  Agentic<AgenticInput, AssistantMessage>,
  AgenticInput,
  AssistantMessage,
  C
> {
  return strategy === "round-robin" ? roundRobin() : parallel();
}

/** The graph bounds each policy is documented for: one entry per lane, one or every lane. */
function bounds(
  strategy: Strategy,
  threads: WidthType | undefined,
): readonly [WidthType, WidthType] {
  return [
    Width.create(1),
    threads ?? (strategy === "round-robin" ? Width.create(1) : UNBOUNDED),
  ];
}

/** Native trigger reads intentionally differ from the agency bridge's retained-value reads. */
export function plainContext(
  source: Source<AgenticInput, AssistantMessage>,
  sink: Sink<AgenticInput, AssistantMessage>,
  strategy: Strategy,
) {
  const [window, threads] = bounds(strategy, undefined);
  const graph = new JuncoGraph(
    source,
    sink,
    window,
    threads,
    quiet,
    LockPolicy,
  );
  return nativeContext({ graph, scheduler: policy<never>(strategy) });
}

/** Agency live reads prevent a retained result from starving newer messages. */
export function policyContext(
  source: Source<AgenticInput, AssistantMessage>,
  sink: Sink<AgenticInput, AssistantMessage>,
  strategy: Strategy,
  { threads }: { readonly threads?: WidthType } = {},
) {
  const [window, width] = bounds(strategy, threads);
  const graph = new JuncoGraph(source, sink, window, width, quiet, LockPolicy);
  return schedules.context({
    graph,
    scheduler: policy<AgencyNodeMetadata>(strategy),
  });
}

/** Fresh closed ingress and a sink explicitly wired to the fixture's chosen terminal work. */
export function terminalPorts<N = AgenticInput, T = AssistantMessage>() {
  const edge = Edge.value<N, T>("terminal->$sink");
  let result: (() => O.Option<T>) | undefined;
  const source = new Source<N, T>(
    () => {
      throw new DataflowDefinitionError(
        "Fixture does not accept external input",
      );
    },
    { id: NodeId.create("$source") },
  );
  const sink = new Sink<N, T>(
    async function* () {
      yield [];
      const retained = result?.();
      if (retained === undefined || O.isNone(retained))
        throw new Error("Fixture terminal work did not produce a result");
      return retained.value;
    },
    { id: NodeId.create("$sink"), trigger: TriggerRule.when(edge) },
  );
  return {
    source,
    sink,
    connect(
      graph: {
        result(id: NodeIdType): O.Option<T>;
        addEdge(from: NodeIdType, to: NodeIdType, edge: Edge<N, T>): unknown;
      },
      terminal: NodeIdType,
    ) {
      result = () => graph.result(terminal);
      graph.addEdge(terminal, sink.id, edge);
    },
  };
}

// Transcript builders ------------------------------------------------------------------------------

/** A constant assistant message; `stopReason` defaults to `stop`. */
export function assistant(
  text: string,
  stopReason: StopReason = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "mock",
    provider: "mock",
    model: "mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

/** A constant user message. */
export const user = (text: string, timestamp = 0): AgentMessage => ({
  role: "user",
  content: text,
  timestamp,
});

/** A `yield` reason of `kind`, as Agentic reports it. */
export const reason = (
  text: string,
  id: string,
  kind: AgenticYieldReason["kind"] = "tool",
): AgenticYieldReason => ({
  kind,
  toolCallId: id,
  toolName: kind === "tool" ? "yield" : "bash",
  reason: text,
});

/** A yield frame with `reasons`. */
export const pause = (
  reasons: readonly AgenticYieldReason[],
  extra: Omit<MockFrame, "step"> = {},
): MockFrame => ({ step: { kind: "yield", reasons }, ...extra });

/** A settled frame returning `message`. */
export const settle = (
  message: AssistantMessage,
  extra: Omit<MockFrame, "step"> = {},
): MockFrame => ({
  step: { kind: "settled", message },
  ...extra,
});

/** The cancellation outcome every helper run uses unless told otherwise. */
export const ABORTED: MockRun["interrupted"] = {
  step: { kind: "settled", message: assistant("aborted", "aborted") },
};

/** A run of `frames`, interrupted as `interrupted`. */
export const run = (
  frames: readonly MockFrame[],
  interrupted: MockRun["interrupted"] = ABORTED,
): MockRun => ({
  frames,
  interrupted,
});

/** A run that settles `text` after `yields` pauses. */
export const yieldsThen = (yields: number, text: string): MockRun =>
  run([
    ...Array.from({ length: yields }, (_, index) =>
      pause([reason(`pause ${index + 1}`, `y${index + 1}`)]),
    ),
    settle(assistant(text)),
  ]);

/** A failed terminal. */
export const failed = (error: unknown): MockTerminal => ({
  kind: "failed",
  error,
});

// Observations -------------------------------------------------------------------------------------

export const textOf = (message: AssistantMessage): string =>
  message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

/** The text of `id`'s retained result, or `undefined` before it exists. */
export const resultText = (
  graph: Pick<JuncoGraph, "result">,
  id: NodeIdType,
): string | undefined => {
  const result = graph.result(id);
  return O.isSome(result) ? textOf(result.value) : undefined;
};

/** The user texts of `messages`, in order. */
export const userTexts = (messages: readonly AgentMessage[]): string[] =>
  messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : [
          typeof message.content === "string"
            ? message.content
            : message.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join(""),
        ],
  );

/** The user texts of each request. */
export const requestTexts = <T extends AgentTool>(
  requests: readonly MockRequest<T>[],
): string[][] => requests.map((request) => userTexts(request.messages));
