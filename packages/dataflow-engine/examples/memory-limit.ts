import { runMemoryLimit } from "./resource-scenarios.ts";
import { ExampleTracer } from "./tracing.ts";

const tracer = ExampleTracer.create("examples/memory-limit");
const { waves } = await runMemoryLimit(tracer);
console.log(JSON.stringify(waves));
