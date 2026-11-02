import { runTokenRace } from "./resource-scenarios.ts";
import { ExampleTracer } from "./tracing.ts";

const tracer = ExampleTracer.create("examples/token-race");
const { winner, waves } = await runTokenRace(tracer);
console.log(JSON.stringify({ winner, waves }));
