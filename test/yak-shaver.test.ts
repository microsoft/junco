import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AcceptedRefactor,
  type Candidate,
  type CandidateOutcome,
  type CandidateWork,
  type CheckedProposal,
  type GraftSnapshot,
  ProposalRecorder,
  parseSnapshot,
  partitionSearch,
  type RefactorApplier,
  type RefactorVerdict,
  rankCandidates,
  refactorCandidates,
  runCandidateBatch,
  type SearchReport,
  type SnapshotRefresher,
  type SourceEdit,
  VerdictRecorder,
} from "../examples/yak-shaver/yak-shaver.ts";
import { agent, Deterministic, graph, tracer } from "../src/index.ts";
import { flushMacrotasks, waitingTool } from "./support.ts";
import {
  allPass,
  barrier,
  type LaneScript,
  type NodeInput,
  type ScriptedLane,
  scriptedLane,
  snapshotOf,
  wiring,
} from "./yak-shaver.fixture.ts";

const quiet = () => new tracer.DummyTracer();
const ids = (candidates: readonly Candidate[]) =>
  candidates.map((candidate) => candidate.definition.id);
const find = (snapshot: GraftSnapshot, id: string): Candidate => {
  const found = rankCandidates(snapshot).find(
    (candidate) => candidate.definition.id === id,
  );
  assert.ok(found, id);
  return found;
};
const workOf = (
  snapshot: GraftSnapshot,
  id: string,
  rank = 1,
): CandidateWork => {
  const candidate = find(snapshot, id);
  return { rank, candidate, shards: partitionSearch(snapshot, candidate) };
};

// ## Ranking

describe("ranking", () => {
  test("depth is the longest root path in component hops; cycles share a depth; unreached is null", () => {
    const snapshot = snapshotOf(
      [
        { id: "src/api.ts#root", kind: "function", exported: true },
        { id: "src/lib.ts#Leaf" },
        { id: "src/lib.ts#A" },
        { id: "src/lib.ts#B" },
        { id: "src/lib.ts#X" },
        { id: "src/lib.ts#Y" },
        { id: "src/lib.ts#Lonely" },
        {
          id: "src/gen.go#gen",
          kind: "function",
          exported: true,
          origin: "generic",
        },
        { id: "src/gen.go#G" },
        { id: "test/t.test.ts#t", kind: "function" },
        { id: "src/lib.ts#T" },
      ],
      [
        ["src/api.ts#root", "src/lib.ts#Leaf"],
        ["src/api.ts#root", "src/lib.ts#A"],
        ["src/lib.ts#A", "src/lib.ts#B", "references", "inferred"],
        ["src/lib.ts#B", "src/lib.ts#Leaf"],
        ["src/api.ts#root", "src/lib.ts#X"],
        ["src/lib.ts#X", "src/lib.ts#Y"],
        ["src/lib.ts#Y", "src/lib.ts#X"],
        ["src/gen.go#gen", "src/gen.go#G"],
        ["test/t.test.ts#t", "src/lib.ts#T"],
      ],
    );
    const leaf = find(snapshot, "src/lib.ts#Leaf");
    assert.equal(leaf.depth, 3, "the longer root→A→B→Leaf path wins");
    assert.deepEqual(leaf.rootPath, [
      ["src/api.ts#root"],
      ["src/lib.ts#A"],
      ["src/lib.ts#B"],
      ["src/lib.ts#Leaf"],
    ]);
    const x = find(snapshot, "src/lib.ts#X");
    const y = find(snapshot, "src/lib.ts#Y");
    assert.equal(x.depth, 1);
    assert.equal(y.depth, 1);
    assert.deepEqual(x.componentIds, ["src/lib.ts#X", "src/lib.ts#Y"]);
    assert.equal(find(snapshot, "src/lib.ts#Lonely").depth, null);
    assert.equal(
      find(snapshot, "src/gen.go#G").depth,
      null,
      "a generic-origin export is not a public root",
    );
    assert.equal(
      find(snapshot, "src/lib.ts#T").depth,
      1,
      "a test path is a root",
    );
  });

  test("a 20,000-node chain is ranked without recursion", () => {
    const length = 20_000;
    const nodes: NodeInput[] = [
      { id: "src/api.ts#root", kind: "function", exported: true },
      ...Array.from({ length }, (_, index) => ({
        id: `src/chain.ts#T${index}`,
      })),
    ];
    const edges = [
      ["src/api.ts#root", "src/chain.ts#T0"] as const,
      ...Array.from(
        { length: length - 1 },
        (_, index) =>
          [`src/chain.ts#T${index}`, `src/chain.ts#T${index + 1}`] as const,
      ),
    ];
    const ranked = rankCandidates(snapshotOf(nodes, edges));
    assert.equal(ranked[0]?.definition.id, `src/chain.ts#T${length - 1}`);
    assert.equal(ranked[0]?.depth, length);
  });

  test("methods count as uses of their type; callers are distinct definitions; order is stable", () => {
    const nodes: NodeInput[] = [
      { id: "src/c.ts#C", span: "L1-L10" },
      { id: "src/c.ts#C.m", kind: "method", span: "L2-L4" },
      { id: "src/c.ts#C.n", kind: "method", owner: "C", span: "L5-L7" },
      { id: "src/u.ts#use", kind: "function", exported: true },
      { id: "src/k.ts#K" },
      { id: "src/k.ts#f2", kind: "function" },
      { id: "src/k.ts#f3", kind: "function" },
      { id: "src/e.ts#E0", exported: true },
      { id: "src/e.ts#E1", exported: true },
      { id: "src/e.ts#E2", exported: true },
      { id: "src/e.ts#g", kind: "function" },
      { id: "src/e.ts#h", kind: "function" },
      { id: "src/z.ts#Unrooted" },
    ];
    const edges = [
      ["src/c.ts#C", "src/c.ts#C.m", "contains"],
      ["src/u.ts#use", "src/c.ts#C.m"],
      ["src/c.ts#C.m", "src/c.ts#C.n"],
      ["src/u.ts#use", "src/k.ts#K"],
      ["src/c.ts#C.m", "src/k.ts#K"],
      ["src/u.ts#use", "src/k.ts#K", "references"],
      ["src/k.ts#f2", "src/k.ts#K"],
      ["src/k.ts#f3", "src/k.ts#K"],
      ["src/k.ts#f3", "src/k.ts#K"],
      ["src/e.ts#g", "src/e.ts#E1"],
      ["src/e.ts#g", "src/e.ts#E2"],
      ["src/e.ts#h", "src/e.ts#E2"],
    ] as const;
    const snapshot = snapshotOf(nodes, edges);
    const c = find(snapshot, "src/c.ts#C");
    assert.deepEqual(c.memberIds, [
      "src/c.ts#C",
      "src/c.ts#C.m",
      "src/c.ts#C.n",
    ]);
    assert.deepEqual(c.callerIds, ["src/u.ts#use"], "C.m→C.n is internal");
    assert.equal(c.depth, 1);
    assert.deepEqual(find(snapshot, "src/k.ts#K").callerIds, [
      "src/c.ts#C.m",
      "src/k.ts#f2",
      "src/k.ts#f3",
      "src/u.ts#use",
    ]);
    const order = [
      "src/k.ts#K", // depth 2, four callers: depth dominates caller count
      "src/c.ts#C", // depth 1, one caller
      "src/e.ts#E1", // depth 0, one caller
      "src/e.ts#E2", // depth 0, two callers
      "src/e.ts#E0", // depth 0, zero callers after positive counts
      "src/z.ts#Unrooted",
    ];
    assert.deepEqual(ids(rankCandidates(snapshot)), order);
    const permuted = JSON.parse(wiring(nodes, edges));
    permuted.nodes.reverse();
    permuted.edges.reverse();
    assert.deepEqual(
      ids(rankCandidates(parseSnapshot(JSON.stringify(permuted)))),
      order,
    );
  });
});

