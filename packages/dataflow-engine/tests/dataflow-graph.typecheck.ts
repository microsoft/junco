import type { Scheduler } from "junco-scheduler";
import { choose, context, parallel, roundRobin } from "junco-scheduler";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { checkPayload } from "../src/edges.ts";
import type { EdgeIdType, NodeIdType, ParentView } from "../src/index.ts";
import { DataflowGraph, Edge, from, Message, Width } from "../src/index.ts";

const NumberSchema = Type.Number();
const StringSchema = Type.String();
type Num = typeof NumberSchema;
type Str = typeof StringSchema;

// Exported so `noUnusedLocals` does not report the fixtures as dead. Nothing imports this file; it
// exists to be compiled.

/** `emit` takes a branded node id and a message of the graph's own wire type. */
export function emissionKeepsWireTypes(
  graph: DataflowGraph<void, Num, string, never>,
  source: NodeIdType,
  message: Message<Num>,
  wrong: Message<Str>,
): void {
  const emitted = graph.emit(source, message);
  exact<typeof emitted, void>(true);
  // @ts-expect-error a raw string is not a node id.
  graph.emit("source", message);
  // @ts-expect-error the payload must match the graph's message type.
  graph.emit(source, wrong);
}

type State = Readonly<{ group: "a" | "b" }>;

/** Observations preserve native payload types without exposing executable or mutable containers. */
export function observationKeepsNativeTypes(
  graph: DataflowGraph<State, Num, string, Error>,
  id: NodeIdType,
  edge: EdgeIdType,
): void {
  const observation = graph.observe();
  const node = observation.nodes.get(id);
  const state: State | undefined = node?.state;
  const view: ParentView<Num, string> | undefined = observation.inputs.get(id);
  const messages: readonly number[] | undefined = view?.messages.get(edge);
  const value: string | undefined = view?.values.get(edge);
  const result: string | undefined = observation.results.get(id);
  const results: ReadonlyMap<NodeIdType, string> = graph.results();
  // @ts-expect-error state is not a message payload.
  const wrongState: number | undefined = node?.state;
  // @ts-expect-error numeric messages do not become strings.
  const wrongMessages: readonly string[] | undefined = messages;
  // @ts-expect-error textual retained results do not become numbers.
  const wrongResult: number | undefined = result;
  // @ts-expect-error observed nodes have no executable body.
  node?.step();
  // @ts-expect-error observed nodes have no live generator.
  void node?.generator;
  // @ts-expect-error observed node maps are readonly.
  observation.nodes.set(id, node!);
  // @ts-expect-error observation input membership is readonly.
  observation.inputs.delete(id);
  // @ts-expect-error detached queues are readonly.
  messages?.push(1);
  // @ts-expect-error link tuples cannot be appended.
  observation.links.push([id, id, edge, "message"]);
  // @ts-expect-error result membership is readonly.
  results.set(id, "result");
  if (node) {
    // @ts-expect-error observed primitive fields are readonly.
    node.status = "done";
    // @ts-expect-error readonly application state remains readonly.
    node.state.group = "b";
  }
  // @ts-expect-error native graphs store no policy.
  void graph.scheduler;
  // @ts-expect-error policy driving belongs to a context.
  void graph.run;
  // @ts-expect-error policy driving belongs to a context.
  void graph.step;
  void [state, view, value, wrongState, wrongMessages, wrongResult];
}

export class ConcreteGraph extends DataflowGraph<State, Num, string, Error> {
  concrete(): "concrete" {
    return "concrete";
  }
}

