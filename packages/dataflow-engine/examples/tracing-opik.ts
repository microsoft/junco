import { OpikTracer } from "dataflow-engine-opik";
import { Opik } from "opik";
import type { DataflowTracer } from "../src/index.ts";

/** One SDK client per example process, configured from the standard Opik environment/config. */
const client = new Opik({
  apiUrl: process.env.OPIK_URL_OVERRIDE ?? "http://localhost:5173/api",
});

export const ExampleTracer = {
  create(name: string): DataflowTracer {
    return new OpikTracer(client, name);
  },
};