// ## Search shards

describe("search shards", () => {
  const files = [
    { id: "a/b/c.ts#Cand" },
    { id: "a/b/d.ts#user", kind: "function" },
    { id: "a/x.ts#X", kind: "function" },
    { id: "z/y/w.ts#W", kind: "function" },
    { id: "q.ts#Q", kind: "function" },
    { id: "a/b/e.ts#E" },
  ];

  test("far-first non-caller files, then caller files, dealt over three shards exactly once", () => {
    const snapshot = snapshotOf(files, [["a/b/d.ts#user", "a/b/c.ts#Cand"]]);
    const shards = partitionSearch(snapshot, find(snapshot, "a/b/c.ts#Cand"));
    assert.deepEqual(shards, [
      { name: "Search1", files: ["z/y/w.ts", "a/b/c.ts"] },
      { name: "Search2", files: ["q.ts", "a/b/e.ts"] },
      { name: "Search3", files: ["a/x.ts", "a/b/d.ts"] },
    ]);
    const all = shards.flatMap((shard) => shard.files).sort();
    assert.deepEqual(all, [...snapshot.files]);
  });

  test("zero callers anchor on the candidate's directory; few files make few shards", () => {
    const snapshot = snapshotOf(files);
    const order = partitionSearch(snapshot, find(snapshot, "a/b/e.ts#E"));
    assert.deepEqual(
      order.map((shard) => shard.files),
      [
        ["z/y/w.ts", "a/b/c.ts"],
        ["q.ts", "a/b/d.ts"],
        ["a/x.ts", "a/b/e.ts"],
      ],
    );
    const small = snapshotOf([{ id: "a.ts#A" }, { id: "b.ts#B" }]);
    assert.deepEqual(
      partitionSearch(small, find(small, "a.ts#A")).map((shard) => shard.files),
      [["a.ts"], ["b.ts"]],
    );
  });
});

// ## Proposal evidence and metrics

const keysSources = new Map([
  [
    "src/keys.ts",
    "export class Keys {\n  add(key: string): boolean {\n    return true;\n  }\n}\n",
  ],
  [
    "src/names.ts",
    "export function names(xs: string[]) {\n  const keys = new Keys();\n  return xs.filter((x) => keys.add(x));\n}\n",
  ],
  [
    "src/a.ts",
    [
      "export function dedupeA(rows: number[]) {",
      "  const seen = new Set<number>();",
      "  const out: number[] = [];",
      "  for (const row of rows) {",
      "    if (seen.has(row)) {",
      "      continue;",
      "    }",
      "    seen.add(row);",
      "    out.push(row);",
      "  }",
      "  return out;",
      "}",
      "",
    ].join("\n"),
  ],
  [
    "src/b.ts",
    "export function dedupeB(rows: number[]) {\r\n  return [...new Set(rows)];\r\n}\r\n",
  ],
  ["src/extra.ts", "// not indexed\n"],
]);

const keysSnapshot = snapshotOf(
  [
    { id: "src/keys.ts#Keys", span: "L1-L5", exported: true },
    { id: "src/keys.ts#Keys.add", kind: "method", span: "L2-L4" },
    { id: "src/names.ts#names", kind: "function", span: "L1-L4" },
    { id: "src/a.ts#dedupeA", kind: "function", span: "L1-L12" },
    { id: "src/b.ts#dedupeB", kind: "function", span: "L1-L3" },
  ],
  [
    ["src/keys.ts#Keys", "src/keys.ts#Keys.add", "contains"],
    ["src/names.ts#names", "src/keys.ts#Keys", "references"],
    ["src/names.ts#names", "src/keys.ts#Keys.add"],
  ],
);

const keysWork = workOf(keysSnapshot, "src/keys.ts#Keys");
const aBefore = keysSources.get("src/a.ts")!.split("\n").slice(1, 11);
const aAfter = [
  "  const keys = new Keys<number>();",
  "  const out: number[] = [];",
  "  for (const row of rows) if (keys.add(row)) out.push(row);",
  "  // generalized",
  "  return out;",
];
const bAfter = "  return rows.filter((row) => new Keys<number>().add(row));";
const site = (
  callerId: string,
  editIndex: number,
  line: string,
  expression: string,
  afterLine = 1,
) => ({
  callerId,
  editIndex,
  afterLine,
  column: line.indexOf(expression) + 1,
  expression,
});

/** A proposal for Keys<K>: 10 nonblank lines of dedupeA become 5; dedupeB's line is swapped. */
function keysProposal(overrides: Record<string, unknown> = {}) {
  const edits: SourceEdit[] = [
    {
      kind: "replace",
      path: "src/a.ts",
      startLine: 2,
      beforeLines: aBefore,
      afterLines: aAfter,
    },
    {
      kind: "replace",
      path: "src/b.ts",
      startLine: 2,
      beforeLines: ["  return [...new Set(rows)];"],
      afterLines: [bAfter],
    },
  ];
  const first = site("src/a.ts#dedupeA", 0, aAfter[0]!, "new Keys<number>()");
  return {
    candidateId: "src/keys.ts#Keys",
    kind: "proposal",
    generalization: "class Keys<K = string> { add(key: K): boolean }",
    compatibility: [
      { callerId: "src/names.ts#names", explanation: "K defaults to string." },
    ],
    substitutions: [
      {
        targetId: "src/a.ts#dedupeA",
        editIndexes: [0],
        explanation: "Its seen-set loop.",
      },
      {
        targetId: "src/b.ts#dedupeB",
        editIndexes: [1],
        explanation: "Its Set spread.",
      },
    ],
    edits,
    newSites: [
      first,
      first,
      site("src/a.ts#dedupeA", 0, aAfter[2]!, "keys.add(row)", 3),
      site("src/b.ts#dedupeB", 1, bAfter, "new Keys<number>()"),
    ],
    dependencyReason: "Two hand-rolled seen-sets collapse into Keys.",
    ...overrides,
  };
}

