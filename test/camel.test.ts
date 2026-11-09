import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AgentTool,
  PromptTemplate,
  Skill,
} from "@earendil-works/pi-agent-core";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { graph, JuncoGraph, MockAgent, schedules, tracer } from "junco";
import type { TSchema } from "typebox";
import {
  BOB_QUERY,
  type CamelContext,
  Executor,
  INBOX,
  Interpreter,
  USER,
} from "../examples/camel/camel.ts";
import { assistant, run, settle } from "./deterministic-support.ts";

type YamlMock = MockAgent<Skill, PromptTemplate, AgentTool, TSchema, unknown>;
const cwd = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(
  new URL("../examples/camel/camel.yml", import.meta.url),
  "utf8",
);
const reads = [
  { tool: "get_last_email", as: "email" },
  {
    tool: "query_ai_assistant",
    query: "Find Bob's email address in {email}",
    output_schema: { address: "string" },
    as: "bob",
  },
];
const reminderPlan = assistant(
  `\`\`\`json\n${JSON.stringify({
    steps: [
      ...reads,
      {
        tool: "send_email",
        recipients: ["{bob.address}"],
        subject: "Meeting tomorrow",
        body: "Remember our meeting tomorrow",
      },
    ],
  })}\n\`\`\``,
);
const forwardPlan = assistant(
  JSON.stringify({
    steps: [
      ...reads,
      {
        tool: "send_email",
        recipients: ["{bob.address}"],
        subject: "Fwd: {email.subject}",
        body: "{email.body}",
      },
    ],
  }),
);
const bobReply = assistant(
  '{"address":"bob.wilson@example.com","have_enough_information":true}',
);

async function build(plan: AssistantMessage, reply = bobReply) {
  const context: CamelContext = { inbox: INBOX, sent: [] };
  const mocks = new Map<string, YamlMock>();
  const execution = await JuncoGraph.fromYaml(source, {
    cwd,
    scheduler: () => schedules.parallel(),
    tracer: new tracer.DummyTracer(),
    code: { Interpreter, Executor },
    context,
    params: { query: BOB_QUERY },
    createAgent: async (spec) => {
      const mock: YamlMock = new MockAgent({
        runs: [
          run([
            settle(spec.node === "PLLM" ? plan : reply, { drain: ["steer"] }),
          ]),
        ],
      });
      mocks.set(spec.node, mock);
      return mock;
    },
  });
  return { execution, context, mocks };
}

test("reminder to Bob is granted and sent", async () => {
  const { execution, context, mocks } = await build(reminderPlan);
  try {
    const results = await execution.run();
    const outcome = results.get(execution.graph.sink.id) as {
      results: unknown[];
    };
    assert.equal(context.sent.length, 1);
    const sent = context.sent[0]!;
    assert.deepEqual(outcome.results, [
      { tool: "send_email", decision: "granted", sent },
    ]);
    assert.deepEqual(
      {
        recipients: sent.recipients,
        subject: sent.subject,
        body: sent.body,
        sender: sent.sender,
      },
      {
        recipients: ["bob.wilson@example.com"],
        subject: "Meeting tomorrow",
        body: "Remember our meeting tomorrow",
        sender: USER,
      },
    );
    const request = mocks.get("QLLM")!.requests.at(-1)!.messages.at(-1)!;
    assert.equal(request.role, "user");
    if (request.role !== "user")
      throw new Error("expected quarantined user request");
    assert.ok(contentText(request.content).includes("bob.wilson@example.com"));
    assert.ok(contentText(request.content).includes("have_enough_information"));
    for (const request of mocks.get("PLLM")!.requests)
      for (const message of request.messages)
        assert.ok(!JSON.stringify(message).includes("bob.wilson@example.com"));
  } finally {
    await execution.graph.close();
  }
});

test("forwarding the email body to the extracted address is denied", async () => {
  const { execution, context } = await build(forwardPlan);
  try {
    const results = await execution.run();
    const outcome = results.get(execution.graph.sink.id) as {
      results: unknown[];
    };
    assert.deepEqual(outcome.results, [
      {
        tool: "send_email",
        decision: "denied",
        reason:
          "Execution of tool 'send_email' denied: body is not public or shared with bob.wilson@example.com",
        allowed_fixes: ["bob.wilson@example.com reader body"],
        arguments: {
          recipients: ["bob.wilson@example.com"],
          subject: "Fwd: Bob's contact",
          body: INBOX[1]!.body,
        },
      },
    ]);
    assert.equal(context.sent.length, 0);
  } finally {
    await execution.graph.close();
  }
});

test("a quarantined answer without enough information fails the run", async () => {
  const { execution, context } = await build(
    reminderPlan,
    assistant('{"address":"","have_enough_information":false}'),
  );
  try {
    await assert.rejects(
      execution.run(),
      (error: unknown) =>
        error instanceof graph.DataflowNodeError &&
        error.nodeId === graph.NodeId.create("Executor") &&
        error.error instanceof Error &&
        error.error.message ===
          "NotEnoughInformationError: the quarantined LLM could not extract bob",
    );
    assert.equal(context.sent.length, 0);
  } finally {
    await execution.graph.close();
  }
});
