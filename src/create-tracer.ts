import { feature } from "bun:bundle";
import type { DataflowTracer } from "dataflow-engine";
import { StdoutTracer } from "./stdout-tracer.js";

/** The automatically selected tracer, built on first successful use. */
let automatic: DataflowTracer | undefined;

/**
 * The shared automatic tracer: an Opik exporter under the `opik` Bun feature, otherwise a
 * {@link StdoutTracer}. Every call returns the same instance once one is constructed.
 *
 * @throws {Error} when the `opik` feature is enabled and Opik cannot be loaded or configured.
 */
export function createTracer(): DataflowTracer {
  if (automatic === undefined) {
    if (feature("opik")) {
      const { OpikDataflowTracer } = require("dataflow-engine-opik");
      const { Opik } = require("opik");
      automatic = new OpikDataflowTracer(
        new Opik(),
        "JuncoGraph.run",
      ) as DataflowTracer;
    } else {
      automatic = new StdoutTracer("JuncoGraph.run");
    }
  }
  return automatic;
}