/** A recorder whose researchers have delivered one complete report per shard. */
function researched(work: CandidateWork = keysWork) {
  const recorder = new ProposalRecorder({
    snapshot: keysSnapshot,
    work,
    readSource: async (path) => keysSources.get(path),
  });
  const research: SearchReport[] = work.shards.map((shard) => ({
    shard: shard.name,
    searchedFiles: [...shard.files],
    status: "complete",
    report: `${shard.name}:   checked ${shard.files.join(", ")}`,
  }));
  for (const report of research) {
    recorder.noteTaskReport(
      JSON.stringify({
        type: "task_result",
        id: `task-${report.shard}`,
        name: report.shard,
        status: "completed",
        output: JSON.stringify(report),
        stopReason: "stop",
      }),
    );
  }
  const submit = (input: Record<string, unknown>) =>
    recorder.tool.execute("call", { research, ...input } as never);
  return { recorder, research, submit };
}

async function checkedKeysProposal(
  overrides: Record<string, unknown> = {},
): Promise<CheckedProposal> {
  const { recorder, submit } = researched();
  await submit(keysProposal(overrides));
  const proposal = recorder.takeProposal();
  assert.equal(proposal?.kind, "proposal");
  return proposal as CheckedProposal;
}

describe("proposal evidence", () => {
  test("metrics are computed from verified edits and distinct new sites", async () => {
    const proposal = await checkedKeysProposal();
    assert.deepEqual(proposal.metrics, {
      addedCallSites: 3,
      addedCallerDefinitions: 2,
      callersBefore: 1,
      projectedCallersAfter: 3,
      netLinesRemoved: 5,
    });
  });

  test("a site in an existing caller adds a site, not a caller definition; new files cost lines", async () => {
    const base = keysProposal();
    const namesLine = "  const keys = new Keys<string>();";
    const proposal = await checkedKeysProposal({
      edits: [
        ...base.edits,
        {
          kind: "replace",
          path: "src/names.ts",
          startLine: 2,
          beforeLines: ["  const keys = new Keys();"],
          afterLines: [namesLine],
        },
        {
          kind: "create",
          path: "src/keys-generic.ts",
          startLine: 1,
          beforeLines: [],
          afterLines: [
            "export type Key = string | number;",
            "",
            "// k",
            "// v",
          ],
        },
      ],
      newSites: [
        ...base.newSites,
        site("src/names.ts#names", 2, namesLine, "new Keys<string>()"),
      ],
    });
    assert.equal(proposal.metrics.addedCallSites, 4);
    assert.equal(proposal.metrics.addedCallerDefinitions, 2);
    assert.equal(proposal.metrics.netLinesRemoved, 2);
  });

  const invalid: [string, Record<string, unknown>, RegExp][] = [
    [
      "a mismatched source slice",
      {
        edits: [
          {
            ...keysProposal().edits[0]!,
            beforeLines: ["x", ...aBefore.slice(1)],
          },
          keysProposal().edits[1]!,
        ],
      },
      /does not match src\/a\.ts:L2/,
    ],
    [
      "a fabricated coordinate",
      {
        newSites: [
          {
            ...site("src/b.ts#dedupeB", 1, bAfter, "new Keys<number>()"),
            column: 3,
          },
        ],
      },
      /is not at afterLines/,
    ],
    [
      "missing caller compatibility",
      { compatibility: [] },
      /missing: src\/names\.ts#names/,
    ],
    [
      "overlapping edits",
      {
        edits: [
          ...keysProposal().edits,
          {
            kind: "replace",
            path: "src/a.ts",
            startLine: 5,
            beforeLines: aBefore.slice(3, 5),
            afterLines: [],
          },
        ],
      },
      /edits\[0\] and edits\[2\] overlap/,
    ],
    [
      "an external path",
      {
        edits: [
          ...keysProposal().edits,
          {
            kind: "create",
            path: "../outside.ts",
            startLine: 1,
            beforeLines: [],
            afterLines: ["x"],
          },
        ],
      },
      /repo-relative/,
    ],
    [
      "a create over an existing path",
      {
        edits: [
          ...keysProposal().edits,
          {
            kind: "create",
            path: "src/extra.ts",
            startLine: 1,
            beforeLines: [],
            afterLines: ["x"],
          },
        ],
      },
      /already exists/,
    ],
    [
      "an unknown substitution target",
      {
        substitutions: [
          { targetId: "src/a.ts#ghost", editIndexes: [0], explanation: "x" },
        ],
      },
      /unknown substitution target/,
    ],
    [
      "a wrong candidate",
      { candidateId: "src/a.ts#dedupeA" },
      /candidateId must be/,
    ],
  ];
  for (const [name, overrides, message] of invalid) {
    test(`rejects ${name}`, async () => {
      const { recorder, submit } = researched();
      await assert.rejects(submit(keysProposal(overrides)), message);
      assert.equal(recorder.peek(), undefined);
    });
  }

  test("rejects missing research coverage and research no researcher delivered", async () => {
    const { recorder, research, submit } = researched();
    await assert.rejects(
      submit({ ...keysProposal(), research: research.slice(0, 2) }),
      /incomplete: Search3/,
    );
    const fabricated = research.map((record) => ({
      ...record,
      report: "invented",
    }));
    await assert.rejects(
      submit({ ...keysProposal(), research: fabricated }),
      /no complete report/,
    );
    await assert.rejects(
      submit({
        candidateId: "src/keys.ts#Keys",
        kind: "none",
        research: research.slice(0, 2),
        reason: "nothing found",
      }),
      /name every incomplete shard: Search3/,
    );
    assert.equal(recorder.peek(), undefined);
  });

  test("the first result is final", async () => {
    const { recorder, submit } = researched();
    await submit(keysProposal());
    const first = recorder.peek();
    await assert.rejects(
      submit({ candidateId: "src/keys.ts#Keys", kind: "none", reason: "x" }),
      /already recorded/,
    );
    assert.equal(recorder.peek(), first);
    const verdict = new VerdictRecorder();
    await verdict.tool.execute("a", allPass);
    await assert.rejects(
      verdict.tool.execute("b", {
        ...allPass,
        semanticCoherence: { pass: false, evidence: "x" },
      }),
      /already recorded/,
    );
    assert.deepEqual(verdict.takeVerdict(), allPass);
  });
});

// ## Acceptance gates on real lanes

const failing = (
  name: keyof RefactorVerdict,
  evidence = "fails",
): RefactorVerdict => ({ ...allPass, [name]: { pass: false, evidence } });

const CRITERIA = [
  "minimalAugmentation",
  "preservesExistingCallers",
  "semanticCoherence",
  "dependencyImprovement",
] as const;

/** An applier recording what it was asked to apply; it stages the proposal's paths. */
function recordingApplier(
  before?: (refactor: AcceptedRefactor) => void | Promise<void>,
) {
  const applied: AcceptedRefactor[] = [];
  const apply: RefactorApplier = async (refactor) => {
    await before?.(refactor);
    applied.push(refactor);
    return [
      ...new Set(refactor.proposal.edits.map((edit) => edit.path)),
    ].sort();
  };
  return { applied, apply };
}

