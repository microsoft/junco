import { expect, test } from "bun:test";
import { LoopGuard, type LoopGuardCall } from "../src/index.ts";

const edit: LoopGuardCall = {
  toolName: "edit",
  args: { path: "a.ts" },
  text: "ok",
  isError: false,
};
const probe = (line: number): LoopGuardCall => ({
  toolName: "probe",
  args: {},
  text: `Error: boom at line ${line}`,
  isError: true,
});
const loop = [edit, probe(7), edit, probe(9)];

test("a stuck run is redirected once, then held, then left alone", () => {
  const fold = new LoopGuard({ minCalls: 4, editChurn: 2, failures: 2 }).run();
  const first = loop.map(fold);
  expect(first.slice(0, 3)).toEqual([undefined, undefined, undefined]);
  expect(first[3]?.kind).toBe("redirect");
  expect(first[3]?.kind === "redirect" && first[3].text).toMatch(
    /^Process check \(automated\): so far this run made 2 edit\(s\) across 1 file\(s\) \(most to `a\.ts`\), 2 tool call\(s\) failed, and the same failure recurred 1 time\(s\)/,
  );
  expect(loop.map(fold)).toEqual([
    undefined,
    undefined,
    undefined,
    {
      kind: "hold",
      reason:
        "loop guard: stuck after 1 redirect(s): 2 failing tool result(s), 1 repeated failure(s), 2 edit(s) across 1 file(s)",
    },
  ]);
  expect(loop.map(fold)).toEqual([undefined, undefined, undefined, undefined]);
});

test("a new run starts a fresh fold, and distinct failures are not stagnation", () => {
  const guard = new LoopGuard({ minCalls: 4, editChurn: 2, failures: 2 });
  const fresh = guard.run();
  // Two different failure signatures never repeat, so the segment is not stuck.
  const distinct: LoopGuardCall = { ...probe(1), text: "cannot open socket" };
  expect([edit, probe(1), edit, distinct].map(fresh)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect(guard.run()(edit)).toBeUndefined();
});

test("hashline edit headers count each file", () => {
  const fold = new LoopGuard({
    minCalls: 3,
    editChurn: 9,
    distinctFiles: 2,
    failures: 2,
  }).run();
  const hashline: LoopGuardCall = {
    toolName: "edit",
    args: { input: "[src/x.ts#A1B2]\nPUT 1.=1:\n+x\n[src/y.ts#C3D4]\nCUT 2" },
    text: "ok",
    isError: false,
  };
  const verdicts = [hashline, probe(1), probe(2)].map(fold);
  expect(verdicts[2]?.kind === "redirect" && verdicts[2].text).toContain(
    "2 edit(s) across 2 file(s) (most to `src/x.ts`)",
  );
});

test("defaults are TokenEconomizer's and invalid options are rejected", () => {
  expect(new LoopGuard().options).toEqual({
    redirects: 1,
    minCalls: 20,
    editChurn: 4,
    distinctFiles: 3,
    failures: 6,
    stagnation: 0.2,
  });
  expect(() => new LoopGuard({ redirects: -1 })).toThrow(
    new RangeError("LoopGuard redirects must be a non-negative safe integer"),
  );
  expect(() => new LoopGuard({ minCalls: 0 })).toThrow(
    new RangeError("LoopGuard minCalls must be a positive safe integer"),
  );
  expect(() => new LoopGuard({ stagnation: 1.5 })).toThrow(
    new RangeError("LoopGuard stagnation must be a number between 0 and 1"),
  );
});
