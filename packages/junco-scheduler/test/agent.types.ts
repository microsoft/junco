// Compile-only oracle contracts; included by tsconfig.typecheck.json.
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
  DataflowGraph,
  NodeId,
  type NodeIdType,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import { type PiOptions, pi, type SchedulerRequest } from "../src/agent.ts";
import {
  agent,
  context,
  type Decision,
  type Scheduler,
  type Snapshot,
} from "../src/index.ts";

export function universalModelPolicy(options: PiOptions) {
  const scheduler = pi(options);
  const numeric = new DataflowGraph<
    Readonly<{ group: "a" | "b" }>,
    number,
    string,
    Error
  >(Width.create(1), UNBOUNDED);
  const textual = new DataflowGraph<boolean, string, number, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const first = context({
    graph: numeric,
    scheduler,
    describeNode: () => ({ priority: 7 }),
  });
  const second = context({
    graph: textual,
    scheduler,
    describeNode: () => false,
  });
  const empty = context({ graph: textual, scheduler });
  const scalar = context({ graph: numeric, scheduler, describeNode: () => 0 });
  const nullable = context({
    graph: numeric,
    scheduler,
    describeNode: () => null,
  });
  const firstPolicy: Scheduler<
    Readonly<{ group: "a" | "b" }>,
    number,
    string,
    { priority: number }
  > = scheduler;
  const secondPolicy: Scheduler<boolean, string, number, boolean> = scheduler;
  // @ts-expect-error Model policies are not resources, iterators or sessions.
  scheduler.return();
  // @ts-expect-error A policy does not own or configure a graph.
  scheduler.graph;
  // @ts-expect-error A policy has no mutable cursor or conversation state.
  scheduler.state;
  return [first, second, empty, scalar, nullable, firstPolicy, secondPolicy];
}

/** The same generic callback preserves caller C all the way to the wire request. */
export function genericOracle() {
  async function invoke<S, N, T, C>(snapshot: Snapshot<S, N, T, C>) {
    const contextPairs: (readonly [NodeIdType, C])[] = [];
    for (const [id, metadata] of snapshot.context)
      contextPairs.push([id, metadata]);
    const request: SchedulerRequest<C> = {
      version: snapshot.version,
      threads: snapshot.threads === Infinity ? null : snapshot.threads,
      nodes: [...snapshot.nodes.values()].map(
        ({ id, status, description }) => ({ id, status, description }),
      ),
      context: contextPairs,
      history: snapshot.history,
    };
    const metadata: C | undefined = request.context[0]?.[1];
    return metadata === undefined ? [] : [request.nodes.map((node) => node.id)];
  }
  const scheduler = agent(invoke);
  const a: Scheduler<number, string, boolean, { label: string }> = scheduler;
  const b: Scheduler<string, number, { result: string }, false> = scheduler;
  return [a, b];
}

export function exactRequest(
  request: SchedulerRequest<
    Readonly<{ trigger: "all" | "any"; satisfied: number }>
  >,
) {
  const metadata = request.context[0]?.[1];
  const satisfied: number | undefined = metadata?.satisfied;
  const trigger: "all" | "any" | undefined = metadata?.trigger;
  const node = request.nodes[0];
  if (node) {
    const nodeId: NodeIdType = node.id;
    const status: "ready" | "running" | "done" = node.status;
    const description: string | undefined = node.description;
    // @ts-expect-error Native state must never appear on the built-in wire.
    node.state;
    // @ts-expect-error Wire records are readonly.
    node.status = "done";
    void [nodeId, status, description];
  }
  // @ts-expect-error No automatic native inputs in built-in requests.
  request.inputs;
  // @ts-expect-error No native results in built-in requests.
  request.results;
  // @ts-expect-error Caller metadata stays exact, not an untyped bag.
  metadata?.label;
  // @ts-expect-error Context entries are readonly.
  request.context.push([NodeId.create("a"), { trigger: "all", satisfied: 0 }]);
  // @ts-expect-error Historical selections contain branded native IDs.
  const decision: Decision = { selected: ["unbranded"] };
  return [satisfied, trigger, decision];
}

export function requiredModelOptions(
  models: Pick<Models, "completeSimple">,
  model: Model<Api>,
) {
  const options: PiOptions = {
    models,
    model,
    prompt: "Run current work.",
    streamOptions: { temperature: 0 },
  };
  // @ts-expect-error No default-model acquisition or optional native dependencies.
  pi({ models });
  // @ts-expect-error The caller supplies its model service.
  pi({ model });
  // @ts-expect-error Native sessions are not part of a policy.
  pi({ ...options, session: {} });
  // @ts-expect-error The graph signal, not streamOptions, owns cancellation.
  pi({ ...options, streamOptions: { signal: new AbortController().signal } });
  // @ts-expect-error No graph or prompt callback is attached to an oracle.
  pi({ ...options, prompt: () => "Run work." });
  return pi(options);
}