const keysScript = (
  overrides: Record<string, unknown> = {},
  verdict: RefactorVerdict = allPass,
): LaneScript => ({
  proposal: (research) => ({ ...keysProposal(overrides), research }),
  verdict,
});

/** One real batch of Keys lanes (ranks 1…n, one per script) with a recording applier. */
async function keysBatch(scripts: readonly LaneScript[]) {
  const lanes = await Promise.all(
    scripts.map((script, index) =>
      scriptedLane(
        { ...keysWork, rank: index + 1 },
        keysSnapshot,
        keysSources,
        script,
      ),
    ),
  );
  const recorder = recordingApplier();
  const outcomes = await runCandidateBatch({
    snapshot: keysSnapshot,
    lanes: lanes.map(({ lane }) => lane),
    observer: quiet(),
    apply: recorder.apply,
  });
  return { outcomes, applied: recorder.applied };
}

describe("acceptance gates", () => {
  test("each criterion is required on its own; a rejected lane applies nothing", async () => {
    const { outcomes, applied } = await keysBatch(
      CRITERIA.map((name) => keysScript({}, failing(name))),
    );
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      Array(4).fill("rejected"),
    );
    CRITERIA.forEach((name, index) => {
      assert.match(
        outcomes[index]?.reason ?? "",
        new RegExp(`^${name} failed`),
      );
    });
    assert.equal(applied.length, 0);
  }, 30_000);

  test("a fully approved proposal is applied once, with its lane's rank, proposal, and verdict", async () => {
    const { outcomes, applied } = await keysBatch([keysScript()]);
    const [outcome] = outcomes;
    assert.equal(outcome?.status, "applied");
    if (outcome?.status !== "applied") return;
    assert.deepEqual(outcome.files, ["src/a.ts", "src/b.ts"]);
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.rank, 1);
    assert.equal(applied[0]?.proposal, outcome.proposal);
    assert.deepEqual(applied[0]?.verdict, allPass);
    assert.equal(applied[0]?.candidate, keysWork.candidate);
  }, 30_000);

  test("all criteria still need a new caller definition and a positive net deletion", async () => {
    const namesLine = "  const keys = new Keys<string>();";
    const base = keysProposal();
    const { outcomes, applied } = await keysBatch([
      keysScript({
        edits: [
          base.edits[0],
          {
            kind: "replace",
            path: "src/names.ts",
            startLine: 2,
            beforeLines: ["  const keys = new Keys();"],
            afterLines: [namesLine],
          },
        ],
        substitutions: [base.substitutions[0]],
        newSites: [
          site("src/names.ts#names", 1, namesLine, "new Keys<string>()"),
        ],
      }),
      keysScript({
        edits: [base.edits[1]],
        substitutions: [{ ...base.substitutions[1]!, editIndexes: [0] }],
        newSites: [site("src/b.ts#dedupeB", 0, bAfter, "new Keys<number>()")],
      }),
    ]);
    const [noNewCaller, noSaving] = outcomes;
    assert.equal(noNewCaller?.status, "rejected");
    assert.equal(noSaving?.status, "rejected");
    if (noNewCaller?.status !== "rejected" || noSaving?.status !== "rejected")
      return;
    assert.equal(noNewCaller.proposal.metrics.addedCallerDefinitions, 0);
    assert.match(noNewCaller.reason, /no new caller definitions/);
    assert.equal(noSaving.proposal.metrics.netLinesRemoved, 0);
    assert.match(noSaving.reason, /net nonblank lines removed is 0/);
    assert.equal(applied.length, 0);
  }, 30_000);
});

// ## Admission and outcome validation

const nine = snapshotOf(
  Array.from({ length: 9 }, (_, index) => ({
    id: `fx/C${index + 1}.ts#C${index + 1}`,
  })),
);
const fabricated = (candidateId: string): CheckedProposal => ({
  candidateId,
  kind: "proposal",
  research: [],
  generalization: `GEN-${candidateId}`,
  compatibility: [],
  substitutions: [],
  edits: [
    {
      kind: "replace",
      path: "fx/shared.ts",
      startLine: 1,
      beforeLines: ["a", "b"],
      afterLines: [],
    },
  ],
  newSites: [],
  dependencyReason: "fixture",
  metrics: {
    addedCallSites: 1,
    addedCallerDefinitions: 1,
    callersBefore: 0,
    projectedCallersAfter: 1,
    netLinesRemoved: 2,
  },
});
const facts = (work: CandidateWork) => ({
  rank: work.rank,
  candidateId: work.candidate.definition.id,
  depth: work.candidate.depth,
  callerCount: work.candidate.callerIds.length,
});
const none = (work: CandidateWork): CandidateOutcome => ({
  ...facts(work),
  status: "no-proposal",
  reason: "fixture",
  proposal: {
    candidateId: work.candidate.definition.id,
    kind: "none",
    research: [],
    reason: "fixture",
  },
});
const appliedOutcome = (
  work: CandidateWork,
  files: readonly string[] = ["fx/shared.ts"],
  verdict: RefactorVerdict = allPass,
): CandidateOutcome => ({
  ...facts(work),
  status: "applied",
  reason: "fixture",
  proposal: fabricated(work.candidate.definition.id),
  verdict,
  files,
});
const noRefresh: SnapshotRefresher = async () =>
  assert.fail("no snapshot refresh was expected");

