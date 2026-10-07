import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  EdgeId,
  type EdgeIdType,
  type Message,
  type NodeIdType,
  type ParentView,
} from "dataflow-engine";
import { iso, type Newtype } from "newtype-ts";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const recvParameters = Type.Object({}, { additionalProperties: false });
const sendParameters = Type.Object(
  { id: Type.String(), payload: Type.Unknown() },
  { additionalProperties: false },
);
const infoParameters = recvParameters;

/** A receiver's one-line description of the payload it accepts on one edge and what it does with it. */
export type Contract = { readonly expect: string };

/**
 * A carrier's `execute`, accepting unvalidated input as a model or caller supplies it: each tool
 * checks its schema before any effect. This keeps the nominal tools structurally assignable to
 * `AgentTool`, whose `execute` receives `unknown` parameters.
 */
type UncheckedExecute<A extends AgentTool<TSchema, unknown>> =
  A["execute"] extends (
    toolCallId: string,
    params: never,
    ...rest: infer R
  ) => infer O
    ? (toolCallId: string, params: unknown, ...rest: R) => O
    : never;

/** `recv`: drains the delivered messages and parent results retained for the current graph node. */
export interface RecvTool<N = unknown, T = unknown>
  extends Newtype<
    { readonly RecvTool: unique symbol },
    AgentTool<
      typeof recvParameters,
      {
        readonly messages: readonly Message<N>[];
        readonly values: readonly Message<T>[];
      }
    >
  > {
  readonly name: "recv";
  readonly label: "recv";
  readonly description: string;
  readonly parameters: typeof recvParameters;
  readonly executionMode: "sequential";
  execute: UncheckedExecute<RecvTool<N, T>["_A"]>;
}

/** `send`: admits one message on an existing outgoing message edge of the current graph node. */
export interface SendTool
  extends Newtype<
    { readonly SendTool: unique symbol },
    AgentTool<typeof sendParameters, undefined>
  > {
  readonly name: "send";
  readonly label: "send";
  readonly description: string;
  readonly parameters: typeof sendParameters;
  readonly executionMode: "sequential";
  execute: UncheckedExecute<SendTool["_A"]>;
}

type InfoToolStruct = AgentTool<
  typeof infoParameters,
  Readonly<
    Record<
      "parents" | "children",
      readonly (Contract & {
        readonly id: NodeIdType;
        readonly edgeId: EdgeIdType;
        readonly kind: "message" | "value";
      })[]
    >
  >
>;

/** `info`: the current graph node's parent and child routes with their receivers' contracts. */
export interface InfoTool
  extends InfoToolStruct,
    Newtype<{ readonly InfoTool: unique symbol }, InfoToolStruct> {
  execute: UncheckedExecute<InfoToolStruct>;
}

/** Carriers each constructor built. Only these are graph primitives; a copied or cast object is not. */
const recvTools = new WeakSet<object>();
const sendTools = new WeakSet<object>();
const infoTools = new WeakSet<object>();

function check<S extends TSchema>(
  tool: string,
  schema: S,
  input: unknown,
): Static<S> {
  if (Value.Check(schema, input)) return input;
  const [error] = Value.Errors(schema, input);
  throw new Error(
    `Invalid ${tool} input${error ? `: ${error.instancePath} ${error.message}` : ""}`,
  );
}

async function receive<N, T>(
  host: NonNullable<Parameters<typeof RecvTool<N, T>>[0]> | undefined,
  input: unknown,
  signal: AbortSignal | undefined,
): ReturnType<RecvTool<N, T>["execute"]> {
  check("recv", recvParameters, input);
  signal?.throwIfAborted();
  if (host === undefined)
    throw new Error("recv requires an agentNode graph host");
  const { view } = host;
  const messages: Message<N>[] = [];
  for (const id of view.messages.keys())
    for (const payload of view.messages.get(id) ?? [])
      messages.push({ id, payload });
  const values: Message<T>[] = [];
  for (const id of view.values.keys())
    values.push({ id, payload: view.values.get(id) as T });
  const details = { messages, values };
  // Render before consuming: a payload JSON cannot express, or a cancellation, leaves the inbox intact.
  const text = JSON.stringify(details);
  signal?.throwIfAborted();
  host.consume();
  return { content: [{ type: "text", text }], details };
}

async function emit<N>(
  host: NonNullable<Parameters<typeof SendTool<N>>[0]> | undefined,
  input: unknown,
  signal: AbortSignal | undefined,
): ReturnType<SendTool["execute"]> {
  const { id, payload } = check("send", sendParameters, input);
  signal?.throwIfAborted();
  if (host === undefined)
    throw new Error("send requires an agentNode graph host");
  host.send({ id: EdgeId(id), payload: payload as N });
  return {
    content: [{ type: "text", text: "Message sent." }],
    details: undefined,
  };
}

