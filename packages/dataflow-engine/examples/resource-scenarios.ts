import {
  choose,
  context,
  limit,
  nodeIds,
  parallel,
  type Scheduler,
} from "junco-scheduler";
import { Type } from "typebox";
import {
  DataflowGraph,
  type DataflowTracer,
  Edge,
  EmitOnce,
  from,
  gigabytes,
  Message,
  NodeId,
  StepNode,
  TriggerEntry,
  TriggerRule,
  UNBOUNDED,
} from "../src/index.ts";

const StringSchema = Type.String();

/** Pack activations under 4 GB using calibrated byte floors; retained memory needs headroom. */
export async function runMemoryLimit(tracer?: DataflowTracer): Promise<{
  readonly waves: readonly (readonly string[])[];
  readonly consumed: readonly string[];
  readonly sourceResult: string | undefined;
}> {
  const graph = new DataflowGraph<void, typeof StringSchema, string, never>(
    UNBOUNDED,
    UNBOUNDED,
    tracer,
  );
  const edges = ["toA", "toB", "toC", "toD"].map((name) =>
    Edge.message<typeof StringSchema, string>(name, StringSchema),
  );
  const source = graph.addNode(
    new EmitOnce<void, typeof StringSchema, string>(
      () => edges.map((edge) => Message.create(edge, "go")),
      "source done",
      {
        id: NodeId.create("source"),
        state: undefined,
        trigger: TriggerRule.always(),
      },
    ),
  );
  const consumed: string[] = [];
  for (const [i, name] of ["A", "B", "C", "D"].entries()) {
    const edge = edges[i];
    const sink = graph.addNode(
      new StepNode<void, typeof StringSchema, string>(
        () => {
          consumed.push(name);
          return [];
        },
        {
          id: NodeId.create(name),
          state: undefined,
          trigger: TriggerRule.when(edge),
        },
      ),
    );
    graph.addEdge(source, sink, edge);
  }
  const waves: string[][] = [];
  const floorBytes: Record<string, number> = {
    source: 1e6,
    A: 3e9,
    B: 3e9,
    C: 2e9,
    D: 9e8,
  };
  const inner = limit<void, typeof StringSchema, string, never>(
    { memory: gigabytes(4), memoryFloor: (node) => floorBytes[node] },
    parallel(),
  );
  const scheduler: Scheduler<void, typeof StringSchema, string, never> = async (
    s,
    signal,
  ) => {
    const d = await inner(s, signal);
    waves.push(nodeIds(d.selected));
    return d;
  };
  const results = await context({ graph, scheduler }).run();
  return { waves, consumed, sourceResult: results.get(source) };
}

/** Rank a one-shot race by calibrated token costs; the zero-cost anyOf join can finish first. */
export async function runTokenRace(tracer?: DataflowTracer): Promise<{
  readonly winner: string | undefined;
  readonly waves: readonly (readonly string[])[];
  readonly started: readonly string[];
  readonly completedRacers: readonly string[];
}> {
  const graph = new DataflowGraph<void, typeof StringSchema, string, never>(
    UNBOUNDED,
    UNBOUNDED,
    tracer,
  );
  const edges = ["e1", "e2", "e3"].map((name) =>
    Edge.message<typeof StringSchema, string>(name, StringSchema),
  );
  const started = new Set<string>();
  const racers = ["R1", "R2", "R3"].map((name, i) =>
    graph.addNode({
      id: NodeId.create(name),
      state: undefined,
      trigger: TriggerRule.always(),
      step: async function* () {
        started.add(name);
        yield [Message.create(edges[i], name)];
        return `${name} done`;
      },
    }),
  );
  const join = graph.addNode({
    id: NodeId.create("join"),
    state: undefined,
    trigger: TriggerRule.anyOf(...edges.map((edge) => TriggerEntry.on(edge))),
    step: async function* () {
      const view = yield [];
      return edges.flatMap((edge) => [...from(view, edge)])[0];
    },
  });
  racers.forEach((racer, i) => {
    graph.addEdge(racer, join, edges[i]);
  });
  const waves: string[][] = [];
  const tokenEstimate: Record<string, number> = {
    R1: 900,
    R2: 100,
    R3: 300,
    join: 0,
  };
  const inner = choose<void, typeof StringSchema, string, never>({
    rank: (_snapshot, a, b) => tokenEstimate[a]! - tokenEstimate[b]!,
    width: () => 1,
  });
  const scheduler: Scheduler<void, typeof StringSchema, string, never> = async (
    s,
    signal,
  ) => {
    const d = await inner(s, signal);
    waves.push(nodeIds(d.selected));
    return d;
  };
  const execution = context({ graph, scheduler });
  let results = await execution.step();
  let winner = results.get(join);
  while (winner === undefined || !results.has(NodeId.create(winner))) {
    results = await execution.step();
    winner = results.get(join);
  }
  return {
    winner,
    waves,
    started: [...started],
    completedRacers: racers.filter((id) => results.has(id)),
  };
}