describe("admission", () => {
  test("groups of four wait for each other, later groups resolve against the refreshed snapshot, and outcomes match by ID", async () => {
    const refreshed = snapshotOf([
      ...[1, 2, 3, 4, 6, 9].map((n) => ({ id: `fx/C${n}.ts#C${n}` })),
      { id: "fx/C7.ts#C7", span: "L5-L9" },
      { id: "fx/C8.ts#C8", kind: "function" },
      { id: "fx/New.ts#New" },
    ]);
    const works: (readonly CandidateWork[])[] = [];
    const snapshots: GraftSnapshot[] = [];
    let refreshes = 0;
    const first = Promise.withResolvers<readonly CandidateOutcome[]>();
    const running = refactorCandidates(
      nine,
      async (snapshot, batch) => {
        works.push(batch);
        snapshots.push(snapshot);
        if (works.length === 1) return first.promise;
        return batch.map(none);
      },
      async () => {
        refreshes++;
        return refreshed;
      },
    );
    await flushMacrotasks();
    assert.equal(works.length, 1, "no later group is admitted early");
    assert.equal(refreshes, 0);
    const [w1, w2, w3, w4] = works[0]!;
    // Returned in reverse: outcomes are matched by ID, not by position.
    first.resolve([
      none(w4!),
      none(w3!),
      {
        ...facts(w2!),
        status: "rejected",
        reason: "semanticCoherence failed: fails",
        proposal: fabricated(w2!.candidate.definition.id),
        verdict: failing("semanticCoherence"),
      },
      appliedOutcome(w1!),
    ]);
    const run = await running;
    assert.deepEqual(
      works.map((batch) => batch.map((work) => work.candidate.definition.id)),
      [
        ["fx/C1.ts#C1", "fx/C2.ts#C2", "fx/C3.ts#C3", "fx/C4.ts#C4"],
        ["fx/C6.ts#C6", "fx/C7.ts#C7"],
        ["fx/C9.ts#C9"],
      ],
    );
    assert.deepEqual(
      works.map((batch) => batch.map((work) => work.rank)),
      [[1, 2, 3, 4], [6, 7], [9]],
    );
    assert.equal(refreshes, 1, "only a group that applied refreshes");
    assert.deepEqual(snapshots, [nine, refreshed, refreshed]);
    const c7 = works[1]![1]!;
    assert.equal(c7.candidate.definition.startLine, 5, "current spans");
    assert.ok(
      c7.shards.some((shard) => shard.files.includes("fx/New.ts")),
      "current search coverage",
    );
    assert.deepEqual(
      run.outcomes.map((outcome) => [outcome.rank, outcome.status]),
      [
        [1, "applied"],
        [2, "rejected"],
        [3, "no-proposal"],
        [4, "no-proposal"],
        [5, "removed"],
        [6, "no-proposal"],
        [7, "no-proposal"],
        [8, "removed"],
        [9, "no-proposal"],
      ],
    );
    assert.equal(
      run.outcomes[4]?.reason,
      "Candidate no longer exists after earlier refactors",
    );
    assert.ok(
      !run.outcomes.some((outcome) => outcome.candidateId === "fx/New.ts#New"),
      "new candidates are never admitted",
    );
    assert.deepEqual(
      run.applied.map((entry) => [
        entry.rank,
        entry.candidate.definition.id,
        entry.files,
      ]),
      [[1, "fx/C1.ts#C1", ["fx/shared.ts"]]],
    );
    assert.deepEqual(run.totals, {
      applied: 1,
      addedCallSites: 1,
      addedCallerDefinitions: 1,
      netLinesRemoved: 2,
    });
  });

  const malformed: [
    string,
    (batch: readonly CandidateWork[]) => CandidateOutcome[],
    RegExp,
  ][] = [
    ["missing", (batch) => batch.slice(1).map(none), /no outcome for fx\/C1/],
    ["duplicate", (batch) => [...batch.map(none), none(batch[0]!)], /twice/],
    [
      "foreign",
      (batch) => [
        ...batch.map(none),
        none({ candidate: find(nine, "fx/C9.ts#C9"), rank: 9, shards: [] }),
      ],
      /foreign candidate fx\/C9/,
    ],
    [
      "removed by the runner",
      (batch) => [
        { ...facts(batch[0]!), status: "removed", reason: "x" },
        ...batch.slice(1).map(none),
      ],
      /removed outcome for admitted fx\/C1/,
    ],
    [
      "applied without released paths",
      (batch) => [appliedOutcome(batch[0]!, []), ...batch.slice(1).map(none)],
      /nonempty, deduplicated released-path list/,
    ],
    [
      "applied with duplicate released paths",
      (batch) => [
        appliedOutcome(batch[0]!, ["fx/a.ts", "fx/a.ts"]),
        ...batch.slice(1).map(none),
      ],
      /nonempty, deduplicated released-path list/,
    ],
    [
      "applied against a failed gate",
      (batch) => [
        appliedOutcome(batch[0]!, undefined, failing("minimalAugmentation")),
        ...batch.slice(1).map(none),
      ],
      /fails its gates: minimalAugmentation failed/,
    ],
    [
      "a proposal without a structured verdict",
      (batch) => [
        {
          ...facts(batch[0]!),
          status: "rejected",
          reason: "Approved by the judge.",
          proposal: fabricated(batch[0]!.candidate.definition.id),
        } as unknown as CandidateOutcome,
        ...batch.slice(1).map(none),
      ],
      /has no verdict/,
    ],
  ];
  for (const [name, outcomes, message] of malformed) {
    test(`${name} outcomes fail without admitting the next group`, async () => {
      let calls = 0;
      await assert.rejects(
        refactorCandidates(
          nine,
          async (_snapshot, batch) => {
            calls++;
            return outcomes(batch);
          },
          noRefresh,
        ),
        message,
      );
      assert.equal(calls, 1);
    });
  }

  test("empty input runs nothing; the last group never refreshes", async () => {
    let calls = 0;
    const empty = await refactorCandidates(
      snapshotOf([]),
      async () => {
        calls++;
        return [];
      },
      noRefresh,
    );
    assert.equal(calls, 0);
    assert.deepEqual(empty, {
      outcomes: [],
      applied: [],
      totals: {
        applied: 0,
        addedCallSites: 0,
        addedCallerDefinitions: 0,
        netLinesRemoved: 0,
      },
    });
    const four = snapshotOf(
      [1, 2, 3, 4].map((n) => ({ id: `fx/C${n}.ts#C${n}` })),
    );
    const run = await refactorCandidates(
      four,
      async (_snapshot, batch) => batch.map((work) => appliedOutcome(work)),
      noRefresh,
    );
    assert.equal(run.totals.applied, 4);
  });

  test("a later failure keeps earlier applications and admits nothing after it", async () => {
    const published: string[] = [];
    const groups: number[] = [];
    await assert.rejects(
      refactorCandidates(
        nine,
        async (_snapshot, batch) => {
          groups.push(batch.length);
          if (groups.length === 2) throw new Error("stage failed");
          published.push(batch[0]!.candidate.definition.id);
          return [appliedOutcome(batch[0]!), ...batch.slice(1).map(none)];
        },
        async () => nine,
      ),
      /stage failed/,
    );
    assert.deepEqual(groups, [4, 4]);
    assert.deepEqual(published, ["fx/C1.ts#C1"]);
  });
});

// ## Real batch graphs on faux models

const dupSource = (name: string) =>
  [
    `export function ${name}(xs: number[]) {`,
    "  const seen = new Set<number>();",
    "  const out: number[] = [];",
    "  for (const x of xs) {",
    "    if (!seen.has(x)) out.push(x);",
    "    seen.add(x);",
    "  }",
    "  return out;",
    "}",
    "",
  ].join("\n");

const laneSnapshot = snapshotOf([
  ...[1, 2, 3, 4].map((n) => ({ id: `fx/C${n}.ts#C${n}` })),
  { id: "fx/dup1.ts#dupe1", kind: "function", span: "L1-L9" },
  { id: "fx/dup2.ts#dupe2", kind: "function", span: "L1-L9" },
]);
const laneSources = new Map([
  ...[1, 2, 3, 4].map((n) => [`fx/C${n}.ts`, `class C${n} {}\n`] as const),
  ["fx/dup1.ts", dupSource("dupe1")],
  ["fx/dup2.ts", dupSource("dupe2")],
]);