/** Graph and metadata inference are independent of the selected policy. */
export function contextKeepsExactDomains(graph: ConcreteGraph): void {
  const execution = context({
    graph,
    describeNode: () => ({ priority: 7 }),
    scheduler: choose({
      rank(snapshot, left, right) {
        const state: State | undefined = snapshot.nodes.get(left)?.state;
        const view: ParentView<Num, string> | undefined =
          snapshot.inputs.get(left);
        const result: string | undefined = snapshot.results.get(left);
        const metadata: { priority: number } | undefined =
          snapshot.context.get(left);
        // @ts-expect-error native state stays exact.
        const wrongState: string | undefined = snapshot.nodes.get(left)?.state;
        // @ts-expect-error input payloads stay numeric.
        const wrongView: ParentView<Str, string> | undefined =
          snapshot.inputs.get(left);
        // @ts-expect-error retained results stay textual.
        const wrongResult: number | undefined = snapshot.results.get(left);
        // @ts-expect-error metadata has no fabricated label field.
        void snapshot.context.get(left)?.label;
        void [
          state,
          view,
          result,
          metadata,
          wrongState,
          wrongView,
          wrongResult,
        ];
        return (
          (snapshot.context.get(left)?.priority ?? 0) -
          (snapshot.context.get(right)?.priority ?? 0)
        );
      },
    }),
  });
  const concrete: "concrete" = execution.graph.concrete();
  const pairGraph: ConcreteGraph = execution.graph;
  const plain = context({ graph, scheduler: parallel() });
  const inspectPlain = (snapshot: Parameters<typeof plain.scheduler>[0]) => {
    const metadata: ReadonlyMap<NodeIdType, never> = snapshot.context;
    void metadata;
  };
  const numeric = context({
    graph,
    scheduler: parallel(),
    describeNode: () => 0,
  });
  const boolean = context({
    graph,
    scheduler: parallel(),
    describeNode: () => false,
  });
  const nullable = context({
    graph,
    scheduler: parallel(),
    describeNode: () => null,
  });
  const inspectScalars = (
    n: Parameters<typeof numeric.scheduler>[0],
    b: Parameters<typeof boolean.scheduler>[0],
    z: Parameters<typeof nullable.scheduler>[0],
  ) => {
    const numberMetadata: ReadonlyMap<NodeIdType, number> = n.context;
    const booleanMetadata: ReadonlyMap<NodeIdType, boolean> = b.context;
    const nullMetadata: ReadonlyMap<NodeIdType, null> = z.context;
    void [numberMetadata, booleanMetadata, nullMetadata];
  };
  const explicitEmpty = context<
    State,
    Num,
    string,
    { priority: number },
    ConcreteGraph
  >({
    graph,
    scheduler: parallel(),
  });
  const wrongData: Scheduler<
    State,
    Str,
    string,
    { priority: number }
  > = () => ({ selected: [] });
  context({
    graph,
    describeNode: () => ({ priority: 7 }),
    // @ts-expect-error the policy cannot widen the graph's numeric messages.
    scheduler: wrongData,
  });
  const wrongMetadata: Scheduler<
    State,
    Num,
    string,
    { label: string }
  > = () => ({ selected: [] });
  context({
    graph,
    describeNode: () => ({ priority: 7 }),
    // @ts-expect-error the policy cannot replace inferred metadata.
    scheduler: wrongMetadata,
  });
  void [concrete, pairGraph, inspectPlain, inspectScalars, explicitEmpty];
}

/** Stateless policies remain universally callable across unrelated native domains. */
export function universalPolicyReuse(): void {
  const all = parallel();
  const rotating = roundRobin();
  const numbers = new DataflowGraph<State, Num, string, never>(
    Width.create(1),
    Width.create(1),
  );
  const text = new DataflowGraph<boolean, Str, number, never>(
    Width.create(1),
    Width.create(1),
  );
  context({
    graph: numbers,
    scheduler: all,
    describeNode: () => ({ priority: 7 }),
  });
  context({ graph: text, scheduler: all, describeNode: () => false });
  context({ graph: numbers, scheduler: rotating });
  context({ graph: text, scheduler: rotating, describeNode: () => null });
}

// --- schema-typed messages ------------------------------------------------------------------------

type Equals<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;
const exact = <A, B>(_proof: Equals<A, B>): void => {};

const numericEdge = Edge.message("numbers", NumberSchema);
const textEdge = Edge.message("texts", StringSchema);
const numericValue = Edge.value("result", NumberSchema);

/** Factories keep their exact schema; a value edge contributes only its result type. */
export function factoriesKeepExactTypes(): void {
  exact<Static<typeof numericEdge.schema>, number>(true);
  const branded: Edge<Num, never> = numericEdge;
  // @ts-expect-error the brand keeps the numeric message domain.
  const rebranded: Edge<Str, never> = numericEdge;
  exact<Static<typeof numericValue.schema>, number>(true);
  const cell = numericValue.transport;
  if (cell._tag === "Right" && cell.right._tag === "Some")
    exact<typeof cell.right.value, number>(true);
  const valueEdge: Edge<never, number> = numericValue;
  // A value edge carries no message domain, so it joins any message graph.
  const valueMessages: Edge<Num, number> = numericValue;
  // @ts-expect-error a numeric value edge does not promise string results.
  const valueText: Edge<never, string> = numericValue;
  void [branded, rebranded, valueEdge, valueMessages, valueText];
}

/** Message.create checks the payload against the edge schema without widening it. */
export function messageCreateChecksPayload(): void {
  const message = Message.create(numericEdge, 7);
  exact<typeof message, Message<Num>>(true);
  // @ts-expect-error "7" is not a payload of a numeric edge.
  Message.create(numericEdge, "7");
  // @ts-expect-error a numeric message does not fit a text schema.
  const wrong: Message<Str> = message;
  void wrong;
}

/** `from` narrows a numeric edge inside a wider graph domain. */
export function fromNarrows(view: ParentView<Num | Str, string>): void {
  const numbers = from(view, numericEdge);
  exact<typeof numbers, readonly number[]>(true);
  const texts = from(view, textEdge);
  exact<typeof texts, readonly string[]>(true);
}

/** TypeBox's predicate and the engine's internal assertion narrow unknown to exactly number. */
export function checksNarrow(candidate: unknown, other: unknown): void {
  if (Value.Check(numericEdge.schema, candidate))
    exact<typeof candidate, number>(true);
  checkPayload(numericEdge.schema, other, "fixture");
  exact<typeof other, number>(true);
}
