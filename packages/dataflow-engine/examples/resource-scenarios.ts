import {
  choose,
  context,
  limit,
  lowest,
  nodeIds,
  parallel,
  type Scheduler,
} from "junco-scheduler";
import { Type } from "typebox";
import {
  constantProfile,
  DataflowGraph,
  type DataflowTracer,
  Edge,
  EmitOnce,
  from,
  gigabytes,
  Message,
  megabytes,
  NodeId,
  StepNode,
  TriggerEntry,
  TriggerRule,
  tokens,
  UNBOUNDED,
} from "../src/index.ts";

const StringSchema = Type.String();

/** Admit each activation under 4 GB; retained memory needs separate headroom. */
export async function runMemoryLimit(tracer?: DataflowTracer): Promise<{
  readonly waves: readonly (readonly string[])[];
  readonly consumed: readonly string[];
  readonly sourceResult: string | undefined;
}> {
  const graph = new DataflowGraph<
    void,
    typeof StringSchema,
    string,
    never,
    "memory"
  >(UNBOUNDED, UNBOUNDED, tracer);
  const edges = ["toA", "toB", "toC", "toD"].map((name) =>
    Edge.message<typeof StringSchema, string>(name, StringSchema),
  );
  const source = graph.addNode(
    new EmitOnce<void, typeof StringSchema, string, "memory">(
      () => edges.map((edge) => Message.create(edge, "go")),
      "source done",
      {
        id: NodeId.create("source"),
        state: undefined,
        trigger: TriggerRule.always(),
        profiles: { memory: constantProfile("memory", megabytes(1)) },
      },
    ),
  );
  const consumed: string[] = [];
  for (const [i, name] of ["A", "B", "C", "D"].entries()) {
    const edge = edges[i];
    const sink = graph.addNode(
      new StepNode<void, typeof StringSchema, string, "memory">(
        () => {
          consumed.push(name);
          return [];
        },
        {
          id: NodeId.create(name),
          state: undefined,
          trigger: TriggerRule.when(edge),
          profiles: {
            memory: constantProfile(
              "memory",
              megabytes([3000, 3000, 2000, 900][i]),
            ),
          },
        },
      ),
    );
    graph.addEdge(source, sink, edge);
  }
  const waves: string[][] = [];
  const inner = limit<void, typeof StringSchema, string, never>(
    { memory: gigabytes(4) },
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

/** The zero-cost anyOf consumer completes before unstarted racers can run. */
export async function runTokenRace(tracer?: DataflowTracer): Promise<{
  readonly winner: string | undefined;
  readonly waves: readonly (readonly string[])[];
  readonly started: readonly string[];
  readonly completedRacers: readonly string[];
}> {
  const graph = new DataflowGraph<
    void,
    typeof StringSchema,
    string,
    never,
    "tokens"
  >(UNBOUNDED, UNBOUNDED, tracer);
  const edges = ["e1", "e2", "e3"].map((name) =>
    Edge.message<typeof StringSchema, string>(name, StringSchema),
  );
  const started = new Set<string>();
  let winner: string | undefined;
  const racers = ["R1", "R2", "R3"].map((name, i) =>
    graph.addNode({
      id: NodeId.create(name),
      state: undefined,
      trigger: TriggerRule.always(),
      profiles: {
        tokens: constantProfile("tokens", tokens([900, 100, 300][i])),
      },
      is_available: (_view, triggered) =>
        triggered && (winner === undefined || started.has(name)),
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
    profiles: { tokens: constantProfile("tokens", tokens(0)) },
    step: async function* () {
      const view = yield [];
      winner = edges.flatMap((edge) => [...from(view, edge)])[0];
      return winner;
    },
  });
  racers.forEach((racer, i) => {
    graph.addEdge(racer, join, edges[i]);
  });
  const waves: string[][] = [];
  const inner = choose<void, typeof StringSchema, string, never>({
    rank: lowest("tokens"),
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
  const results = await context({ graph, scheduler }).run();
  return {
    winner: results.get(join),
    waves,
    started: [...started],
    completedRacers: racers.filter((id) => results.has(id)),
  };
}
