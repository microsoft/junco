import { OpikTracer } from "dataflow-engine-opik";
import { tracer } from "junco";
import { Opik } from "opik";

/** Defaults to local Grafana; explicit values must be credential-free http(s) URLs. */
export function grafanaUrl(value = process.env.GRAFANA_URL ?? "http://localhost:8000"): string {
  const invalid = new Error("GRAFANA_URL must be a nonempty http(s) URL without credentials, query or fragment");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || value.includes("?") || value.includes("#")) throw invalid;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The caller owns the recorder; graph evaluation joins the tracer's completion promises. */
export async function benchmarkTelemetry(
  projectName: string,
  name: string,
  dashboard = "junco-telemetry",
): Promise<{ recorder: tracer.GrafanaRecorder; tracer: tracer.DataflowTracer }> {
  const url = grafanaUrl();
  const trace = new OpikTracer(new Opik({ apiUrl: process.env.OPIK_URL_OVERRIDE ?? "http://localhost:5173/api", projectName: process.env.OPIK_PROJECT_NAME ?? projectName }), name);
  const recorder = await tracer.GrafanaRecorder.create({ url, dashboard });
  console.error(`grafana: ${recorder.dashboardUrl}`);
  return { recorder, tracer: trace };
}