async function describe(
  host: NonNullable<Parameters<typeof InfoTool>[0]> | undefined,
  input: unknown,
  signal: AbortSignal | undefined,
): ReturnType<InfoTool["execute"]> {
  check("info", infoParameters, input);
  signal?.throwIfAborted();
  if (host === undefined)
    throw new Error("info requires an agentNode graph host");
  const details = host.info();
  signal?.throwIfAborted();
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

/**
 * A fresh `recv` tool reading `host`, or the host a `JuncoAgent` binds to its graph activation;
 * without either it fails rather than pretend the inbox is empty.
 */
export function RecvTool<N = unknown, T = unknown>(host?: {
  readonly view: ParentView<N, T>;
  consume(): void;
}): RecvTool<N, T> {
  const tool: RecvTool<N, T>["_A"] = {
    name: "recv",
    label: "recv",
    description: "Consumes messages from ParentView of agent",
    parameters: recvParameters,
    executionMode: "sequential",
    execute: (_toolCallId, input, signal) => receive(host, input, signal),
  };
  recvTools.add(tool);
  return iso<RecvTool<N, T>>().wrap(tool);
}

export namespace RecvTool {
  /** Whether {@link RecvTool} built `tool`; a copied or same-named object is not a recv tool. */
  export function is(tool: object): tool is RecvTool {
    return recvTools.has(tool);
  }

  /** Executes a genuine recv tool against `host`, ignoring any host it was built with. */
  export async function invoke<N, T>(
    tool: RecvTool,
    host: NonNullable<Parameters<typeof RecvTool<N, T>>[0]>,
    _toolCallId: string,
    input: Static<typeof recvParameters>,
    signal: AbortSignal,
  ): ReturnType<RecvTool<N, T>["execute"]> {
    if (!is(tool))
      throw new TypeError("Not a recv tool constructed by RecvTool");
    return receive(host, input, signal);
  }
}

/**
 * A fresh `send` tool admitting through `host`, or the host a `JuncoAgent` binds to its graph
 * activation; without either it fails rather than drop the message.
 */
export function SendTool<N = unknown>(host?: {
  send(message: Message<N>): void;
}): SendTool {
  const tool: SendTool["_A"] = {
    name: "send",
    label: "send",
    description:
      "Sends a message to downstream node along an existing graph edge",
    parameters: sendParameters,
    executionMode: "sequential",
    execute: (_toolCallId, input, signal) => emit(host, input, signal),
  };
  sendTools.add(tool);
  return iso<SendTool>().wrap(tool);
}

export namespace SendTool {
  /** Whether {@link SendTool} built `tool`; a copied or same-named object is not a send tool. */
  export function is(tool: object): tool is SendTool {
    return sendTools.has(tool);
  }

  /** Executes a genuine send tool through `host`, ignoring any host it was built with. */
  export async function invoke<N>(
    tool: SendTool,
    host: NonNullable<Parameters<typeof SendTool<N>>[0]>,
    _toolCallId: string,
    input: Static<typeof sendParameters>,
    signal: AbortSignal,
  ): ReturnType<SendTool["execute"]> {
    if (!is(tool))
      throw new TypeError("Not a send tool constructed by SendTool");
    return emit(host, input, signal);
  }
}

/**
 * A fresh `info` tool describing `host`'s node, or the node a `JuncoAgent` binds to its graph
 * activation; without either it fails rather than report an empty topology.
 */
export function InfoTool(host?: {
  info(): Awaited<ReturnType<InfoTool["execute"]>>["details"];
}): InfoTool {
  const tool: InfoToolStruct = {
    name: "info",
    label: "info",
    description:
      "Shows parent and child nodes, edge routes, and receiver expectations for the current " +
      "graph node. Send only on message edges; value edges carry final results.",
    parameters: infoParameters,
    executionMode: "sequential",
    execute: (_toolCallId, input, signal) => describe(host, input, signal),
  };
  infoTools.add(tool);
  return iso<InfoTool>().wrap(tool);
}

export namespace InfoTool {
  /** Whether {@link InfoTool} built `tool`; a copied or same-named object is not an info tool. */
  export function is(tool: object): tool is InfoTool {
    return infoTools.has(tool);
  }

  /** Executes a genuine info tool through `host`, ignoring any host it was built with. */
  export async function invoke(
    tool: InfoTool,
    host: NonNullable<Parameters<typeof InfoTool>[0]>,
    _toolCallId: string,
    input: Static<typeof infoParameters>,
    signal: AbortSignal,
  ): ReturnType<InfoTool["execute"]> {
    if (!is(tool))
      throw new TypeError("Not an info tool constructed by InfoTool");
    return describe(host, input, signal);
  }
}
