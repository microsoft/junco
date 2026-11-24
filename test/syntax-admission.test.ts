import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import {
  Deterministic,
  graph,
  JuncoGraph,
  schedules,
  syntax,
  tracer,
} from "junco";
import type { TSchema } from "typebox";
import { countedCollection, offlineLadder } from "./support.ts";

const args = { cwd: process.cwd(), tracer: new tracer.DummyTracer() };
const parameters: syntax.JuncoParameters = {
  scheduler: () => schedules.parallel(),
};

const nested = (worker: object) => ({
  graph: {
    nodes: {
      Child: {
        kind: "graph",
        graph: {
          nodes: { Worker: worker },
          edges: [{ from: "Worker", to: "$sink", schema: {} }],
        },
      },
    },
    edges: [{ from: "Child", to: "$sink", schema: {} }],
  },
});
const promptError = (error: unknown) =>
  error instanceof syntax.ValidationError &&
  error.code === "document" &&
  error.path === "/graph/nodes/Child/graph/nodes/Worker/prompt";

test("explicit and implicit agents may omit a prompt but cannot supply a blank one", async () => {
  let acquisitions = 0;
  for (const kind of [{}, { kind: "agent" }]) {
    syntax.JuncoGraphValidator.validate(nested(kind));
    for (const field of [{ prompt: "" }, { prompt: " \n\t" }]) {
      const doc = nested({
        ...kind,
        ...field,
        system: "Not an instruction to run",
      });
      assert.throws(
        () => syntax.JuncoGraphValidator.validate(doc),
        promptError,
      );
      const source = JSON.stringify(doc);
      assert.throws(() => syntax.parse(source), promptError);
      await assert.rejects(
        JuncoGraph.fromYaml(source, {
          args,
          parameters: {
            scheduler: () => {
              acquisitions++;
              return schedules.parallel();
            },
          },
        }),
        promptError,
      );
    }
  }
  assert.equal(acquisitions, 0);
});

for (const [failure, stale] of [
  ["invalid prompt"],
  ["missing parameters"],
  ["available in envelope", "envelope"],
  ["available in args", "args"],
  ["available in parameters", "parameters"],
] as const)
  test(`${failure} releases the transferred session once without a request`, async () => {
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    const close = session.close.bind(session);
    let disposals = 0,
      requests = 0;
    session.close = async (context) => {
      disposals++;
      return close(context);
    };
    const { collection, events, active } = countedCollection();
    const config = {
      args: {
        ...args,
        collection,
        agentOptions: new Map([
          [graph.NodeId.create("Child/Worker"), { session }],
        ]),
      },
      parameters: {
        ...parameters,
        ladder: await offlineLadder(() => {
          requests++;
          assert.fail("unexpected request");
        }),
      },
    };
    if (failure === "missing parameters")
      Reflect.deleteProperty(config, "parameters");
    else if (stale)
      Object.defineProperty(
        stale === "envelope" ? config : config[stale],
        "available",
        {
          enumerable: true,
          get: () => assert.fail("legacy options must not be read or invoked"),
        },
      );
    try {
      const doc = nested({
        prompt: failure === "invalid prompt" ? "  " : "Work",
      });
      await assert.rejects(
        JuncoGraph.fromYaml(doc, config),
        failure === "invalid prompt"
          ? promptError
          : (error) =>
              error instanceof graph.DataflowDefinitionError &&
              (failure === "missing parameters"
                ? error.message ===
                  "junco-syntax: fromYaml requires { args, parameters }"
                : /available.*trigger/.test(error.message)),
      );
      assert.equal(disposals, 1);
      assert.equal(requests, 0);
      assert.deepEqual(events, []);
      assert.deepEqual(active, { leases: 0, bindings: 0, creatorCloses: 0 });
    } finally {
      await collection.close();
      if (!disposals) await session.close(BACKGROUND_CONTEXT);
      await repo.close(BACKGROUND_CONTEXT);
    }
  });

test("a stale factory registration is rejected by node name and releases its unregistered state", async () => {
  let state: Deterministic<TSchema, unknown> | undefined;
  let disposals = 0;
  let activations = 0;
  const legacy = ({ policy }: syntax.CodeContext) => {
    // biome-ignore lint/correctness/useYield: this stale registration must not run even its first activation.
    state = new Deterministic<TSchema, unknown>(async function* () {
      activations++;
      return 1;
    }, policy);
    const close = state.close.bind(state);
    state.close = async () => {
      disposals++;
      await close();
    };
    return { state, is_available: () => assert.fail("a legacy predicate ran") };
  };
  await assert.rejects(
    JuncoGraph.fromYaml(nested({ kind: "code" }), {
      args: {
        ...args,
        // @ts-expect-error A stale JavaScript factory returns a registration rather than its state.
        code: { Worker: legacy },
      },
      parameters,
    }),
    (error) =>
      error instanceof graph.DataflowDefinitionError &&
      /Child\/Worker.*Deterministic/.test(error.message),
  );
  assert.equal(state?.signal.aborted, true);
  assert.equal(disposals, 1);
  assert.equal(activations, 0);
});

test("a never-triggered emit stays parked", async () => {
  const execution = await JuncoGraph.fromYaml(
    {
      graph: {
        nodes: {
          Seed: { kind: "emit", trigger: "never", text: "Go", spec: "Done" },
        },
        sink: { stream: true, trigger: "never" },
        edges: [{ from: "Seed", to: "$sink", kind: "message", schema: {} }],
      },
    },
    { args, parameters },
  );
  try {
    assert.equal(execution.graph.available().size, 0);
    assert.equal((await execution.run()).size, 0);
    assert.equal(execution.graph.available().size, 0);
  } finally {
    await execution.graph.close();
  }
});
