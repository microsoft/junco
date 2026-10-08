import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import {
  type DataflowScheduler,
  DummyTracer,
  UNBOUNDED,
  Width,
  type WidthType,
} from "dataflow-engine";
import type { AgenticYieldReason } from "junco-agent";
import {
  createParallelScheduler,
  createRoundRobinScheduler,
} from "junco-scheduler";
import {
  type AgenticInput,
  graph as graphApi,
  JuncoGraph,
  type MockFrame,
  type MockRequest,
  type MockRun,
  type MockTerminal,
} from "../src/index.ts";
import { nodeInputs } from "../src/node-policy.ts";

// Deterministic agency scaffolding: real junco-scheduler policies and real JuncoGraphs whose node
// states are mock agents, coroutines or nested graphs. No provider is involved.

export type Strategy = "round-robin" | "parallel";
export const STRATEGIES: readonly Strategy[] = ["round-robin", "parallel"];

/** These helpers' graphs stay untraced, keeping deterministic output quiet. */
const quiet = new DummyTracer();

/** A policy scheduler; round robin also exposes its cursor. */
export type PolicyScheduler = DataflowScheduler<
  AgenticInput,
  AssistantMessage
> & { readonly state?: unknown };

/** The real junco-scheduler policy for `strategy`. */
export function policy(strategy: Strategy): PolicyScheduler {
  return strategy === "round-robin"
    ? createRoundRobinScheduler<AgenticInput, AssistantMessage>()
    : createParallelScheduler<AgenticInput, AssistantMessage>();
}

/** The graph bounds each policy is documented for: one entry per lane, one or every lane. */
function bounds(
  strategy: Strategy,
  threads: WidthType | undefined,
): readonly [WidthType, WidthType] {
  return [
    Width(1),
    threads ?? (strategy === "round-robin" ? Width(1) : UNBOUNDED),
  ];
}

/** A policy-driven graph keeping the policy's native input resolution. */
export function plainGraph(
  strategy: Strategy,
): JuncoGraph<AgenticInput, AssistantMessage, unknown, PolicyScheduler> {
  const [window, threads] = bounds(strategy, undefined);
  return new JuncoGraph<
    AgenticInput,
    AssistantMessage,
    unknown,
    PolicyScheduler
  >(policy(strategy), window, threads, quiet, "LockPolicy");
}

/**
 * A graph on the real `strategy` policy. The policy keeps its lane and id decisions; each running
 * node re-reads its live inputs with the agency rule, so a delivered result never starves a newer
 * message.
 */
export function policyGraph(
  strategy: Strategy,
  { threads }: { readonly threads?: WidthType } = {},
): JuncoGraph<AgenticInput, AssistantMessage, unknown, PolicyScheduler> {
  if (strategy === "parallel" && threads === undefined) {
    return graphApi.createParallelAgentGraph<AgenticInput, AssistantMessage>(
      "LockPolicy",
      quiet,
    );
  }
  let graph:
    | JuncoGraph<AgenticInput, AssistantMessage, unknown, PolicyScheduler>
    | undefined;
  const scheduler = policy(strategy);
  scheduler.resolveInputs = (entry, live) =>
    nodeInputs(graph?.getNode(entry.id)?.step, live);
  const [window, width] = bounds(strategy, threads);
  const constructed = new JuncoGraph<
    AgenticInput,
    AssistantMessage,
    unknown,
    PolicyScheduler
  >(scheduler, window, width, quiet, "LockPolicy");
  graph = constructed;
  return constructed;
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
