import { OpikTracer } from "dataflow-engine-opik";
import { Opik } from "opik";
import type { DataflowTracer } from "../src/index.ts";

/** One SDK client per example process, configured from the standard Opik environment/config. */
const client = new Opik();

export const ExampleTracer = {
  create(name: string): DataflowTracer {
    return new OpikTracer(client, name);
  },
};
