import { mkdirSync, writeFileSync } from "node:fs";
import { PinsFileSchema, ProfilesFileSchema, SampleSchema } from "../src/schema.js";

const directory = new URL("../schemas/", import.meta.url);
mkdirSync(directory, { recursive: true });
for (const [name, schema] of [
  ["profiles", ProfilesFileSchema],
  ["samples", SampleSchema],
  ["pins", PinsFileSchema],
] as const) {
  writeFileSync(new URL(`${name}.schema.json`, directory), JSON.stringify(schema, null, 2) + "\n");
}
