// Compile-only: exact native payloads, metadata inference and external execution capabilities.
import {
  DataflowGraph,
  type EdgeIdType,
  gigabytes,
  NodeId,
  type NodeIdType,
  type ParentView,
  tokens,
  triggerInputs,
  UNBOUNDED,
  Width,
} from "dataflow-engine";
import { Type } from "typebox";
import {
  agent,
  choose,
  context,
  type Decision,
  limit,
  parallel,
  roundRobin,
  type Scheduler,
  type SchedulerContext,
  type Snapshot,
  separate,
} from "../src/index.ts";

const NumberSchema = Type.Number();
const BooleanSchema = Type.Boolean();

type State = Readonly<{ group: "a" | "b" }>;
type Metadata = { priority: number };
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

class ConcreteGraph extends DataflowGraph<
  State,
  typeof NumberSchema,
  string,
  Error
> {
  concreteOnly(): "concrete" {
    return "concrete";
  }
}

export function graphAndHookDetermineAllTypes(
  edge: EdgeIdType,
  id: NodeIdType,
) {
  const graph = new ConcreteGraph(Width.create(1), UNBOUNDED);
  const execution = context({
    graph,
    describeNode: () => ({ priority: 7 }),
    scheduler: choose({
      rank(snapshot, left, right) {
        const state: State | undefined = snapshot.nodes.get(id)?.state;
        const queued: readonly number[] | undefined = snapshot.inputs
          .get(id)
          ?.messages.get(edge);
        const value: string | undefined = snapshot.inputs
          .get(id)
          ?.values.get(edge);
        const result: string | undefined = snapshot.results.get(id);
        const priority: number | undefined =
          snapshot.context.get(left)?.priority;
        // @ts-expect-error native state is not a string
        const wrongState: string | undefined = snapshot.nodes.get(id)?.state;
        // @ts-expect-error native messages are numeric
        const wrongMessages: readonly string[] | undefined = snapshot.inputs
          .get(id)
          ?.messages.get(edge);
        // @ts-expect-error native results are textual
        const wrongResult: number | undefined = snapshot.results.get(id);
        // @ts-expect-error metadata retains its exact hook-derived fields
        snapshot.context.get(left)?.label;
        // @ts-expect-error observation maps are readonly
        snapshot.nodes.set(id, snapshot.nodes.get(id)!);
        // @ts-expect-error native field records are readonly
        snapshot.nodes.get(id)!.status = "done";
        // @ts-expect-error input containers are readonly
        snapshot.inputs.get(id)!.messages.set(edge, []);
        // @ts-expect-error historical selections are readonly
        snapshot.history[0]!.selected.push({
          nodeId: id,
          modelStrength: 2,
          readEdges: [],
        });
        // @ts-expect-error historical node IDs are readonly
        snapshot.history[0]!.selected[0]!.nodeId = id;
        // @ts-expect-error historical strengths are readonly
        snapshot.history[0]!.selected[0]!.modelStrength = 3;
        // @ts-expect-error historical read plans are readonly
        snapshot.history[0]!.selected[0]!.readEdges = [];
        // @ts-expect-error historical read edge arrays are readonly
        snapshot.history[0]!.selected[0]!.readEdges.push(edge);
        // @ts-expect-error historical read edge elements are readonly
        snapshot.history[0]!.selected[0]!.readEdges[0] = edge;
        // @ts-expect-error ownership is readonly
        snapshot.owned.add(id);
        void [
          state,
          queued,
          value,
          result,
          priority,
          wrongState,
          wrongMessages,
          wrongResult,
        ];
        return (
          (snapshot.context.get(left)?.priority ?? 0) -
          (snapshot.context.get(right)?.priority ?? 0)
        );
      },
    }),
    readInputs(_node, candidate) {
      const messages: readonly number[] | undefined =
        candidate.view.messages.get(edge);
      const value: string | undefined = candidate.view.values.get(edge);
      void [messages, value];
      return triggerInputs(candidate);
    },
  });
  const preserved: "concrete" = execution.graph.concreteOnly();
  const exact: Equal<
    typeof execution,
    SchedulerContext<
      State,
      typeof NumberSchema,
      string,
      Metadata,
      ConcreteGraph
    >
  > = true;
  const values: Promise<ReadonlyMap<NodeIdType, string>> = execution.step();
  // @ts-expect-error the graph has no policy driver
  graph.run();
  // @ts-expect-error the graph has no policy driver
  graph.step();
  // @ts-expect-error policies are not stored on native work graphs
  graph.scheduler;
  return [execution, exact, preserved, values];
}