/** Cn.unique replaces dupe<n>'s loop: 7 nonblank lines become one call. */
const dupProposal =
  (n: number) =>
  (research: SearchReport[]): Record<string, unknown> => {
    const line = `  return C${n}.unique(xs);`;
    return {
      candidateId: `fx/C${n}.ts#C${n}`,
      kind: "proposal",
      research,
      generalization: `GEN-C${n}: static unique(xs) on C${n}`,
      compatibility: [],
      substitutions: [
        {
          targetId: `fx/dup${n}.ts#dupe${n}`,
          editIndexes: [0],
          explanation: "its loop",
        },
      ],
      edits: [
        {
          kind: "replace",
          path: `fx/dup${n}.ts`,
          startLine: 2,
          beforeLines: dupSource("x").split("\n").slice(1, 8),
          afterLines: [line],
        },
      ],
      newSites: [site(`fx/dup${n}.ts#dupe${n}`, 0, line, `C${n}.unique(xs)`)],
      dependencyReason: `dupe${n} reuses C${n}`,
    };
  };

const laneWorks = () =>
  [1, 2, 3, 4].map((n) => workOf(laneSnapshot, `fx/C${n}.ts#C${n}`, n));

function assertClosed(lanes: readonly ScriptedLane[]) {
  for (const { lane } of lanes) {
    assert.equal(lane.proposer.status, "closed");
    assert.equal(lane.judge.status, "closed");
  }
}

