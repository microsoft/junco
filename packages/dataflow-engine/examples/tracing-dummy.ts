import type { DataflowTracer } from "../src/index.ts";
import { DummyTracer } from "../src/index.ts";

/** Stateless, so every example shares it. */
const tracer = new DummyTracer();

export function createExampleTracer(_name: string): DataflowTracer {
  return tracer;
}