export function omittedAndScalarMetadataAreExact() {
  const graph = new DataflowGraph<State, typeof NumberSchema, string, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const omitted = context({
    graph,
    scheduler(snapshot) {
      const exact: Equal<
        typeof snapshot.context,
        ReadonlyMap<NodeIdType, never>
      > = true;
      return { selected: exact ? [] : [] };
    },
  });
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
  const n: Equal<
    typeof numeric.scheduler,
    Scheduler<State, typeof NumberSchema, string, number>
  > = true;
  const b: Equal<
    typeof boolean.scheduler,
    Scheduler<State, typeof NumberSchema, string, boolean>
  > = true;
  const z: Equal<
    typeof nullable.scheduler,
    Scheduler<State, typeof NumberSchema, string, null>
  > = true;
  const explicit = context<State, typeof NumberSchema, string, Metadata>({
    graph,
    scheduler: parallel(),
  });
  return [omitted, numeric, boolean, nullable, explicit, n, b, z];
}

export function policyCannotWidenGraphOrMetadata() {
  const graph = new ConcreteGraph(Width.create(1), UNBOUNDED);
  const wrongMetadata: Scheduler<
    State,
    typeof NumberSchema,
    string,
    { label: string }
  > = () => ({ selected: [] });
  context({
    graph,
    describeNode: () => ({ priority: 7 }),
    // @ts-expect-error policy metadata cannot widen the hook's metadata
    scheduler: wrongMetadata,
  });
  const wrongData: Scheduler<
    { group: "other" },
    boolean,
    number,
    Metadata
  > = () => ({ selected: [] });
  context({
    graph,
    describeNode: () => ({ priority: 7 }),
    // @ts-expect-error policy data cannot widen native S/N/T
    scheduler: wrongData,
  });
}

export function universalPoliciesAndExactComposition(id: NodeIdType) {
  const all = parallel();
  const rotation = roundRobin();
  const one = new DataflowGraph<State, typeof NumberSchema, string, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const two = new DataflowGraph<Date, typeof BooleanSchema, number, never>(
    Width.create(1),
    UNBOUNDED,
  );
  const a = context({
    graph: one,
    scheduler: all,
    describeNode: () => ({ priority: 1 }),
  });
  const b = context({
    graph: two,
    scheduler: all,
    describeNode: () => "label",
  });
  const c = context({
    graph: one,
    scheduler: rotation,
    describeNode: () => false,
  });
  const d = context({ graph: two, scheduler: rotation });
  const deterministic: Scheduler<State, typeof NumberSchema, string, Metadata> =
    choose({
      where: (snapshot, node) => snapshot.nodes.get(node)?.state.group === "a",
      rank: (snapshot, left, right) =>
        (snapshot.context.get(left)?.priority ?? 0) -
        (snapshot.context.get(right)?.priority ?? 0),
    });
  const oracle: Scheduler<State, typeof NumberSchema, string, Metadata> = agent(
    async (snapshot, signal) => {
      const input: ParentView<typeof NumberSchema, string> | undefined =
        snapshot.inputs.get(id);
      const metadata: Metadata | undefined = snapshot.context.get(id);
      signal?.throwIfAborted();
      void [input, metadata];
      return [[id]];
    },
  );
  const composed: Scheduler<State, typeof NumberSchema, string, Metadata> =
    separate(
      (snapshot, node) => snapshot.nodes.get(node)?.state.group === "a",
      deterministic,
      oracle,
    );
  const callback: Scheduler<
    State,
    typeof NumberSchema,
    string,
    Metadata
  > = async (snapshot, signal) => await composed(snapshot, signal);
  const malformed: Decision = {
    // @ts-expect-error raw strings are not native branded selections
    selected: [{ nodeId: "a", modelStrength: 2, readEdges: [] }],
  };
  const valid: Decision = {
    selected: [{ nodeId: NodeId.create("a"), modelStrength: 2, readEdges: [] }],
  };
  const invalidStrength: Decision = {
    // @ts-expect-error strengths are ladder indices, not arbitrary numbers
    selected: [{ nodeId: id, modelStrength: 5, readEdges: [] }],
  };
  // @ts-expect-error bare branded IDs are not model selections
  const bareIds: Decision = { selected: [id] };
  return [a, b, c, d, callback, malformed, valid, invalidStrength, bareIds];
}

