import { resolve } from "node:path";
import type { ModelId, ModelProvider } from "model-auth";
import {
  AgentHarness,
  InMemorySessionRepo,
  NodeExecutionEnv,
  type AgentTool,
  type ThinkingLevel,
  type ToolCallResult,
} from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JuncoAbort, JuncoControl, JuncoResult } from "./events.js";

export interface JuncoAgentOptions {
  readonly provider: ModelProvider;
  readonly model: ModelId;
  readonly systemPrompt: string;
  readonly prompt: string;
  /** Working directory for the harness and default tools; defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly thinkingLevel?: ThinkingLevel;
  /** Replaces the default junco-tools collection; `[]` disables tools. */
  readonly tools?: AgentTool[];
}

export type JuncoAgent = AsyncGenerator<
  string,
  JuncoResult,
  readonly JuncoControl[] | undefined
>;

type Turn =
  | { readonly type: "block"; readonly text: string; readonly isAnswer: boolean }
  | { readonly type: "tool"; readonly toolName: string };

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Run one prompt through a fresh in-memory Pi `AgentHarness`.
 *
 * Starts on the first `next()`. Yields each completed thinking/text block and a
 * `[tool:<name>]` marker before every tool call; the gated tool runs only after the
 * consumer resumes. Each resume may carry controls, delivered in order before the run
 * continues. Returns the concatenated answer text.
 */
export async function* JuncoAgent(options: JuncoAgentOptions): JuncoAgent {
  if (options.systemPrompt.length === 0) {
    throw new Error("JuncoAgent: systemPrompt must be non-empty");
  }
  const prompt = options.prompt.trim();
  if (prompt.length === 0) {
    throw { code: "protocol", message: "JuncoAgent: prompt is empty" } satisfies JuncoAbort;
  }
  const cwd = resolve(options.cwd ?? process.cwd());

  let harness: AgentHarness;
  try {
    const { models, model } = await options.provider.resolveModel(options.model);
    const session = await new InMemorySessionRepo().create();
    let tools = options.tools;
    if (tools === undefined) {
      // Dynamic by design: explicit tools (including `[]`) never load junco-tools, its
      // native addon, or its Pi coding-agent graph. One collection per generator, so
      // read/grep/edit share that collection's EditStore snapshots.
      const { ToolCollection } = await import("junco-tools");
      tools = (await ToolCollection.create(cwd)).tools;
    }
    harness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd }),
      session,
      models,
      model,
      systemPrompt: options.systemPrompt,
      tools,
      thinkingLevel: options.thinkingLevel ?? "off",
    });
  } catch (cause) {
    throw {
      code: "invariant",
      message: `JuncoAgent: initialization failed: ${causeMessage(cause)}`,
    } satisfies JuncoAbort;
  }

  const channel: Turn[] = [];
  let notify: (() => void) | undefined;
  let settled = false;
  let answer = "";
  let failure: string | undefined;
  let finalMessage: AssistantMessage | undefined;
  // Pi prepares tool calls serially, so at most one gate is pending.
  let pendingTool: ((result: ToolCallResult) => void) | undefined;

  const wake = (): void => {
    const current = notify;
    notify = undefined;
    current?.();
  };
  const push = (turn: Turn): void => {
    channel.push(turn);
    wake();
  };
  const settle = (): void => {
    settled = true;
    wake();
  };
  const releasePendingTool = (): void => {
    const release = pendingTool;
    pendingTool = undefined;
    release?.({});
  };
  const applyControls = async (controls: readonly JuncoControl[] | undefined): Promise<void> => {
    for (const control of controls ?? []) {
      try {
        if (control.kind === "steer") await harness.steer(control.msg);
        else if (control.kind === "followUp") await harness.followUp(control.msg);
      } catch {
        // The prompt settled between scheduling and delivery; drop the stale control.
      }
    }
  };

  const unsubscribe = harness.subscribe((event) => {
    if (event.type !== "message_update") return;
    const update = event.assistantMessageEvent;
    if (update.type === "thinking_end") {
      push({ type: "block", text: update.content, isAnswer: false });
    } else if (update.type === "text_end") {
      push({ type: "block", text: update.content, isAnswer: true });
    }
  });
  const offToolCall = harness.on(
    "tool_call",
    (event) =>
      new Promise<ToolCallResult>((release) => {
        pendingTool = release;
        push({ type: "tool", toolName: event.toolName });
      }),
  );

  void harness.prompt(prompt).then(
    (message) => {
      finalMessage = message;
      settle();
    },
    (cause) => {
      failure = causeMessage(cause);
      settle();
    },
  );

  try {
    try {
      while (true) {
        const turn = channel.shift();
        if (turn !== undefined) {
          if (turn.type === "tool") {
            const controls = yield `[tool:${turn.toolName}]`;
            // Queue controls before opening the gate so the next model turn cannot outrun them.
            await applyControls(controls);
            releasePendingTool();
            continue;
          }

          if (turn.isAnswer) answer += turn.text;
          await applyControls(yield turn.text);
          continue;
        }

        if (settled) {
          if (failure !== undefined) {
            const message = failure;
            return {
              text: `prompt failed: ${message}`,
              details: { failed: true, message },
            };
          }

          if (
            finalMessage !== undefined &&
            (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted")
          ) {
            const message = finalMessage.errorMessage ?? `prompt ${finalMessage.stopReason}`;
            return {
              text: `prompt failed: ${message}`,
              details: { failed: true, message },
            };
          }

          if (answer.length === 0 && finalMessage !== undefined) {
            for (const block of finalMessage.content) {
              if (block.type === "text") answer += block.text;
            }
          }
          return { text: answer.trim(), details: { failed: false } };
        }

        await new Promise<void>((ready) => {
          notify = ready;
        });
      }
    } finally {
      if (!settled) {
        // Consumer return()/throw() while the prompt runs. abort() flips the run signal
        // synchronously; releasing the gate afterwards lets Pi's post-gate abort check skip
        // the tool, and awaiting abort before releasing would wait on that gate forever.
        const aborting = harness.abort();
        releasePendingTool();
        await aborting;
      }
    }
  } finally {
    releasePendingTool();
    unsubscribe();
    offToolCall();
  }
}
