import { test } from "bun:test";
import assert from "node:assert/strict";
import { agent, Deterministic, graph, JuncoGraph, schedules, syntax, tracer } from "junco";
import type { TSchema } from "typebox";
import { fauxRuntime, NATIVE_TOOL_BLOCK } from "./support.ts";

const options = () => ({
  cwd: process.cwd(),
  scheduler: () => schedules.parallel(),
  tracer: new tracer.DummyTracer(),
});

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
  error instanceof syntax.ValidationError && error.code === "document" &&
  error.path === "/graph/nodes/Child/graph/nodes/Worker/prompt";

test("explicit and implicit agents need a nonblank prompt before any graph acquires resources", async () => {
  let acquisitions = 0;
  for (const kind of [{}, { kind: "agent" }])
    for (const field of [{}, { prompt: "" }, { prompt: " \n\t" }]) {
      const doc = nested({ ...kind, ...field, system: "Not an instruction to run" });
      assert.throws(() => syntax.JuncoGraphValidator.validate(doc), promptError);
      const source = JSON.stringify(doc);
      assert.throws(() => syntax.parse(source), promptError);
      await assert.rejects(
        JuncoGraph.fromYaml(source, {
          ...options(),
          scheduler: () => {
            acquisitions++;
            return schedules.parallel();
          },
          createAgent: async () => {
            acquisitions++;
            throw new Error("unexpected acquisition");
          },
        }),
        promptError,
      );
    }
  assert.equal(acquisitions, 0);
});

for (const failure of ["invalid prompt", "legacy available"] as const)
  test(`${failure} releases transferred agents once without a request`, async () => {
    const { models, faux } = await fauxRuntime([]);
    const prepared: NonNullable<syntax.BuildOptions["agents"]>[string] =
      await agent.JuncoAgent.create({
        provider: "faux",
        model: "faux-1",
        models,
        tools: [],
        tool_block: NATIVE_TOOL_BLOCK,
      });
    const dispose = prepared[Symbol.asyncDispose].bind(prepared);
    let disposals = 0;
    prepared[Symbol.asyncDispose] = async () => {
      disposals++;
      await dispose();
    };
    const config = { ...options(), agents: { "Child/Worker": prepared } };
    if (failure === "legacy available")
      Object.defineProperty(config, "available", {
        get: () => assert.fail("legacy options must not be read or invoked"),
      });
    try {
      const doc = nested(failure === "invalid prompt" ? {} : { prompt: "Work" });
      await assert.rejects(
        JuncoGraph.fromYaml(doc, config),
        failure === "invalid prompt" ? promptError : (error) =>
          error instanceof graph.DataflowDefinitionError && /available.*trigger/.test(error.message),
      );
      assert.equal(disposals, 1);
      assert.equal(faux.state.callCount, 0);
    } finally {
      await prepared.return();
    }
  });

test("a stale factory registration is rejected by node name and releases its unregistered state", async () => {
  let state: Deterministic<TSchema, unknown> | undefined;
  let disposals = 0;
  let activations = 0;
  const legacy = ({ policy }: syntax.CodeContext) => {
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
      ...options(),
      // @ts-expect-error A stale JavaScript factory returns a registration rather than its state.
      code: { Worker: legacy },
    }),
    (error) => error instanceof graph.DataflowDefinitionError && /Child\/Worker.*Deterministic/.test(error.message),
  );
  assert.equal(state?.signal.aborted, true);
  assert.equal(disposals, 1);
  assert.equal(activations, 0);
});

test("a never-triggered emit stays parked", async () => {
  const execution = await JuncoGraph.fromYaml(
    {
      graph: {
        nodes: { Seed: { kind: "emit", trigger: "never", text: "Go", spec: "Done" } },
        sink: { stream: true, trigger: "never" },
        edges: [{ from: "Seed", to: "$sink", kind: "message", schema: {} }],
      },
    },
    options(),
  );
  try {
    assert.equal(execution.graph.available().size, 0);
    assert.equal((await execution.run()).size, 0);
    assert.equal(execution.graph.available().size, 0);
  } finally {
    await execution.graph.close();
  }
});