export function metadataConsumerVariance() {
  const graph = new ConcreteGraph(Width.create(1), UNBOUNDED);
  const owner = context({
    graph,
    scheduler: parallel(),
    describeNode: () => ({ priority: 1 }),
  });
  const consumer: SchedulerContext<
    State,
    typeof NumberSchema,
    string,
    never,
    ConcreteGraph
  > = owner;
  const retained: Equal<
    typeof owner.scheduler,
    Scheduler<State, typeof NumberSchema, string, Metadata>
  > = true;
  const empty = context({ graph, scheduler: parallel() });
  // @ts-expect-error a no-metadata-only policy cannot consume arbitrary rich metadata
  const reversed: SchedulerContext<
    State,
    typeof NumberSchema,
    string,
    Metadata,
    ConcreteGraph
  > = empty;
  // @ts-expect-error a passive graph is not an execution capability
  const bare: SchedulerContext<
    State,
    typeof NumberSchema,
    string,
    never,
    ConcreteGraph
  > = graph;
  // @ts-expect-error a context is not native graph state/topology
  const work: ConcreteGraph = owner;
  return [consumer, retained, reversed, bare, work];
}

export function exactSnapshotContract(
  snapshot: Snapshot<State, typeof NumberSchema, string, Metadata>,
) {
  const typed: Snapshot<State, typeof NumberSchema, string, Metadata> =
    snapshot;
  // @ts-expect-error all native data parameters and metadata are required
  const erased: Snapshot<State, typeof NumberSchema, string> = snapshot;
  // @ts-expect-error scheduler data/metadata parameters are required
  const untyped: Scheduler = () => ({ selected: [] });
  return [typed, erased, untyped];
}

export function usageLimitOptions(
  scheduler: Scheduler<State, typeof NumberSchema, string, Metadata>,
) {
  limit({ tools: 100 }, scheduler);
  limit({ tokens: tokens(20_000), scope: "batch" }, scheduler);
  limit({ tools: 10, tokens: tokens(2_000), scope: "activation" }, scheduler);
  limit(
    { memory: gigabytes(4), tokens: tokens(100_000), tools: 500 },
    limit({ tools: 20, scope: "activation" }, scheduler),
  );
  // @ts-expect-error every tool counts together: no per-name quotas
  limit({ tools: { read: 3 } }, scheduler);
  // @ts-expect-error unknown scope
  limit({ tools: 1, scope: "global" }, scheduler);
  // @ts-expect-error misspelled resource
  limit({ tool: 1 }, scheduler);
  // @ts-expect-error tokens take a token quantity
  limit({ tokens: 100 }, scheduler);
  // @ts-expect-error tokens take the token dimension
  limit({ tokens: gigabytes(1) }, scheduler);
}
