#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { DataflowDefinitionError } from "dataflow-engine";
import { fitProfiles } from "./fit.js";
import { formatProfiles, parsePins, parseSamples } from "./schema.js";

const args = process.argv.slice(2);
if (!(args.length === 2 || (args.length === 4 && args[2] === "--pins"))) {
  console.error("usage: profile-fit <samples.jsonl> <profiles.json> [--pins <pins.json>]");
  process.exit(2);
}
try {
  const samples = parseSamples(readFileSync(args[0]!, "utf8"));
  const pins = args.length === 4 ? parsePins(readFileSync(args[3]!, "utf8")) : undefined;
  const { file, report, underSampled } = fitProfiles(samples, { pins, fittedAt: new Date().toISOString().slice(0, 10) });
  writeFileSync(args[1]!, formatProfiles(file));
  console.table(report);
  console.log(`under-sampled (n < 5): ${underSampled.length === 0 ? "none" : underSampled.join(", ")}`);
} catch (error) {
  if (!(error instanceof DataflowDefinitionError)) throw error;
  console.error(error.message);
  process.exit(1);
}
