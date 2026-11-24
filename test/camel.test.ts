import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  fauxAssistantMessage as assistant,
  type Context,
  contentText,
} from "@earendil-works/pi-ai";
import { agent, graph, JuncoGraph, schedules, tools, tracer } from "junco";
import {
  BOB_QUERY,
  type CamelContext,
  Executor,
  INBOX,
  Interpreter,
  USER,
} from "../examples/camel/camel.ts";
import { userTexts } from "./deterministic-support.ts";
import { copyTreeNative, offlineLadder } from "./support.ts";

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
  const requests: Record<"PLLM" | "QLLM", Context[]> = { PLLM: [], QLLM: [] };
  const ladder = await offlineLadder((context) => {
    const [prompt] = userTexts(context.messages);
    if (prompt?.startsWith("Write the plan")) {
      requests.PLLM.push(context);
      return plan;
    }
    assert.ok(prompt?.startsWith("Parse the untrusted data"));
    requests.QLLM.push(context);
    return reply;
  });
  await using setup = new AsyncDisposableStack();
  const cwd = setup.adopt(await mkdtemp(join(tmpdir(), "camel-")), (p) =>
    rm(p, { recursive: true, force: true }),
  );
  const collection = setup.adopt(
    await tools.ToolCollection.create(cwd, {
      native: await copyTreeNative(),
      sandbox: "always",
    }),
    (c) => c.close(),
  );
  const execution = await JuncoGraph.fromYaml(source, {
    args: {
      cwd,
      collection,
      tracer: new tracer.DummyTracer(),
      code: { Interpreter, Executor },
      context,
      params: { query: BOB_QUERY },
    },
    parameters: { scheduler: () => schedules.parallel(), ladder },
  });
  setup.defer(() => execution.graph.close());
  for (const id of ["PLLM", "QLLM"]) {
    const member = execution.graph.getNode(graph.NodeId.create(id))!.state;
    assert.ok(member instanceof agent.JuncoAgent);
    assert.deepEqual(member.getTools(), [], `${id} must not receive any tool`);
  }
  const owned = setup.move();
  return { execution, context, requests, close: () => owned.disposeAsync() };
}

test("reminder to Bob is granted and sent", async () => {
  const { execution, context, requests, close } = await build(reminderPlan);
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
    const request = requests.QLLM.at(-1)!.messages.at(-1)!;
    assert.equal(request.role, "user");
    if (request.role !== "user")
      throw new Error("expected quarantined user request");
    assert.ok(contentText(request.content).includes("bob.wilson@example.com"));
    assert.ok(contentText(request.content).includes("have_enough_information"));
    assert.equal(requests.PLLM.length, 1);
    assert.equal(requests.QLLM.length, 1);
    const plannerInput = requests.PLLM[0]!.messages.at(-1)!;
    assert.ok(
      plannerInput.role === "user" &&
        contentText(plannerInput.content).startsWith(`${BOB_QUERY}\n\nTask: `),
    );
    for (const request of requests.PLLM)
      for (const message of request.messages)
        assert.ok(!JSON.stringify(message).includes("bob.wilson@example.com"));
  } finally {
    await close();
  }
});

test("forwarding the email body to the extracted address is denied", async () => {
  const { execution, context, close } = await build(forwardPlan);
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
    await close();
  }
});

test("a quarantined answer without enough information fails the run", async () => {
  const { execution, context, close } = await build(
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
    await close();
  }
});