describe("candidate batch graph", () => {
  test("four lanes run in parallel with their own research stars and independent judges", async () => {
    const proposers = barrier(4);
    const held = Promise.withResolvers<void>();
    const heldEntered = Promise.withResolvers<void>();
    // Eleven of twelve researchers answer while Search2 of rank 2 is held.
    const othersAnswered = Promise.withResolvers<void>();
    let answered = 0;
    const onResearched = () => {
      if (++answered === 11) othersAnswered.resolve();
    };
    const scripts = [
      {
        proposal: dupProposal(1),
        earlySubmit: true,
        forbiddenProbe: "Search1",
      },
      {
        proposal: dupProposal(2),
        hold: {
          shard: "Search2",
          entered: () => heldEntered.resolve(),
          gate: held.promise,
        },
      },
      { readAssigned: true },
      { failures: { Search3: 1 } },
    ];
    const lanes = await Promise.all(
      laneWorks().map((work, index) =>
        scriptedLane(work, laneSnapshot, laneSources, {
          ...scripts[index],
          onResearched,
          barrier: proposers.enter,
        }),
      ),
    );
    const recorder = recordingApplier();
    const running = runCandidateBatch({
      snapshot: laneSnapshot,
      lanes: lanes.map(({ lane }) => lane),
      observer: quiet(),
      apply: recorder.apply,
    });
    const early = running.then(() =>
      assert.fail("the batch finished while a researcher was held"),
    );
    await Promise.race([
      Promise.all([heldEntered.promise, othersAnswered.promise]),
      early,
    ]);
    const [one, two, three, four] = lanes.map(({ log }) => log);
    assert.equal(
      proposers.peak(),
      4,
      "every proposer started before any continued",
    );
    for (const { log, lane } of lanes) {
      assert.equal(log.judgeCalls, 0, "no judge sees an unfinished lane");
      assert.equal(
        lane.proposal.peek(),
        undefined,
        "no lane submits before its reports arrive",
      );
    }
    assert.equal(recorder.applied.length, 0);
    held.resolve();
    const outcomes = await running;

    for (const { log } of lanes)
      assert.deepEqual(log.handles, ["Search1", "Search2", "Search3"]);
    assert.equal(
      lanes.reduce((sum, { log }) => sum + log.researchers, 0),
      12,
    );
    assert.match(
      one!.submitErrors[0] ?? "",
      /no complete report/,
      "an early submission fails",
    );
    assert.deepEqual(
      one!.forbidden.map(({ toolName, isError }) => [toolName, isError]),
      [
        ["task", true],
        ["submit_refactor", true],
      ],
      "researchers have neither task nor the proposer's result tool",
    );
    assert.equal(three!.judgeCalls, 0);
    assert.equal(
      three!.reads,
      laneSnapshot.files.length,
      "researchers read their whole shards",
    );
    assert.equal(four!.judgeCalls, 0);
    for (const [log, own, other] of [
      [one!, "GEN-C1", "GEN-C2"],
      [two!, "GEN-C2", "GEN-C1"],
    ] as const) {
      assert.equal(log.judgeCalls, 1);
      const [input] = log.judgeInputs;
      assert.equal(
        input?.length,
        1,
        "a fresh judge session sees only its prompt",
      );
      assert.ok(input?.[0]?.includes(own));
      assert.ok(!input?.[0]?.includes(other));
      assert.ok(
        input?.[0]?.includes("6 projected net nonblank source lines removed"),
      );
      assert.ok(!input?.[0]?.includes("waiting for researchers"));
    }

    assert.deepEqual(
      outcomes.map((outcome) => [outcome.candidateId, outcome.status]),
      [
        ["fx/C1.ts#C1", "applied"],
        ["fx/C2.ts#C2", "applied"],
        ["fx/C3.ts#C3", "no-proposal"],
        ["fx/C4.ts#C4", "no-proposal"],
      ],
    );
    assert.deepEqual(
      recorder.applied.map((entry) => entry.candidate.definition.id).sort(),
      ["fx/C1.ts#C1", "fx/C2.ts#C2"],
    );
    const failed = outcomes[3]!;
    assert.equal(failed.status, "no-proposal");
    if (failed.status !== "no-proposal") return;
    assert.deepEqual(
      failed.proposal.research.map(({ shard, status }) => [shard, status]),
      [
        ["Search1", "complete"],
        ["Search2", "complete"],
      ],
      "an ignored researcher leaves no record",
    );
    assert.match(failed.proposal.reason, /Search3/);
    assertClosed(lanes);
  }, 30_000);

  test("a completed review is applied at once, while a slower lane is still yielding", async () => {
    const scripts: LaneScript[] = [
      { proposal: dupProposal(1) },
      { proposal: dupProposal(2), verdict: failing("semanticCoherence") },
      { beforeResearchYields: 20 },
      {},
    ];
    const lanes = await Promise.all(
      laneWorks().map((work, index) =>
        scriptedLane(work, laneSnapshot, laneSources, scripts[index]),
      ),
    );
    const delayed = lanes[2]!;
    const observed: { id: string; yields: number; handles: number }[] = [];
    const recorder = recordingApplier((refactor) => {
      observed.push({
        id: refactor.candidate.definition.id,
        yields: delayed.log.yields,
        handles: delayed.log.handles.length,
      });
    });
    const inner = quiet();
    let finalizerState: unknown;
    let lastProposer: unknown;
    let finalized: unknown;
    let sink: unknown;
    let earlySink = false;
    const observer: tracer.DataflowTracer = {
      startRun: (workflow) => {
        const run = inner.startRun(workflow);
        if (
          workflow.getNode(graph.NodeId.create("FinalizeBatch")) === undefined
        )
          return run;
        finalizerState ??= workflow.getNode(
          graph.NodeId.create("FinalizeBatch"),
        )?.state;
        return {
          ...run,
          end: (results) => {
            run.end(results);
            lastProposer = results.get(graph.NodeId.create("Proposer:4"));
            finalized = results.get(graph.NodeId.create("FinalizeBatch"));
            sink = results.get(graph.NodeId.create("$sink"));
            if (
              sink !== undefined &&
              [
                "Proposer:1",
                "Proposer:2",
                "Proposer:3",
                "Proposer:4",
                "Judge:1",
                "Judge:2",
              ].some((id) => !results.has(graph.NodeId.create(id)))
            )
              earlySink = true;
          },
        };
      },
      complain: () => {},
      flush: () => inner.flush(),
    };
    const outcomes = await runCandidateBatch({
      snapshot: laneSnapshot,
      lanes: lanes.map(({ lane }) => lane),
      observer,
      apply: recorder.apply,
    });
    assert.equal(
      observed.length,
      1,
      "applied exactly once despite cumulative step results",
    );
    assert.equal(observed[0]?.id, "fx/C1.ts#C1");
    assert.ok(
      observed[0]!.yields < 20 && observed[0]!.handles === 0,
      `applied before the delayed lane researched (${observed[0]!.yields} yields)`,
    );
    assert.equal(delayed.log.yields, 20);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["applied", "rejected", "no-proposal", "no-proposal"],
    );
    const [applied] = outcomes;
    assert.ok(applied?.status === "applied");
    assert.deepEqual(applied.files, ["fx/dup1.ts"]);
    assert.ok(finalizerState instanceof Deterministic);
    assert.notEqual(lastProposer, undefined);
    assert.equal(
      finalized,
      lastProposer,
      "the code node returns the exact last proposer's message",
    );
    assert.equal(sink, finalized, "the sink receives the finalizer's result");
    assert.equal(
      earlySink,
      false,
      "the sink waits for every lane to be finalized",
    );
    assertClosed(lanes);
  }, 60_000);

  test("a construction failure closes registered and unregistered lanes without applying", async () => {
    const lanes = await Promise.all(
      laneWorks()
        .slice(0, 3)
        .map((work) => scriptedLane(work, laneSnapshot, laneSources, {})),
    );
    await lanes[1]!.lane.judge.return();
    const recorder = recordingApplier();
    await assert.rejects(
      runCandidateBatch({
        snapshot: laneSnapshot,
        lanes: lanes.map(({ lane }) => lane),
        observer: quiet(),
        apply: recorder.apply,
      }),
      (error: unknown) =>
        error instanceof agent.JuncoAgentError && error.code === "closed",
    );
    assert.equal(recorder.applied.length, 0);
    assertClosed(lanes);
  }, 30_000);

  test("a construction failure retains a disposal failure and still closes every lane", async () => {
    const lanes = await Promise.all(
      laneWorks()
        .slice(0, 3)
        .map((work) => scriptedLane(work, laneSnapshot, laneSources, {})),
    );
    await lanes[1]!.lane.judge.return();
    const member = lanes[2]!.lane.judge;
    const dispose = member[Symbol.asyncDispose].bind(member);
    const cleanupError = new Error("judge cleanup failed");
    member[Symbol.asyncDispose] = async () => {
      await dispose();
      throw cleanupError;
    };
    const recorder = recordingApplier();
    await assert.rejects(
      runCandidateBatch({
        snapshot: laneSnapshot,
        lanes: lanes.map(({ lane }) => lane),
        observer: quiet(),
        apply: recorder.apply,
      }),
      (error: unknown) =>
        error instanceof SuppressedError &&
        error.error === cleanupError &&
        error.suppressed instanceof agent.JuncoAgentError &&
        error.suppressed.code === "closed",
    );
    assert.equal(recorder.applied.length, 0);
    assertClosed(lanes);
  }, 30_000);

  test("an application failure stops the batch, keeps the earlier application, and closes every lane", async () => {
    const lanes = await Promise.all(
      laneWorks()
        .slice(0, 2)
        .map((work) =>
          scriptedLane(work, laneSnapshot, laneSources, {
            proposal: dupProposal(work.rank),
          }),
        ),
    );
    const recorder = recordingApplier(() => {
      if (recorder.applied.length === 1) throw new Error("stage failed");
    });
    await assert.rejects(
      runCandidateBatch({
        snapshot: laneSnapshot,
        lanes: lanes.map(({ lane }) => lane),
        observer: quiet(),
        apply: recorder.apply,
      }),
      (error: unknown) =>
        error instanceof graph.DataflowNodeError &&
        error.nodeId === graph.NodeId.create("FinalizeBatch") &&
        error.error instanceof Error &&
        error.error.message === "stage failed",
    );
    assert.equal(recorder.applied.length, 1);
    assertClosed(lanes);
  }, 30_000);

  for (const { name, script, message, judgeCalls } of [
    {
      name: "missing proposal",
      script: { skipProposal: true },
      message: /Proposer:1 finished without recording submit_refactor/,
      judgeCalls: 0,
    },
    {
      name: "missing verdict",
      script: { proposal: dupProposal(1), skipVerdict: true },
      message: /Judge:1 finished without recording judge_refactor/,
      judgeCalls: 1,
    },
    {
      name: "empty final answer",
      script: { proposerFinal: "" },
      message: /Proposer:1 produced an empty final message/,
      judgeCalls: 0,
    },
  ]) {
    test(`${name} fails in the code node and closes every lane`, async () => {
      const scripted = await scriptedLane(
        laneWorks()[0]!,
        laneSnapshot,
        laneSources,
        script,
      );
      const recorder = recordingApplier();
      await assert.rejects(
        runCandidateBatch({
          snapshot: laneSnapshot,
          lanes: [scripted.lane],
          observer: quiet(),
          apply: recorder.apply,
        }),
        (error: unknown) =>
          error instanceof graph.DataflowNodeError &&
          error.nodeId === graph.NodeId.create("FinalizeBatch") &&
          error.error instanceof Error &&
          message.test(error.error.message),
      );
      assert.equal(scripted.log.judgeCalls, judgeCalls);
      assert.equal(recorder.applied.length, 0);
      assertClosed([scripted]);
    }, 30_000);
  }

  test("cancelling right after a step recorded a completed review applies nothing", async () => {
    const [work] = laneWorks();
    const scripted = await scriptedLane(work!, laneSnapshot, laneSources, {
      proposal: dupProposal(1),
    });
    const controller = new AbortController();
    const inner = new tracer.DummyTracer();
    // A step's `end` sees its cumulative results just before `step()` resolves.
    const observer: tracer.DataflowTracer = {
      startRun: (graph) => {
        const run = inner.startRun(graph);
        return {
          ...run,
          end: (results) => {
            run.end(results);
            if ([...results.keys()].some((id) => String(id) === "Judge:1"))
              queueMicrotask(() =>
                controller.abort(new DOMException("stop", "AbortError")),
              );
          },
        };
      },
      complain: () => {},
      flush: () => inner.flush(),
    };
    const recorder = recordingApplier();
    await assert.rejects(
      runCandidateBatch(
        {
          snapshot: laneSnapshot,
          lanes: [scripted.lane],
          observer,
          apply: recorder.apply,
        },
        controller.signal,
      ),
      /stop/,
    );
    assert.ok(controller.signal.aborted);
    assert.equal(scripted.log.judgeCalls, 1, "the review had completed");
    assert.equal(recorder.applied.length, 0);
    assertClosed([scripted]);
  }, 30_000);

  test("a proposer failure closes every lane, applies nothing, and admits no later batch", async () => {
    const five = snapshotOf(
      [1, 2, 3, 4, 5].map((n) => ({ id: `fx/C${n}.ts#C${n}` })),
    );
    const sources = new Map(
      [1, 2, 3, 4, 5].map((n) => [`fx/C${n}.ts`, `class C${n} {}\n`]),
    );
    const created: ScriptedLane[] = [];
    const recorder = recordingApplier();
    let calls = 0;
    await assert.rejects(
      refactorCandidates(
        five,
        async (snapshot, batch, signal) => {
          calls++;
          const lanes = await Promise.all(
            batch.map((work) =>
              scriptedLane(work, snapshot, sources, {
                proposerFails: work.rank === 1,
              }),
            ),
          );
          created.push(...lanes);
          return runCandidateBatch(
            {
              snapshot,
              lanes: lanes.map(({ lane }) => lane),
              observer: quiet(),
              apply: recorder.apply,
            },
            signal,
          );
        },
        noRefresh,
      ),
      (error: unknown) =>
        error instanceof graph.DataflowNodeError &&
        error.nodeId === graph.NodeId.create("FinalizeBatch") &&
        error.error instanceof Error &&
        /Proposer:1 did not finish normally: error: proposer exploded/.test(
          error.error.message,
        ),
    );
    assert.equal(calls, 1);
    assert.equal(recorder.applied.length, 0);
    assertClosed(created);
  }, 30_000);

  test("failed researchers: ignored shards stay missing, while immediate discretion retries only the failed shard", async () => {
    const work = laneWorks()[0]!;
    const cases = [
      { failures: { Search2: 1 }, missing: ["Search2"] },
      {
        failures: { Search1: 1, Search2: 1, Search3: 1 },
        missing: ["Search1", "Search2", "Search3"],
      },
      {
        failures: { Search2: 1 },
        missing: [],
        policy: { retries: 0 },
        failureDecision: "retry",
      },
    ] as const;
    for (const { failures, missing, ...recovery } of cases) {
      const scripted = await scriptedLane(work, laneSnapshot, laneSources, {
        proposal: dupProposal(1),
        failures,
        ...("failureDecision" in recovery
          ? { failureDecision: recovery.failureDecision }
          : {}),
      });
      const recorder = recordingApplier();
      const [outcome] = await runCandidateBatch({
        snapshot: laneSnapshot,
        lanes: [scripted.lane],
        observer: quiet(),
        apply: recorder.apply,
        ...("policy" in recovery ? { taskFailurePolicy: recovery.policy } : {}),
      });
      const { log } = scripted;
      const label = JSON.stringify({ failures, ...recovery });
      assert.deepEqual(log.handles, ["Search1", "Search2", "Search3"], label);
      // Each shard succeeds at most once: retries rerun only the failed shard.
      const expectedStarts = Object.fromEntries(
        work.shards.map(({ name }) => [
          name,
          1 +
            (missing.length === 0
              ? ((failures as Record<string, number>)[name] ?? 0)
              : 0),
        ]),
      );
      assert.deepEqual(log.starts, expectedStarts, label);
      assert.equal(log.decisions.length, missing.length === 0 ? 1 : 0, label);
      assert.ok(outcome, label);
      if (missing.length > 0) {
        assert.equal(outcome.status, "no-proposal", label);
        if (outcome.status !== "no-proposal") continue;
        assert.deepEqual(
          outcome.proposal.research.map(({ shard }) => shard).sort(),
          work.shards
            .map(({ name }) => name)
            .filter((name) => !missing.includes(name as never)),
          label,
        );
        for (const name of missing)
          assert.match(outcome.proposal.reason, new RegExp(name), label);
        assert.equal(log.judgeCalls, 0, label);
        assert.equal(recorder.applied.length, 0, label);
      } else {
        assert.equal(outcome.status, "applied", label);
        assert.equal(log.judgeCalls, 1, label);
        assert.equal(recorder.applied.length, 1, label);
        assert.deepEqual(
          recorder.applied[0]?.proposal.research
            .map(({ shard, status }) => [shard, status])
            .sort(),
          work.shards.map(({ name }) => [name, "complete"]),
          label,
        );
      }
      assertClosed([scripted]);
    }
  }, 30_000);
});

