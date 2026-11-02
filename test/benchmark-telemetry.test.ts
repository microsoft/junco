import { expect, test } from "bun:test";
import type { tracer } from "junco";
import { benchmarkTelemetry } from "../examples/benchmark-telemetry.ts";

type Otlp = {
  resourceMetrics: {
    scopeMetrics: {
      metrics: {
        name: string;
        gauge: {
          dataPoints: {
            attributes: { key: string; value: { stringValue: string } }[];
            asDouble?: number;
          }[];
        };
      }[];
    }[];
  }[];
};

test.each(["junco-telemetry", "junco-swebench"])(
  "benchmark telemetry links and metrics select %s without provider requests",
  async (dashboard) => {
    const collection =
      "/grafana/apis/dashboard.grafana.app/v1/namespaces/default/dashboards";
    const pushes: Otlp[] = [];
    const created: string[] = [];
    let unexpected = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === `${collection}/${dashboard}` && request.method === "GET")
          return new Response(null, { status: 404 });
        if (path === collection && request.method === "POST") {
          const body = await request.json();
          created.push(body.metadata.name);
          return Response.json(body, { status: 201 });
        }
        if (path === "/grafana/api/telemetry/metrics") {
          pushes.push(await request.json());
          return new Response(null, { status: 200 });
        }
        unexpected++;
        return new Response(null, { status: 404 });
      },
    });
    const previous = {
      GRAFANA_URL: process.env.GRAFANA_URL,
      OPIK_URL_OVERRIDE: process.env.OPIK_URL_OVERRIDE,
    };
    process.env.GRAFANA_URL = `${server.url.origin}/grafana/`;
    process.env.OPIK_URL_OVERRIDE = `${server.url.origin}/api`;
    let live: tracer.GrafanaRecorder | undefined;
    try {
      // The generic case deliberately uses the unchanged two-argument API.
      const telemetry =
        dashboard === "junco-telemetry"
          ? await benchmarkTelemetry("benchmark-test", "test-session")
          : await benchmarkTelemetry("swebench", "test-session", dashboard);
      live = telemetry.recorder;
      expect(live.dashboardUrl).toBe(
        `${server.url.origin}/grafana/d/${dashboard}?var-stream=${live.streamId}`,
      );
      live.record({
        kind: "usage",
        resource: "tokens",
        source: {},
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      live.record({
        kind: "probe",
        resource: "probe",
        edgeId: "route",
        value: 7,
      });
      await live.close();
      expect(created).toEqual([dashboard]);
      const metrics = pushes.flatMap((payload) =>
        payload.resourceMetrics.flatMap((resource) =>
          resource.scopeMetrics.flatMap((scope) => scope.metrics),
        ),
      );
      expect(
        metrics.some(
          (metric) =>
            metric.name === "junco_total_tokens_used" &&
            metric.gauge.dataPoints.some((point) => point.asDouble === 3),
        ),
      ).toBe(true);
      expect(
        metrics.some((metric) => metric.name.startsWith("junco_probe_")),
      ).toBe(true);
      for (const metric of metrics)
        for (const point of metric.gauge.dataPoints) {
          const labels = Object.fromEntries(
            point.attributes.map(({ key, value }) => [key, value.stringValue]),
          );
          expect(labels.dashboard).toBe(dashboard);
          expect(labels.stream).toBe(live.streamId);
        }
      expect(unexpected).toBe(0);
    } finally {
      await live?.close().catch(() => undefined);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await server.stop(true);
    }
  },
);
