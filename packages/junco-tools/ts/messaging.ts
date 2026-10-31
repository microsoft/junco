import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
  EdgeId,
  type EdgeIdType,
  type Message,
  messagesOf,
  type NodeIdType,
  type ParentView,
} from "dataflow-engine";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  captureRecorder,
  markProfileOwned,
  type ProfileRecorder,
  profileToolCall,
} from "./profile-recorder.js";
import { checkToolInput, checkToolOutput } from "./tool-support.js";

/** The recorder a carrier was built with: a view, or a getter resolved per call. */
type Recorder =
  | ProfileRecorder<"operations">
  | (() => ProfileRecorder<"operations"> | undefined);

const operationOf = (tool: "recv" | "send" | "info") =>
  ({
    resource: "operations",
    category: tool,
    tool,
    operation: "execute",
  }) as const;
const recvOperation = operationOf("recv");
const sendOperation = operationOf("send");
const infoOperation = operationOf("info");

const recvParameters = Type.Object({}, { additionalProperties: false });
const infoParameters = recvParameters;

/** One route a messaging schema covers: its edge and that edge's stored payload schema. */
type Route = readonly [EdgeIdType, TSchema];

/** `{id, payload}` correlated to `route`; `payload` may be absent only if its schema admits `undefined`. */
function routeItem([id, schema]: Route, omittable: boolean): TSchema {
  return Type.Object(
    {
      id: Type.Literal(id),
      payload:
        omittable && Value.Check(schema, undefined)
          ? Type.Optional(schema)
          : schema,
    },
    { additionalProperties: false },
  );
}

/** recv's JSON items over `routes`; with none, only `[]`. */
const routeItems = (routes: readonly Route[]): TSchema =>
  Type.Array(
    routes.length === 0
      ? Type.Never()
      : Type.Union(routes.map((route) => routeItem(route, true))),
  );

/** A recv output shape no host announced: an empty inbox. */
const emptyInbox = Type.Object(
  { messages: routeItems([]), values: routeItems([]) },
  { additionalProperties: false },
);

/** A send parameter shape admitting no call: there is no outgoing message route. */
const noRoutes = Type.Object(
  { id: Type.Never(), payload: Type.Never() },
  { additionalProperties: false },
);

/** What a {@link SendTool} sends through: its outgoing routes' parameter schema and admission. */
export type SendToolHost<N extends TSchema> = {
  readonly sendParameters: TSchema;
  send(message: Message<N>): void;
};

/** What a {@link RecvTool} drains: the retained inbox, its JSON output schema, and consumption. */
export type RecvToolHost<N extends TSchema, T> = {
  readonly view: ParentView<N, T>;
  readonly recvOutputSchema: TSchema;
  consume(): void;
};

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

type RecvToolStruct<N extends TSchema, T> = AgentTool<
  typeof recvParameters,
  {
    readonly messages: readonly Message<N>[];
    readonly values: readonly {
      readonly id: EdgeIdType;
      readonly payload: T;
    }[];
  }
>;

type SendToolStruct = AgentTool<TSchema, undefined>;

type InfoToolStruct = AgentTool<
  typeof infoParameters,
  Readonly<
    Record<
      "parents" | "children",
      readonly {
        readonly id: NodeIdType;
        readonly edgeId: EdgeIdType;
        readonly kind: "message" | "value";
      }[]
    >
  >
>;

/** A carrier's construction-time binding. */
type Binding<H> = {
  readonly host: H | undefined;
  readonly recorder: Recorder | undefined;
};

/**
 * Carriers each constructor built, with their hosts and recorders. Only these are graph
 * primitives; a copied or cast object is not.
 */
const recvTools = new WeakMap<
  object,
  Binding<Pick<RecvToolHost<never, never>, "recvOutputSchema">>
>();
const sendTools = new WeakMap<
  object,
  Binding<Pick<SendToolHost<never>, "sendParameters">>
>();
const infoTools = new WeakMap<object, Recorder | undefined>();

async function receive<N extends TSchema, T>(
  host: RecvToolHost<N, T> | undefined,
  input: unknown,
  signal: AbortSignal | undefined,
  recorder: Recorder | undefined,
): ReturnType<RecvTool<N, T>["execute"]> {
  return profileToolCall(
    captureRecorder(recorder),
    recvOperation,
    signal,
    async () => {
      checkToolInput("recv", recvParameters, input);
      signal?.throwIfAborted();
      if (host === undefined)
        throw new Error("recv requires a JuncoGraph host");
      const { view } = host;
      const messages = messagesOf(view);
      const values: { readonly id: EdgeIdType; readonly payload: T }[] = [];
      for (const id of view.values.keys())
        values.push({ id, payload: view.values.get(id) as T });
      const details = { messages, values };
      // Render and check before consuming: a payload JSON cannot express, one off its route's
      // schema, or a cancellation leaves the inbox intact.
      const text = JSON.stringify(details);
      const structuredContent: JsonValue = JSON.parse(text);
      checkToolOutput("recv", host.recvOutputSchema, structuredContent);
      signal?.throwIfAborted();
      host.consume();
      return { content: [{ type: "text", text }], details, structuredContent };
    },
    ({ details }) => ({
      counters: {
        messages_received: details.messages.length,
        values_received: details.values.length,
      },
    }),
  );
}