// ## Cancellation through admission

describe("admission cancellation", () => {
  test("cancellation reaches a blocked researcher, applies nothing, and closes every lane", async () => {
    const five = snapshotOf(
      [1, 2, 3, 4, 5].map((n) => ({ id: `fx/C${n}.ts#C${n}` })),
    );
    const sources = new Map(
      [1, 2, 3, 4, 5].map((n) => [`fx/C${n}.ts`, `class C${n} {}\n`]),
    );
    const hang = waitingTool("hang", { endOnAbort: true });
    const controller = new AbortController();
    const recorder = recordingApplier();
    const created: ScriptedLane[] = [];
    let calls = 0;
    const running = refactorCandidates(
      five,
      async (snapshot, batch, signal) => {
        calls++;
        const lanes = await Promise.all(
          batch.map((work) =>
            scriptedLane(
              work,
              snapshot,
              sources,
              work.rank === 1
                ? { hang: { shard: "Search1", tool: "hang" } }
                : {},
              [hang.tool],
            ),
          ),
        );
        created.push(...lanes);
        return runCandidateBatch(
          {
            snapshot,
            lanes: lanes.map(({ lane }) => lane),
            observer: quiet(),
            apply: recorder.apply,
          },
          signal,
        );
      },
      noRefresh,
      controller.signal,
    );
    await hang.started;
    controller.abort(new DOMException("stop", "AbortError"));
    await assert.rejects(running);
    await hang.aborted;
    assert.equal(calls, 1);
    assert.equal(recorder.applied.length, 0);
    assertClosed(created);
  }, 30_000);
});

// ## Command line preflight

describe("command line", () => {
  const root = resolve(import.meta.dir, "..");
  const cli = (...args: string[]) =>
    Bun.spawn(["bun", "run", "examples/yak-shaver/yak-shaver.ts", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

  test("a directory outside a dedicated seed fails before building or any model work; extra arguments are refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yak-shaver-"));
    try {
      const run = cli(dir);
      assert.notEqual(await run.exited, 0);
      assert.notEqual((await new Response(run.stderr).text()).trim(), "");
      assert.equal(existsSync(join(dir, "graft")), false, "no graft build ran");
      const extra = cli(dir, "extra");
      assert.notEqual(await extra.exited, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
