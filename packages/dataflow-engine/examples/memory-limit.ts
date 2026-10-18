import { runMemoryLimit } from "./resource-scenarios.ts";
import { ExampleTracer } from "./tracing.ts";

const tracer = ExampleTracer.create("examples/memory-limit");
try {
  const { waves } = await runMemoryLimit(tracer);
  console.log(JSON.stringify(waves));
} finally {
  await tracer.flush();
}