async function emit<N extends TSchema>(
  host: SendToolHost<N> | undefined,
  input: unknown,
  signal: AbortSignal | undefined,
  recorder: Recorder | undefined,
): ReturnType<SendTool["execute"]> {
  return profileToolCall(
    captureRecorder(recorder),
    sendOperation,
    signal,
    async () => {
      if (host === undefined)
        throw new Error("send requires a JuncoGraph host");
      checkToolInput("send", host.sendParameters, input);
      // `sendParameters` is the host's projection of its routes, so a passing input has their shape.
      const { id, payload } = input as { id: string; payload: Static<N> };
      signal?.throwIfAborted();
      host.send({ id: EdgeId.create(id), payload });
      return {
        content: [{ type: "text", text: "Message sent." }],
        details: undefined,
      };
    },
    // Resolving means `host.send` accepted the message into the outgoing queue.
    () => ({ counters: { messages_sent: 1 } }),
  );
}

async function describe(
  host: NonNullable<ConstructorParameters<typeof InfoTool>[0]> | undefined,
  input: unknown,
  signal: AbortSignal | undefined,
  recorder: Recorder | undefined,
): ReturnType<InfoTool["execute"]> {
  return profileToolCall(
    captureRecorder(recorder),
    infoOperation,
    signal,
    async () => {
      checkToolInput("info", infoParameters, input);
      signal?.throwIfAborted();
      if (host === undefined)
        throw new Error("info requires a JuncoGraph host");
      const details = host.info();
      signal?.throwIfAborted();
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
    ({ details: { parents, children } }) => {
      let messageRoutes = 0;
      for (const route of parents)
        if (route.kind === "message") messageRoutes++;
      for (const route of children)
        if (route.kind === "message") messageRoutes++;
      return {
        counters: {
          parents: parents.length,
          children: children.length,
          message_routes: messageRoutes,
          value_routes: parents.length + children.length - messageRoutes,
        },
      };
    },
  );
}

/**
 * `recv`: drains the delivered messages and parent results retained for the current graph node,
 * reading `host`, or the host a `JuncoAgent` binds to its graph activation; without either it
 * fails rather than pretend the inbox is empty.
 */
export class RecvTool<N extends TSchema = never, T = never> {
  declare private readonly brand: "RecvTool";
  readonly name = "recv";
  readonly label = "recv";
  readonly parameters = recvParameters;
  readonly executionMode = "sequential";
  execute: UncheckedExecute<RecvToolStruct<N, T>>;

  constructor(host?: RecvToolHost<N, T>, recorder?: Recorder) {
    this.execute = (_toolCallId, input, signal) =>
      receive(host, input, signal, recorder);
    recvTools.set(this, { host, recorder });
    markProfileOwned(this, () => recvOperation);
  }

  /** The JSON this tool returns as `structuredContent`: its host's, else an empty inbox's. */
  get outputSchema(): TSchema {
    return recvTools.get(this)?.host?.recvOutputSchema ?? emptyInbox;
  }

  /** The model-visible contract: what recv does, and {@link outputSchema}. */
  get description(): string {
    return RecvTool.describe(this.outputSchema);
  }

  /** recv's description advertising `schema`, since providers do not transport output schemas. */
  static describe(schema: TSchema): string {
    return `Consumes messages and parent values retained for the current graph node. Returns JSON matching: ${JSON.stringify(schema)}`;
  }

  /**
   * recv's output over the inbound `messages` and `values` routes: a strict `{messages, values}`
   * whose items correlate each edge ID with that edge's schema, embedded unchanged.
   */
  static outputSchemaFor(
    messages: readonly Route[],
    values: readonly Route[],
  ): TSchema {
    return Type.Object(
      { messages: routeItems(messages), values: routeItems(values) },
      { additionalProperties: false },
    );
  }

  /** Whether {@link RecvTool} built `tool`; a copied or same-named object is not a recv tool. */
  static is(tool: object): tool is RecvTool<TSchema, unknown> {
    return recvTools.has(tool);
  }

  /** Executes a genuine recv tool against `host`, ignoring any host it was built with. */
  static async invoke<N extends TSchema, T>(
    tool: RecvTool<TSchema, unknown>,
    host: RecvToolHost<N, T>,
    _toolCallId: string,
    input: Static<typeof recvParameters>,
    signal: AbortSignal,
  ): ReturnType<RecvTool<N, T>["execute"]> {
    if (!RecvTool.is(tool))
      throw new TypeError("Not a recv tool constructed by RecvTool");
    return receive(host, input, signal, recvTools.get(tool)?.recorder);
  }
}

/**
 * `send`: admits one message on an existing outgoing message edge of the current graph node,
 * through `host`, or the host a `JuncoAgent` binds to its graph activation; without either it
 * fails rather than drop the message.
 */
export class SendTool<N extends TSchema = never> {
  declare private readonly brand: "SendTool";
  readonly name = "send";
  readonly label = "send";
  readonly description: string =
    "Sends a message to downstream node along an existing graph edge";
  readonly executionMode = "sequential";
  execute: UncheckedExecute<SendToolStruct>;

  constructor(host?: SendToolHost<N>, recorder?: Recorder) {
    this.execute = (_toolCallId, input, signal) =>
      emit(host, input, signal, recorder);
    sendTools.set(this, { host, recorder });
    markProfileOwned(this, () => sendOperation);
  }

  /** The `{id, payload}` calls this tool admits: its host's, else none. */
  get parameters(): TSchema {
    return sendTools.get(this)?.host?.sendParameters ?? noRoutes;
  }

  /**
   * send's parameters over the outgoing message `routes`: a strict `{id, payload}` object whose
   * `anyOf` branches correlate each edge ID with that edge's schema, embedded unchanged. With no
   * route, no call is admitted. Root property domains stay visible when a provider drops root
   * combinators.
   */
  static parametersFor(routes: readonly Route[]): TSchema {
    if (routes.length === 0) return noRoutes;
    return Type.Object(
      {
        id: Type.Union(routes.map(([id]) => Type.Literal(id))),
        payload: Type.Union(routes.map(([, schema]) => schema)),
      },
      {
        additionalProperties: false,
        anyOf: routes.map(([id, schema]) =>
          Type.Object({ id: Type.Literal(id), payload: schema }),
        ),
      },
    );
  }

  /** Whether {@link SendTool} built `tool`; a copied or same-named object is not a send tool. */
  static is(tool: object): tool is SendTool<TSchema> {
    return sendTools.has(tool);
  }

  /** Executes a genuine send tool through `host`, ignoring any host it was built with. */
  static async invoke<N extends TSchema>(
    tool: SendTool<TSchema>,
    host: SendToolHost<N>,
    _toolCallId: string,
    input: { readonly id: string; readonly payload: NoInfer<Static<N>> },
    signal: AbortSignal,
  ): ReturnType<SendTool["execute"]> {
    if (!SendTool.is(tool))
      throw new TypeError("Not a send tool constructed by SendTool");
    return emit(host, input, signal, sendTools.get(tool)?.recorder);
  }
}

/**
 * `info`: the current graph node's parent and child routes,
 * describing `host`'s node, or the node a `JuncoAgent` binds to its graph activation; without
 * either it fails rather than report an empty topology.
 */
export class InfoTool {
  declare private readonly brand: "InfoTool";
  readonly name = "info";
  readonly label = "info";
  readonly description: string =
    "Shows parent and child nodes and edge routes for the current graph node. Send only on message edges; value edges carry final results.";
  readonly parameters = infoParameters;
  readonly executionMode = "sequential";
  execute: UncheckedExecute<InfoToolStruct>;

  constructor(
    host?: {
      info(): Awaited<ReturnType<InfoTool["execute"]>>["details"];
    },
    recorder?: Recorder,
  ) {
    this.execute = (_toolCallId, input, signal) =>
      describe(host, input, signal, recorder);
    infoTools.set(this, recorder);
    markProfileOwned(this, () => infoOperation);
  }

  /** Whether {@link InfoTool} built `tool`; a copied or same-named object is not an info tool. */
  static is(tool: object): tool is InfoTool {
    return infoTools.has(tool);
  }

  /** Executes a genuine info tool through `host`, ignoring any host it was built with. */
  static async invoke(
    tool: InfoTool,
    host: NonNullable<ConstructorParameters<typeof InfoTool>[0]>,
    _toolCallId: string,
    input: Static<typeof infoParameters>,
    signal: AbortSignal,
  ): ReturnType<InfoTool["execute"]> {
    if (!InfoTool.is(tool))
      throw new TypeError("Not an info tool constructed by InfoTool");
    return describe(host, input, signal, infoTools.get(tool));
  }
}
