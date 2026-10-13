import type { DataflowTracer } from "../src/index.ts";
import { DummyTracer } from "../src/index.ts";

/** Stateless, so every example shares it. */
const tracer = new DummyTracer();

export const ExampleTracer = {
  create(_name: string): DataflowTracer {
    return tracer;
  },
};
