import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCampaign } from "../scripts/backfill-cooperbench.ts";

test("offline replay preserves complete and interrupted committed histories and seals deterministic reusable output", async () => {
  const root = await mkdtemp(join(tmpdir(), "junco-backfill-"));
  try {
    const campaign = join(root, "recorded-campaign");
    await mkdir(campaign);
    await writeFile(
      join(campaign, "config.json"),
      JSON.stringify({
        run_name: "recorded-campaign",
        tasks: [1, 2, 3, 4].map((task_id) => ({
          repo: "repo",
          task_id,
          features: [1, 2],
        })),
      }),
    );
    const times = [
      "2026-11-01T10:00:00.100Z",
      "2026-11-01T10:00:00.900Z",
      "2026-11-01T10:00:02.321Z",
    ];
    const usage = {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: {
        input: 0.02,
        output: 0.03,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.05,
      },
    };
    const operation = {
      resource: "operations",
      category: "graph",
      tool: "",
      operation: "evaluate",
    };
    const rows = [
      { timestamp: times[0], event: { kind: "start", ...operation } },
      {
        timestamp: times[1],
        event: { kind: "usage", resource: "tokens", source: "object_1", usage },
      },
      {
        timestamp: times[1],
        event: { kind: "usage", resource: "cost", source: "object_1", usage },
      },
      {
        timestamp: times[2],
        event: {
          kind: "metrics",
          ...operation,
          counters: { observed_calls: 1 },
          gauges: { queue_depth: 2 },
        },
      },
      {
        timestamp: times[2],
        event: {
          kind: "finish",
          ...operation,
          outcome: "success",
          durationMs: 2221,
        },
      },
    ].map((row, i) => ({
      seq: i + 1,
      node: "a%3Ab",
      node_ids: ["a:b"],
      ...row,
    }));
    let completeRaw = "";
    for (const id of [1, 2]) {
      const directory = join(campaign, `team/repo/${id}/f1_f2/.junco`);
      await mkdir(directory, { recursive: true });
      const stream = `junco_${String(id).repeat(32)}`;
      await writeFile(
        join(directory, "telemetry.json"),
        JSON.stringify({
          version: 1,
          run_id: String(id + 2).repeat(32),
          stream_id: stream,
          grafana_url: "http://localhost:8000",
          dashboard_url: `http://localhost:8000/d/junco-telemetry?var-stream=${stream}`,
          raw_complete: id === 1,
          profile_complete: id === 1,
          grafana_complete: id === 1,
          errors: [],
        }),
      );
      const raw = `${(id === 1 ? rows : rows.slice(0, -1)).map((row) => JSON.stringify(row)).join("\n")}\n`;
      await writeFile(join(directory, "profile_events.jsonl"), raw);
      if (id === 1) completeRaw = raw;
      // Deliberately enormous lossy aggregate: it is not an event source.
      await writeFile(
        join(directory, "log.jsonl"),
        JSON.stringify({ tokens_used: 999999999, cost_total: 999999999 }),
      );
      await writeFile(
        join(directory, "result.json"),
        JSON.stringify({ totalTokens: 999999999 }),
      );
    }
    await mkdir(join(campaign, "team/repo/3/f1_f2"), { recursive: true });
    const out = join(root, "first");
    const receipt = await prepareCampaign(campaign, out);
    expect(receipt.counts).toMatchObject({
      planned: 4,
      streams: 2,
      rows: 9,
      snapshots: 4,
      stale: 0,
      nonfinite: 0,
    });
    expect(receipt.usage.tokens).toBe(10);
    expect(receipt.usage.cost).toBeCloseTo(0.1, 12);
    expect(receipt.partialUsage).toEqual({ tokens: 5, cost: 0.05 });
    expect(
      receipt.classifications.map(
        (s: { classification: string }) => s.classification,
      ),
    ).toEqual(["complete", "partial", "attempted-no-raw", "not-attempted"]);
    expect(receipt.rawMinMs).toBe(Date.parse(times[0]!));
    expect(receipt.emittedMinMs).toBe(Date.parse(times[1]!));
    expect(receipt.emittedMaxMs).toBe(Date.parse(times[2]!));
    for (const stream of receipt.streams) {
      expect(stream.emittedMinMs).toBe(Date.parse(times[1]!));
      expect(stream.nodes["a%3Ab"].tokens).toBe(5);
      expect(new URL(stream.dashboardUrl).searchParams.get("from")).toBe(
        String(Date.parse(times[0]!)),
      );
    }
    const content = await readFile(join(out, "campaign.openmetrics"), "utf8");
    expect(content.endsWith("# EOF\n")).toBe(true);
    expect(content).not.toMatch(
      /memory|probe|completion="not-attempted"|NaN|Infinity/,
    );
    const points = content
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    expect(points.length).toBe(receipt.counts.samples);
    const seen = new Set<string>();
    for (const point of points) {
      const match = /^(\w+\{.*\}) (\S+) (\d+\.\d{3})$/.exec(point)!;
      expect(match).not.toBeNull();
      expect([
        Date.parse(times[1]!) / 1000,
        Date.parse(times[2]!) / 1000,
      ]).toContain(Number(match[3]));
      const key = `${match[1]} ${match[3]}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    const tokenSamples = points.filter((p) =>
      p.startsWith("junco_total_tokens_used{"),
    );
    expect(tokenSamples).toHaveLength(4);
    expect(tokenSamples.every((p) => /\} 5 /.test(p))).toBe(true);
    const partialSuccess = points.filter(
      (p) =>
        p.startsWith("junco_operation_success{") &&
        p.includes('completion="partial"'),
    );
    expect(partialSuccess.every((p) => /\} 0 /.test(p))).toBe(true);
    const again = await prepareCampaign(campaign, join(root, "second"));
    expect(again.openmetrics.sha256).toBe(receipt.openmetrics.sha256);
    expect(await readFile(join(root, "second/receipt.json"), "utf8")).toBe(
      await readFile(join(out, "receipt.json"), "utf8"),
    );
    expect(await prepareCampaign(campaign, out)).toEqual(receipt);
    const receiptPath = join(out, "receipt.json");
    await writeFile(
      receiptPath,
      JSON.stringify({ ...receipt, converterHash: "changed-converter" }),
    );
    await expect(prepareCampaign(campaign, out)).rejects.toThrow(
      "source/converter mismatch",
    );
    const unrelated = join(root, "unrelated");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep"), "original");
    await expect(prepareCampaign(campaign, unrelated)).rejects.toThrow(
      "nonempty/incomplete",
    );
    const rawPath = join(
      campaign,
      "team/repo/1/f1_f2/.junco/profile_events.jsonl",
    );
    for (const [label, invalid, error] of [
      [
        "stale",
        completeRaw.replace('"queue_depth":2', '"queue_depth":null'),
        "stale",
      ],
      [
        "nonfinite",
        completeRaw.replace('"queue_depth":2', '"queue_depth":1e309'),
        "metric",
      ],
      ["gap", completeRaw.replace('"seq":2', '"seq":20'), "sequence"],
      [
        "path",
        completeRaw.replace('"node":"a%3Ab"', '"node":"a:b"'),
        "canonical",
      ],
      [
        "schema",
        completeRaw.replace('"kind":"start"', '"kind":"unknown"'),
        "unsupported",
      ],
    ]) {
      await writeFile(rawPath, invalid!);
      await expect(
        prepareCampaign(campaign, join(root, label!)),
      ).rejects.toThrow(error!);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
