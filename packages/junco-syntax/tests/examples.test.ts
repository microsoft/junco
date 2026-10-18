import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../src/index.ts";
import { edgeId } from "../src/parse.ts";
import type { GraphSpec } from "../src/schema.ts";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const expected: Record<string, { nodes: string[]; edges: string[] }> = {
  mcp: {
    nodes: ["Research", "Dependencies"],
    edges: ["Research->Dependencies", "Dependencies->$sink"],
  },
  mixed: {
    nodes: ["Goals", "Direct", "Ralph", "Reviewer"],
    edges: [
      "Goals~>Direct",
      "Goals~>Ralph",
      "Direct->Reviewer",
      "Ralph~>Reviewer",
      "Reviewer->$sink",
    ],
  },
  "recursive-agency": { nodes: ["0", "1"], edges: ["0->$sink"] },
  verus: {
    nodes: ["Verifier", "Reviewer", "Cleanup"],
    edges: ["Verifier->Reviewer", "Reviewer->Cleanup", "Cleanup->$sink"],
  },
  "oss-committee": {
    nodes: ["Librarian", "Architect", "Reducer"],
    edges: [
      "Librarian~>Architect",
      "Librarian->Architect",
      "Librarian->Reducer",
      "Architect->Reducer",
      "Reducer->$sink",
    ],
  },
  "yak-shaver": {
    nodes: ["Proposer", "Judge"],
    edges: ["proposal", "Proposer->$sink"],
  },
};

test("all paired example YAML files parse with their declared topology", () => {
  const seen: string[] = [];
  for (const dir of readdirSync(examples, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === "dist") continue;
    for (const file of readdirSync(join(examples, dir.name)).filter((f) =>
      f.endsWith(".yml"),
    )) {
      const name = file.slice(0, -4);
      const doc = parse(readFileSync(join(examples, dir.name, file), "utf8"));
      const topology = expected[name];
      assert.ok(topology, `unexpected YAML example ${file}`);
      assert.deepEqual(Object.keys(doc.graph.nodes), topology.nodes, name);
      assert.deepEqual(
        (doc.graph.edges ?? []).map(edgeId),
        topology.edges,
        name,
      );
      seen.push(name);
      if (name === "recursive-agency") {
        let spec: GraphSpec = doc.graph;
        for (const label of ["root", "child", "grandchild"]) {
          assert.equal(spec.name, label);
          assert.deepEqual((spec.edges ?? []).map(edgeId), ["0->$sink"]);
          const node = spec.nodes["0"];
          assert.ok(node);
          if (label === "grandchild") assert.ok("model" in node);
          else {
            assert.equal(node.kind, "graph");
            if (node.kind === "graph") spec = node.graph;
          }
        }
      }
      if (name === "oss-committee") {
        const architect = doc.graph.nodes.Architect;
        assert.ok(architect && "trigger" in architect);
        assert.deepEqual(architect.trigger, {
          any: ["Librarian~>Architect", "Librarian->Architect"],
        });
      }
    }
  }
  assert.deepEqual(seen.sort(), Object.keys(expected).sort());
});
