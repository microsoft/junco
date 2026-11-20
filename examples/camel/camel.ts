// CaMeL (https://arxiv.org/abs/2503.18813, Fig. 5): a privileged planner sees only the
// user query; Interpreter reads a fixture email, QLLM parses it without tools,
// and Executor propagates capabilities and checks junco-policy before sending to a fixture outbox.
// Requires the built junco-tools native addon and Pi's saved GitHub Copilot login (`pi` -> `/login`).
//   bun run examples/camel/camel.ts
//   bun run examples/camel/camel.ts "Forward my last email to Bob; his address is in it"
// In a TTY, dismiss the final trace with q/Esc to print the outcome JSON.

import { basename, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { graph, JuncoGraph, schedules, syntax, Task, tools, tracer } from "junco";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { problemRecorder, runCli, verifiedModels } from "../support.ts";
import source from "./camel.yml" with { type: "text" };

export type Email = {
  id_: string;
  sender: string;
  recipients: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  timestamp: string;
};
export type CamelContext = { readonly inbox: readonly Email[]; readonly sent: Email[] };
export const USER = "emma.johnson@bluesparrowtech.com";
export const BOB_QUERY = "Find Bob's email in my last email and send him a reminder about tomorrow's meeting";
export const INBOX: readonly Email[] = [
  {
    id_: "1", sender: "david.smith@bluesparrowtech.com", recipients: [USER], cc: [], bcc: [],
    subject: "Q2 budget", body: "Emma, the Q2 budget draft is in the shared drive.", timestamp: "2024-05-14T09:00:00",
  },
  {
    id_: "2", sender: "alice.hart@bluesparrowtech.com", recipients: [USER], cc: [], bcc: [],
    subject: "Bob's contact",
    body: "Hi Emma, as promised here is Bob Wilson's address: bob.wilson@example.com. He asked you to remind him about tomorrow's meeting.",
    timestamp: "2024-05-15T10:30:00",
  },
];

function getLastEmail(inbox: readonly Email[]): Email {
  if (inbox.length === 0) throw new Error("inbox is empty");
  return inbox.reduce((last, email) => email.timestamp > last.timestamp ? email : last);
}

function sendEmail(context: CamelContext, recipients: string[], subject: string, body: string): Email {
  for (const recipient of recipients) {
    if (typeof recipient !== "string" || !recipient.includes("@"))
      throw new Error(`invalid recipient ${JSON.stringify(recipient)}`);
  }
  const email: Email = {
    id_: String(context.inbox.length + context.sent.length + 1),
    sender: USER, recipients, cc: [], bcc: [], subject, body, timestamp: new Date().toISOString(),
  };
  context.sent.push(email);
  return email;
}

type Readers = readonly string[] | "public";
type Var = { value: unknown; sources: readonly string[]; readers: Readers };
const dedupe = (values: readonly string[]): string[] => [...new Set(values)];
const isTrusted = (value: Var): boolean => value.sources.every((source) => source === "user");

function emailVar(email: Email): Var {
  return {
    value: email,
    sources: ["get_last_email"],
    readers: dedupe([email.sender, ...email.recipients, ...email.cc, ...email.bcc]),
  };
}

function intersectReaders(a: Readers, b: Readers): Readers {
  if (a === "public") return b;
  if (b === "public") return a;
  return a.filter((reader) => b.includes(reader));
}

function resolve(template: string, store: Record<string, Var>): Var {
  const reference = /\{([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\}/g;
  const lookup = (name: string, field?: string): Var => {
    if (!Object.hasOwn(store, name)) throw new Error(`unknown variable {${name}}`);
    const variable = store[name]!;
    if (field === undefined) return variable;
    if (typeof variable.value !== "object" || variable.value === null || !Object.hasOwn(variable.value, field))
      throw new Error(`unknown variable {${name}.${field}}`);
    return { ...variable, value: (variable.value as Record<string, unknown>)[field] };
  };
  const matches = [...template.matchAll(reference)];
  if (matches.length === 1 && template.trim() === matches[0]![0])
    return lookup(matches[0]![1]!, matches[0]![2]);
  const deps: Var[] = [];
  const value = template.replace(reference, (_match, name: string, field?: string) => {
    const dep = lookup(name, field);
    deps.push(dep);
    return typeof dep.value === "object" ? JSON.stringify(dep.value) : String(dep.value);
  });
  return {
    value,
    sources: dedupe(["user", ...deps.flatMap((dep) => dep.sources)]),
    readers: deps.reduce<Readers>((readers, dep) => intersectReaders(readers, dep.readers), "public"),
  };
}

function asString(value: Var, what: string): string {
  if (typeof value.value !== "string") throw new Error(`${what} must be a string`);
  return value.value;
}

const FieldType = Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]);
const Step = Type.Union([
  Type.Object({ tool: Type.Literal("get_last_email"), as: Type.String() }, { additionalProperties: false }),
  Type.Object({
    tool: Type.Literal("query_ai_assistant"), query: Type.String(),
    output_schema: Type.Record(Type.String(), FieldType), as: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    tool: Type.Literal("send_email"), recipients: Type.Array(Type.String(), { minItems: 1 }),
    subject: Type.String(), body: Type.String(),
  }, { additionalProperties: false }),
]);
const Plan = Type.Object({ steps: Type.Array(Step, { minItems: 1 }) }, { additionalProperties: false });

function parseJson<T extends TSchema>(text: string, schema: T, who: string): Static<T> {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`${who} returned no JSON object`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${who} returned invalid JSON: ${error.message}`);
  }
  if (!Value.Check(schema, parsed))
    throw new Error(`${who} output does not match the schema: ${[...Value.Errors(schema, parsed)][0]?.message}`);
  return parsed;
}

function outputSchemaOf(fields: Record<string, Static<typeof FieldType>>) {
  const types = { string: Type.String(), number: Type.Number(), boolean: Type.Boolean() };
  return Type.Object({
    ...Object.fromEntries(Object.entries(fields).map(([field, type]) => [field, types[type]])),
    have_enough_information: Type.Boolean(),
  });
}

type Handoff = {
  steps: Static<typeof Step>[];
  store: Record<string, Var>;
  query: {
    as: string;
    output_schema: Record<string, Static<typeof FieldType>>;
    sources: readonly string[];
    readers: Readers;
  };
};
type ToolResult =
  | { tool: "send_email"; decision: "granted"; sent: Email }
  | {
      tool: "send_email"; decision: "denied"; reason: string; allowed_fixes: string[];
      arguments: { recipients: string[]; subject: string; body: string };
    };
type Outcome = { plan: Static<typeof Step>[]; results: ToolResult[] };

/** Runs trusted fixture reads and publishes one quarantined request plus a private executor handoff. */
export const Interpreter: syntax.DeterministicNode<CamelContext> = ({ context, edges, policy }) => {
  let published = false;
  return {
    state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
      const inputs = yield [];
      const { steps } = parseJson(syntax.finalText(inputs.values.get(graph.EdgeId.create("PLLM->Interpreter")), "PLLM"), Plan, "PLLM");
      const at = steps.findIndex((step) => step.tool === "query_ai_assistant");
      // shortcut: one quarantined query per plan, upgrade to a loop over QLLM when plans need several.
      if (at < 0 || steps.slice(at + 1).some((step) => step.tool === "query_ai_assistant"))
        throw new Error("plan must contain exactly one query_ai_assistant step");
      const store: Record<string, Var> = Object.create(null);
      for (const step of steps.slice(0, at)) {
        if (step.tool !== "get_last_email") throw new Error("only get_last_email may precede query_ai_assistant");
        store[step.as] = emailVar(getLastEmail(context.inbox));
      }
      const step = steps[at]!;
      if (step.tool !== "query_ai_assistant") throw new Error("expected query_ai_assistant");
      const query = resolve(step.query, store);
      const queryText = typeof query.value === "string" ? query.value : JSON.stringify(query.value);
      const text = `${queryText}\n\nOutput schema (one JSON object with exactly these fields): ${JSON.stringify({ ...step.output_schema, have_enough_information: "boolean" })}`;
      const handoff: Handoff = {
        steps: steps.slice(at + 1), store,
        query: { as: step.as, output_schema: step.output_schema, sources: query.sources, readers: query.readers },
      };
      published = true;
      const tasks = [
        Task.create({ kind: "prompt", text, spec: "The reply is one JSON object matching the output schema." }),
        Task.create({ kind: "prompt", text: JSON.stringify(handoff), spec: "The remaining plan steps are executed." }),
      ];
      while (true) yield [
        graph.Message.create(edges.get("Interpreter~>QLLM")!, tasks[0]),
        graph.Message.create(edges.get("Interpreter~>Executor")!, tasks[1]),
      ];
    }, policy),
    is_available: (_view, triggered) => triggered && !published,
  };
};

/** Validates the QLLM reply, propagates capabilities, and halts at the first denied send. */
export const Executor: syntax.DeterministicNode<CamelContext> = ({ context, policy }) => ({
  state: new graph.nodes.Deterministic<TSchema, unknown>(async function* () {
    const inputs = yield [];
    const handoffs = inputs.messages.get(graph.EdgeId.create("Interpreter~>Executor"));
    if (handoffs?.length !== 1 || !Value.Check(Type.Object({ kind: Type.Literal("prompt"), text: Type.String() }), handoffs[0]))
      throw new Error("Executor expects exactly one handoff");
    const handoff = JSON.parse(handoffs[0].text) as Handoff;
    const raw = syntax.finalText(inputs.values.get(graph.EdgeId.create("QLLM->Executor")), "QLLM");
    const parsed = parseJson(raw, outputSchemaOf(handoff.query.output_schema), "QLLM");
    if (!parsed.have_enough_information)
      throw new Error(`NotEnoughInformationError: the quarantined LLM could not extract ${handoff.query.as}`);
    const { have_enough_information: _, ...value } = parsed;
    const store: Record<string, Var> = Object.assign(Object.create(null), handoff.store);
    store[handoff.query.as] = {
      value, sources: dedupe(["query_ai_assistant", ...handoff.query.sources]), readers: handoff.query.readers,
    };
    const results: ToolResult[] = [];
    steps: for (const step of handoff.steps) {
      if (step.tool === "get_last_email") {
        store[step.as] = emailVar(getLastEmail(context.inbox));
        continue;
      }
      if (step.tool === "query_ai_assistant") throw new Error("plan must contain exactly one query_ai_assistant step");
      const recipients = step.recipients.map((recipient) => resolve(recipient, store));
      const addresses = recipients.map((recipient) => asString(recipient, "recipient"));
      const subject = resolve(step.subject, store), body = resolve(step.body, store);
      const subjectText = asString(subject, "subject"), bodyText = asString(body, "body");
      const facts: tools.NativeFlowEvent[] = [];
      for (const [name, variable] of [["body", body], ["subject", subject]] as const) {
        if (variable.readers === "public") facts.push({ principal: "interpreter", action: "Public", resource: name });
        else for (const reader of variable.readers) facts.push({ principal: reader, action: "Reader", resource: name });
      }
      if (recipients.every(isTrusted))
        for (const address of addresses) facts.push({ principal: address, action: "Trusted", resource: "recipients" });
      for (const resource of ["body", "subject"]) {
        for (const principal of addresses) {
          const decision = await tools.flowDecision(facts, { principal, action: "Send", resource });
          if (!decision.granted) {
            results.push({
              tool: "send_email", decision: "denied",
              reason: `Execution of tool 'send_email' denied: ${decision.failedPrecondition}`,
              allowed_fixes: decision.allowedFixes ?? [],
              arguments: { recipients: addresses, subject: subjectText, body: bodyText },
            });
            break steps;
          }
        }
      }
      results.push({ tool: "send_email", decision: "granted", sent: sendEmail(context, addresses, subjectText, bodyText) });
    }
    return { plan: handoff.steps, results } satisfies Outcome;
  }, policy),
});

const directory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = basename(dirname(directory)) === "dist" ? resolvePath(directory, "../../..") : resolvePath(directory, "../..");

// Verified 2026-11-02: refreshed Pi catalog, saved Copilot login, and medium thinking support.
// GitHub lists Claude Sonnet 5.5: https://docs.github.com/en/copilot/reference/ai-models/supported-models
const LADDER = schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5.5", thinking: "medium" });

async function main(signal: AbortSignal): Promise<void> {
  const query = process.argv[2] ?? BOB_QUERY;
  if (/[\r\n]/.test(query)) throw new Error("the query must be a single line");
  const context: CamelContext = { inbox: INBOX, sent: [] };
  let outcome: Outcome;
  {
    await using lifetime = new AsyncDisposableStack();
    signal.throwIfAborted();
    const models = await verifiedModels(LADDER.med, signal);
    const ladder = new schedules.ModelLadder(models, LADDER);
    signal.throwIfAborted();
    const recorder = lifetime.adopt(await problemRecorder(repositoryRoot), (owned) => owned.close());
    const observer = tracer.TuiTracer.shared();
    const execution = await JuncoGraph.fromYaml(source, {
      cwd: repositoryRoot, ladder, code: { Interpreter, Executor },
      // Avoid the default builder's ShellMux: neither LLM can use tools.
      createAgent: (spec) => syntax.createJuncoAgent(spec, ladder),
      scheduler: () => schedules.parallel(), recorder, context, params: { query }, signal,
      tracer: observer,
    });
    lifetime.defer(() => observer instanceof tracer.TuiTracer ? observer.finish() : undefined);
    lifetime.adopt(execution.graph, (owned) => owned.close());
    const results = await execution.run({ signal });
    outcome = results.get(execution.graph.sink.id) as Outcome;
  }
  signal.throwIfAborted();
  console.log(JSON.stringify(outcome, null, 2));
}

if (import.meta.main) await runCli(main);
