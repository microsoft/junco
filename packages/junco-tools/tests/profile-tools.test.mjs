import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  AstEditTool,
  CodeGraphTool,
  LockPolicy,
  ToolCollection,
  YieldTool,
} from "../dist/index.js";
import { cleanup, copyTreeNative, seedFixture } from "./helpers.mjs";

/** A tiny ProfileRecorder collecting events. */
function profileRecorder() {
  const events = [];
  const recorder = {
    path: "",
    add_context: () => recorder,
    record: (event) => events.push(event),
    flush: async () => {},
    close: async () => {},
    events,
  };
  recorder.root = recorder;
  return recorder;
}

/** The counters and gauges of the last call's metrics events (generic + typed). */
function lastCall(recorder) {
  const start = recorder.events.findLastIndex((e) => e.kind === "start");
  const tail = recorder.events.slice(start);
  const counters = {};
  const gauges = {};
  for (const e of tail) {
    Object.assign(counters, e.counters);
    Object.assign(gauges, e.gauges);
  }
  const finish = tail.find((e) => e.kind === "finish");
  return { start: tail[0], finish, counters, gauges };
}

async function workspace(files) {
  const { root: scratch, seed: root } = await seedFixture({ files });
  const native = await copyTreeNative();
  const collection = await ToolCollection.create(root, {
    native,
    sandbox: "shared",
    policy: LockPolicy,
  });
  return {
    root,
    native,
    mux: collection.mux,
    dispose: () =>
      cleanup(
        () => collection.close(),
        () => rm(scratch, { recursive: true, force: true }),
      ),
  };
}

test("ast_edit reports preview and apply byte deltas from the typed result", {
  timeout: 60_000,
}, async () => {
  const ws = await workspace({ "src/n.ts": "export const n = 1;\n" });
  try {
    const recorder = profileRecorder();
    const tool = AstEditTool.create(ws.root, ws.native, ws.mux, recorder);
    const args = { rewrites: { 1: "22" }, path: "src/n.ts" };
    for (const [dryRun, operation, content] of [
      [true, "preview", "export const n = 1;\n"],
      [false, "apply", "export const n = 22;\n"],
    ]) {
      const result = await tool.execute("e", { ...args, dryRun });
      const { start, finish, counters } = lastCall(recorder);
      assert.deepEqual(
        [start.resource, start.category, start.tool, start.operation],
        ["edits", "AstEdit", "ast_edit", operation],
      );
      assert.equal(finish.outcome, "success");
      assert.equal(result.details.result.applied, !dryRun);
      assert.equal(counters.replacements, 1);
      assert.equal(counters.files_touched, 1);
      assert.equal(counters.deleted_bytes, 1);
      assert.equal(counters.inserted_bytes, 2);
      assert.equal(counters.net_bytes, 1);
      assert.equal(counters.change_records, 1);
      assert.equal(counters.limit_reached, 0);
      assert.equal(
        counters.response_bytes,
        Buffer.byteLength(JSON.stringify(result.details.result, null, 2)),
      );
      assert.equal(await readFile(join(ws.root, "src/n.ts"), "utf8"), content);
    }
  } finally {
    await ws.dispose();
  }
});

test("code_graph exports counts matching its typed results for all six views", {
  timeout: 60_000,
}, async () => {
  const ws = await workspace({
    "src/a.ts":
      'import { b } from "../src2/b";\nexport function a() { return b() }\n',
    "src2/b.ts":
      'import { a } from "../src/a";\nexport function b() { return a() }\n',
    "src/local.ts": "export function local() { return 1 }\n",
  });
  try {
    const recorder = profileRecorder();
    const tool = CodeGraphTool.create(
      ws.root,
      ws.native,
      ws.mux,
      () => recorder,
    );
    const run = async (input) => {
      const result = (await tool.execute("g", input)).details.result;
      return { result, ...lastCall(recorder) };
    };

    const map = await run({ action: "map" });
    assert.equal(map.start.operation, "map");
    assert.equal(map.counters.files, map.result.files);
    assert.equal(map.counters.symbols, map.result.symbols);
    assert.equal(map.counters.edges, map.result.edges);
    assert.equal(map.counters.clusters, map.result.clusters.length);
    assert.equal(map.counters.hotspots, map.result.hotspots.length);

    const hit = await run({ action: "search", query: "local" });
    assert.ok(hit.result.hits.length > 0);
    assert.equal(hit.counters.hits, hit.result.hits.length);
    assert.equal(hit.counters.candidates, hit.result.total_candidates);
    const miss = await run({ action: "search", query: "zzzqqq" });
    assert.equal(miss.counters.hits, 0);

    const deps = await run({ action: "deps", symbol: "a", direction: "in" });
    assert.equal(deps.start.operation, "deps");
    assert.equal(deps.counters.nodes, deps.result.nodes.length);
    assert.equal(deps.counters.edges, deps.result.edges.length);
    assert.equal(
      deps.gauges.max_depth_last,
      Math.max(0, ...deps.result.nodes.map((n) => n.depth)),
    );

    const cluster = { action: "cluster", maxSize: 1, omnipresent: 4294967295 };
    const first = await run({ ...cluster, limit: 1 });
    assert.equal(first.start.operation, "cluster.list");
    assert.equal(first.counters.rows, 1);
    assert.equal(first.gauges.next_offset_last, 1);
    assert.equal(first.gauges.has_next_page_last, 1);
    assert.equal(first.gauges.result_total_last, first.result.total);
    let page = first;
    while (page.result.next_offset !== null)
      page = await run({
        ...cluster,
        limit: 1,
        offset: page.result.next_offset,
      });
    assert.equal(page.gauges.next_offset_last, null);
    assert.equal(page.gauges.has_next_page_last, 0);
    assert.equal(page.gauges.offset_last, page.result.offset);

    const all = await run(cluster);
    const cycle = all.result.clusters.find((r) => r.cluster.file_count === 2);
    assert.equal(
      all.counters.cluster_files,
      all.result.clusters.reduce((t, r) => t + r.cluster.file_count, 0),
    );
    const members = await run({
      ...cluster,
      clusterView: "members",
      clusterId: cycle.cluster.id,
    });
    assert.equal(members.start.operation, "cluster.members");
    assert.equal(members.counters.members, members.result.members.length);
    assert.equal(members.counters.cluster_files, 2);
    const neighbors = await run({
      ...cluster,
      clusterView: "neighbors",
      clusterId: cycle.cluster.id,
    });
    assert.equal(neighbors.start.operation, "cluster.neighbors");
    assert.equal(
      neighbors.counters.neighbors,
      neighbors.result.neighbors.length,
    );
    assert.equal(
      neighbors.counters.incoming_edges,
      neighbors.result.neighbors.reduce(
        (t, r) => t + (r.incoming?.edges ?? 0),
        0,
      ),
    );

    await assert.rejects(tool.execute("g", { ...cluster, clusterView: "bad" }));
    const bad = lastCall(recorder);
    assert.equal(bad.start.operation, "invalid");
    assert.equal(bad.finish.outcome, "error");
  } finally {
    await ws.dispose();
  }
});

test("yield counts generic execution metrics", async () => {
  const recorder = profileRecorder();
  await new YieldTool(recorder).execute("y", { reason: "wait" });
  const { start, finish, counters } = lastCall(recorder);
  assert.deepEqual([start.category, start.operation], ["yield", "execute"]);
  assert.equal(finish.outcome, "success");
  assert.equal(counters.output_text_bytes, 4);
});
