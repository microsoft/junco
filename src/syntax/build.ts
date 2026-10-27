import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type AgentTool,
  formatSkillsForSystemPrompt,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import {
  loadSkillsFromDir,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import * as graph from "dataflow-engine";
import { type ProfilesFile, profilesOf, unitOf } from "dataflow-profile";
import * as O from "fp-ts/lib/Option.js";
import * as agent from "junco-agent";
import * as mcp from "junco-mcp";
import {
  DEFAULT_MODEL_STRENGTH,
  type Scheduler,
  type SchedulerContext,
} from "junco-scheduler";
import * as tools from "junco-tools";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { Agentic } from "../agentic.js";
import { Deterministic } from "../deterministic.js";
import { JuncoGraph } from "../junco-graph.js";
import type { MockAgent } from "../mock-agent.js";
import {
  type AgencyNodeMetadata,
  context,
  type Ladder,
  type NodePolicy,
  nodePolicies,
  resolveRung,
  validateLadder,
} from "../node-policy.js";
import type * as tracer from "../std/tracer.js";
import {
  edgeId,
  inboundEdges,
  outboundEdges,
  type ParseOptions,
  PLACEHOLDER,
  quantityOf,
  resolveTrigger,
} from "./parse.js";
import {
  BUILTIN_TOOL_NAMES,
  type GraphSpec,
  type JuncoDocument,
  type NodeSpec,
} from "./schema.js";

/** YAML schemas are loaded at runtime: their payload/result domains are only known dynamically. */
type Edge = graph.Edge<TSchema, unknown>;
type Execution = SchedulerContext<
  Agentic<TSchema, unknown>,
  TSchema,
  unknown,
  AgencyNodeMetadata,
  JuncoGraph<TSchema, unknown>
>;
type YamlAgent = agent.JuncoAgent<
  Skill,
  PromptTemplate,
  AgentTool,
  TSchema,
  unknown
>;
type YamlMockAgent = MockAgent<
  Skill,
  PromptTemplate,
  AgentTool,
  TSchema,
  unknown
>;
export type AgentSpec = {
  readonly graph: string;
  readonly node: string;
  readonly systemPrompt?: string;
  readonly tools: (AgentTool | mcp.JuncoMcpTools)[];
  readonly skills: Skill[];
  readonly cwd: string;
  readonly collection?: tools.ToolCollection;
  /** The immediate parent graph's recorder view; the agent's context is `recorderNodeId` in it. */
  readonly recorder?: tools.ProfileRecorder<
    "memory" | "tokens" | "edits" | "operations" | "probe"
  >;
  /** The agent's local node ID. */
  readonly recorderNodeId?: string;
};
/** What a `kind: code` definition sees when its node is registered. */
export type CodeContext<C = unknown> = {
  readonly graph: JuncoGraph<TSchema, unknown>;
  readonly label: string;
  readonly node: string;
  readonly edges: ReadonlyMap<string, Edge>;
  readonly policy: tools.Policy;
  readonly collection?: tools.ToolCollection;
  /** The enclosing graph's recorder view; the node's context is `recorderNodeId` in it. */
  readonly recorder?: tools.ProfileRecorder<
    "memory" | "tokens" | "edits" | "operations" | "probe"
  >;
  readonly recorderNodeId?: string;
  readonly context: C;
  readonly signal?: AbortSignal;
};
export type CodeRegistration = {
  readonly state: Deterministic<TSchema, unknown>;
  readonly is_available?: Available;
  readonly contract?: (edgeId: graph.EdgeIdType) => { expect: string };
};
/** Definition keyed by the code node's id in the workflow config. */
export type DeterministicNode<C = unknown> = (
  context: CodeContext<C>,
) => CodeRegistration | Promise<CodeRegistration>;
export type BuildOptions<C = unknown> = {
  readonly cwd: string;
  readonly scheduler: (
    graph: string,
  ) => Scheduler<
    Agentic<TSchema, unknown>,
    TSchema,
    unknown,
    AgencyNodeMetadata
  >;
  readonly policy?: tools.Policy;
  readonly collection?: tools.ToolCollection;
  /** Limits/monitoring of the collection build creates; rejected with collection, agents or createAgent. */
  readonly resources?: tools.NativeResourceOptions;
  /** Monitor callback; pair with resources.monitorIntervalMs. Recorders take `recorder` instead. */
  readonly onResourceEvent?: (event: tools.NativeResourceEvent) => void;
  /** Fitted profiles keyed by id or parentNodeId/id; a present node overrides its YAML profiles. */
  readonly profiles?: ProfilesFile;
  readonly models?: ModelRuntime;
  /** Code-node definitions by node id, exported by the same-named workflow module. */
  readonly code?: Readonly<Record<string, DeterministicNode<C>>>;
  /** Models per strength; required when build creates agents. */
  readonly ladder?: Ladder;
  readonly tracer?: tracer.DataflowTracer;
  /** Profiling session of every graph, agent and created collection; independent of `tracer`. */
  readonly recorder?: tools.ProfileRecorder<
    "memory" | "tokens" | "edits" | "operations" | "probe"
  >;
  /** The root graph's context in `recorder` (default: the recorder's own context). */
  readonly recorderNodeId?: string;
  readonly tools?: Readonly<Record<string, AgentTool>>;
  /**
   * Prepared agents keyed by node path (`Worker` or `Child/Worker`), exclusive with createAgent.
   * Ownership transfers at build entry: failure closes every supplied agent; success leaves
   * registered agents owned by the graph. Models, tools, skills and system prompts are already
   * configured on these agents; node prompts, contracts and profiles still apply.
   */
  readonly agents?: Readonly<Record<string, YamlAgent>>;
  /** Factory agents stay caller-owned on construction failure; `createAgentOwnership` decides on success. */
  readonly createAgent?: (
    spec: AgentSpec,
  ) => Promise<YamlAgent | YamlMockAgent>;
  /**
   * Owner of successfully registered factory agents (default `"graph"`, which disposes them on
   * close). `"caller"`: graph close aborts and joins them but never disposes them, so persistent
   * agents can serve one graph per round. Requires `createAgent`.
   */
  readonly createAgentOwnership?: "graph" | "caller";
  readonly available?: Readonly<
    Record<
      string,
      (context: {
        graph: JuncoGraph<TSchema, unknown>;
        edges: ReadonlyMap<string, Edge>;
      }) => Available | undefined
    >
  >;
  readonly context?: C;
  readonly signal?: AbortSignal;
};
export type FromYamlOptions<C = unknown> = BuildOptions<C> & ParseOptions;

/** The trimmed text of `member`'s normally completed assistant result; throws on a missing, non-assistant, abnormal or blank result. */
export function finalText(message: unknown, member: string): string {
  if (message === undefined)
    throw new Error(`${member} did not finish normally: no final message`);
  if (!Value.Check(agent.AssistantMessageSchema, message))
    throw new Error(`${member} did not produce an assistant message`);
  if (message.stopReason !== "stop") {
    const detail = message.errorMessage ? `: ${message.errorMessage}` : "";
    throw new Error(
      `${member} did not finish normally: ${message.stopReason}${detail}`,
    );
  }
  const text = contentText(message.content).trim();
  if (!text) throw new Error(`${member} produced an empty report`);
  return text;
}

async function loadSkill(name: string, path: string): Promise<Skill> {
  const { skills: found, diagnostics } = loadSkillsFromDir({
    dir: dirname(path),
    source: "path",
  });
  if (diagnostics.length)
    throw new graph.DataflowDefinitionError(
      `junco-syntax: skill "${name}": ${diagnostics.map((d) => d.message).join("; ")}`,
    );
  const entry =
    found.find((s) => s.filePath === path) ??
    (existsSync(path)
      ? found.find((s) => realpathSync(s.filePath) === realpathSync(path))
      : undefined);
  if (!entry)
    throw new graph.DataflowDefinitionError(
      `skill "${name}": ${path} is not a valid SKILL.md`,
    );
  return {
    name: entry.name,
    description: entry.description,
    content: await readFile(path, "utf8"),
    filePath: entry.filePath,
    disableModelInvocation: entry.disableModelInvocation,
  };
}

function mcpDefinition(
  name: string,
  server: NonNullable<JuncoDocument["mcp"]>[string],
): mcp.JuncoMcpTools {
  const { timeout, ...definition } = server;
  return mcp.JuncoMcpTools.add({
    ...definition,
    name,
    type: "stdio",
    ...(timeout === undefined
      ? {}
      : { clientOptions: { requestTimeoutMs: timeout } }),
  });
}

function builtinTools(): AgentTool[] {
  return [
    new tools.YieldTool(),
    new tools.InfoTool(),
    new tools.SendTool(),
    new tools.RecvTool(),
    new tools.TaskTool(),
  ];
}

export async function resolveAgents(
  doc: JuncoDocument,
  options: Pick<BuildOptions, "cwd" | "tools" | "collection">,
): Promise<readonly AgentSpec[]> {
  const definitions = new Map<string, mcp.JuncoMcpTools>();
  const loaded = new Map<string, Skill>();
  const result: AgentSpec[] = [];
  for (const { id, node, label } of walk(doc.graph)) {
    if (!isAgent(node)) continue;
    const skills: Skill[] = [];
    for (const name of node.skills ?? []) {
      let skill = loaded.get(name);
      if (skill === undefined) {
        const path = doc.skills?.[name];
        if (path === undefined)
          throw new TypeError(
            `build: unknown skill "${name}" for node "${id}"`,
          );
        skill = await loadSkill(name, resolve(options.cwd, path));
        loaded.set(name, skill);
      }
      skills.push(skill);
    }
    const extra = (node.tools ?? []).map((name) => {
      const tool =
        options.collection?.tools.find((t) => t.name === name) ??
        options.tools?.[name];
      if (!tool)
        throw new TypeError(`build: unknown tool "${name}" for node "${id}"`);
      if ((BUILTIN_TOOL_NAMES as readonly string[]).includes(tool.name))
        throw new TypeError(
          `build: tool "${name}" for node "${id}" shadows builtin tool "${tool.name}"`,
        );
      return tool;
    });
    const servers = (node.mcp ?? []).map((name) => {
      let definition = definitions.get(name);
      if (!definition) {
        const server = doc.mcp?.[name];
        if (server === undefined)
          throw new TypeError(
            `build: unknown mcp server "${name}" for node "${id}"`,
          );
        definition = mcpDefinition(name, server);
        definitions.set(name, definition);
      }
      return definition;
    });
    result.push({
      graph: label,
      node: id,
      systemPrompt:
        [
          node.system,
          skills.length ? formatSkillsForSystemPrompt(skills) : undefined,
        ]
          .filter(Boolean)
          .join("\n\n") || undefined,
      tools: [...builtinTools(), ...extra, ...servers],
      skills,
      cwd: options.cwd,
      collection: options.collection,
    });
  }
  return result;
}

export function createJuncoAgent(
  spec: AgentSpec,
  ladder: Ladder,
  models?: ModelRuntime,
): Promise<YamlAgent> {
  const { provider, modelId, thinking } = resolveRung(
    ladder,
    DEFAULT_MODEL_STRENGTH,
  );
  return agent.JuncoAgent.create<Skill, PromptTemplate, TSchema, unknown>({
    provider,
    model: modelId,
    models,
    thinkingLevel: thinking,
    systemPrompt: spec.systemPrompt,
    cwd: spec.cwd,
    tools: spec.tools,
    collection: spec.collection,
    recorder: spec.recorder,
    recorderNodeId: spec.recorderNodeId,
    ...(spec.skills.length ? { resources: { skills: spec.skills } } : {}),
  });
}

/** Every node of `spec` and its nested graphs, depth-first and in declaration order: `key` is the `Child/Node` path, `label` the enclosing graph's name. */
function* walk(
  spec: GraphSpec,
  label = spec.name ?? "graph",
  path = "",
): Generator<{ id: string; node: NodeSpec; key: string; label: string }> {
  for (const [id, node] of Object.entries(spec.nodes)) {
    const key = path === "" ? id : `${path}/${id}`;
    yield { id, node, key, label };
    if (node.kind === "graph")
      yield* walk(node.graph, node.graph.name ?? id, key);
  }
}
const isAgent = (
  node: NodeSpec,
): node is Extract<NodeSpec, { kind?: "agent" }> =>
  node.kind !== "graph" && node.kind !== "emit" && node.kind !== "code";
const hasAgents = (spec: GraphSpec) =>
  [...walk(spec)].some(({ node }) => isAgent(node));

/** A profiled build's cost of ports and non-agent nodes. */
const ZERO: graph.ProfileSet = Object.freeze({
  memory: graph.constantProfile("memory", unitOf("memory", "B")(0)),
  runtime: graph.constantProfile("runtime", unitOf("runtime", "ms")(0)),
  tokens: graph.constantProfile("tokens", unitOf("tokens", "tok")(0)),
});

const hasProfiles = (spec: GraphSpec) =>
  [...walk(spec)].some(({ node }) => node.profiles !== undefined);

const constant = <R extends graph.ResourceKind>(kind: R, text: string) =>
  graph.constantProfile(kind, quantityOf(kind, text));

function nodeProfiles(
  c: Construction,
  key: string,
  node: NodeSpec,
): graph.ProfileSet | undefined {
  const file = c.options.profiles;
  if (file !== undefined && Object.hasOwn(file.nodes, key))
    return profilesOf(
      file,
      key,
      Object.keys(file.nodes[key]) as graph.ResourceKind[],
    );
  if (node.profiles !== undefined)
    return Object.fromEntries(
      Object.entries(node.profiles).map(([kind, text]) => [
        kind,
        constant(kind as graph.ResourceKind, text),
      ]),
    );
  // Non-agent work costs nothing; an undeclared agent keeps no profile so a strict schedule names it.
  return c.profiled &&
    (node.kind === "emit" || node.kind === "graph" || node.kind === "code")
    ? ZERO
    : undefined;
}

/** Edge `id` of `edges`; parse guarantees every referenced edge is declared. */
function edgeOf(edges: ReadonlyMap<string, Edge>, id: string): Edge {
  const edge = edges.get(id);
  if (edge === undefined)
    throw new graph.DataflowDefinitionError(`unknown edge "${id}"`);
  return edge;
}

/**
 * The engine edges of `spec`. A `probe: true` edge reports each publication to the owning graph's
 * recorder current at delivery time (`recorder`), tagged with its edge ID.
 */
function createEdges(
  spec: GraphSpec,
  recorder: (() => BuildOptions["recorder"]) | undefined,
): Map<string, Edge> {
  return new Map(
    (spec.edges ?? []).map((edge): [string, Edge] => {
      const id = edgeId(edge);
      const probe =
        edge.probe === true && recorder !== undefined
          ? (value: unknown) =>
              // parse admits probes on numeric types only; the engine checked `value` against it.
              recorder()?.record({
                resource: "probe",
                kind: "probe",
                edgeId: id,
                value: value as number,
              })
          : undefined;
      return [
        id,
        edge.kind === "message"
          ? graph.Edge.message<TSchema, unknown>(id, edge.schema, probe)
          : graph.Edge.value(id, edge.schema, probe),
      ];
    }),
  );
}

/** The admission domain of a port routing onto `edges`: `Never` when empty, else their union. */
function domain(edges: Iterable<Edge>): TSchema {
  const schemas = [...new Set(edges)].map((edge) => edge.schema);
  return schemas.length === 0
    ? Type.Never()
    : schemas.length === 1
      ? schemas[0]
      : Type.Union(schemas);
}

function createSource(
  spec: GraphSpec,
  label: string,
  edges: ReadonlyMap<string, Edge>,
  profiles: graph.ProfileSet | undefined,
): graph.Source<TSchema, unknown> {
  const routes = spec.source?.routes;
  return new graph.Source<TSchema, unknown>(
    (view) => {
      if (routes === undefined)
        throw new graph.DataflowDefinitionError(
          `${label} does not accept external input`,
        );
      const messages: graph.Message<TSchema>[] = [];
      const forward = (id: string, payload: unknown): void => {
        if (!Object.hasOwn(routes, id))
          throw new graph.DataflowDefinitionError(
            `${label} does not accept input on edge "${id}"`,
          );
        for (const target of routes[id])
          messages.push(graph.Message.create(edgeOf(edges, target), payload));
      };
      for (const id of view.messages.keys())
        for (const payload of view.messages.get(id) ?? []) forward(id, payload);
      for (const id of view.values.keys()) forward(id, view.values.get(id));
      return messages;
    },
    {
      id: graph.NodeId.create("$source"),
      description: spec.source?.description,
      schema: domain(
        Object.values(routes ?? {})
          .flat()
          .map((target) => edgeOf(edges, target)),
      ),
      ...(profiles ? { profiles } : {}),
    },
  );
}

function createSink(
  spec: GraphSpec,
  edges: ReadonlyMap<string, Edge>,
  parentOutputs: readonly Edge[],
  result: (id: string) => O.Option<unknown>,
  is_available: Available | undefined,
  profiles: graph.ProfileSet | undefined,
): graph.Sink<TSchema, unknown> {
  const returns = spec.sink?.returns ?? inboundEdges(spec, "$sink")[0].from;
  return new graph.Sink<TSchema, unknown>(
    async function* (port): graph.NodeGenerator<TSchema, unknown> {
      yield [];
      const r = result(returns);
      if (O.isNone(r)) throw new Error(`${returns} did not produce a result`);
      for (const edge of parentOutputs)
        port.send(graph.Message.create(edge, r.value));
      return r.value;
    },
    {
      id: graph.NodeId.create("$sink"),
      description: spec.sink?.description,
      schema: domain(parentOutputs),
      trigger: resolveTrigger(spec, "$sink", edges, spec.sink?.trigger),
      ...(is_available ? { is_available } : {}),
      ...(profiles ? { profiles } : {}),
    },
  );
}

function registerEmit(
  g: JuncoGraph<TSchema, unknown>,
  registration: Registration,
  text: string,
  outbound: readonly Edge[],
): void {
  let published = false;
  const state = new Deterministic<TSchema, unknown>(async function* (
    signal,
  ): graph.NodeGenerator<TSchema, unknown> {
    const payload = { kind: "prompt", text } as const;
    while (true) {
      signal.throwIfAborted();
      published = true;
      yield outbound.map((edge) => graph.Message.create(edge, payload));
    }
  }, tools.EmptyPolicy);
  g.addNode({
    ...registration,
    trigger: graph.TriggerRule.always(),
    is_available: registration.is_available ?? (() => !published),
    state,
  });
}

async function registerAgent(
  c: Construction,
  g: JuncoGraph<TSchema, unknown>,
  spec: GraphSpec,
  edges: ReadonlyMap<string, Edge>,
  id: string,
  node: Extract<NodeSpec, { kind?: "agent" }>,
  registration: Registration,
  key: string,
): Promise<void> {
  let instance: YamlAgent | YamlMockAgent;
  if (c.agents) {
    const prepared = c.agents.get(key);
    if (prepared === undefined)
      throw new graph.DataflowDefinitionError(
        `junco-syntax: missing prepared agent for node "${key}"`,
      );
    instance = prepared;
  } else {
    const next = c.specs.next();
    if (next.done)
      throw new graph.DataflowDefinitionError(
        `junco-syntax: no agent spec for node "${key}"`,
      );
    const spec = placed(next.value, g, id);
    if (c.options.createAgent) instance = await c.options.createAgent(spec);
    else {
      const { ladder } = c.options;
      if (ladder === undefined)
        throw new graph.DataflowDefinitionError(
          "junco-syntax: a ladder is required to create agents; pass ladder or createAgent",
        );
      const created = await createJuncoAgent(spec, ladder, c.options.models);
      c.acquired.push(created);
      instance = created;
    }
  }
  if (node.prompt !== undefined)
    instance.stagePrompt(compilePrompt(node.prompt));
  const byEdge = node.contracts;
  const contract =
    byEdge === undefined
      ? undefined
      : (edgeId: graph.EdgeIdType) => {
          if (!Object.hasOwn(byEdge, edgeId))
            throw new agent.JuncoAgentError(
              "invalid_state",
              `No contract for edge "${edgeId}"`,
            );
          return { expect: byEdge[edgeId] };
        };
  const registered = g.addNode({
    ...registration,
    trigger: resolveTrigger(spec, id, edges, node.trigger),
    state: instance,
    policy: c.policy,
    ...(contract ? { contract } : {}),
  });
  if (c.options.createAgent) {
    // No await since registration: until the build commits, rollback never disposes this agent.
    const step = g.getNode(registered)?.step;
    const policy = step && nodePolicies.get(step);
    if (policy === undefined)
      throw new agent.JuncoAgentError(
        "invalid_state",
        `Node "${id}" has no policy`,
      );
    policy.agentOwnership = "caller";
    c.borrowed.push(policy);
  }
}

/** `spec` at node `id` of `g`, carrying `g`'s recorder view when it records. */
const placed = (
  spec: AgentSpec,
  g: JuncoGraph<TSchema, unknown>,
  id: string,
): AgentSpec =>
  g.recorder === undefined
    ? spec
    : { ...spec, recorder: g.recorder, recorderNodeId: id };

async function buildGraph(
  c: Construction,
  spec: GraphSpec,
  label: string,
  observer: tracer.DataflowTracer | undefined,
  parentOutputs: readonly Edge[],
  path: string,
  recorder: BuildOptions["recorder"],
  recorderNodeId: string | undefined,
): Promise<Execution> {
  c.options.signal?.throwIfAborted();
  const edges = createEdges(
    spec,
    recorder === undefined ? undefined : () => g.recorder,
  );
  const portProfiles = c.profiled ? ZERO : undefined;
  const source = createSource(spec, label, edges, portProfiles);
  let sinkHook: Available | undefined;
  const sink = createSink(
    spec,
    edges,
    parentOutputs,
    (id) => g.result(graph.NodeId.create(id)),
    c.options.available?.$sink
      ? (v, t) => (sinkHook ? sinkHook(v, t) : t)
      : undefined,
    portProfiles,
  );
  // parse validated these dynamic integers; Width.create only accepts numeric literals.
  const g = new JuncoGraph<TSchema, unknown>(
    source,
    sink,
    (spec.window ?? 1) as graph.WidthType,
    spec.threads === undefined || spec.threads === "unbounded"
      ? graph.UNBOUNDED
      : (spec.threads as graph.WidthType),
    observer,
    c.policy,
    c.collection,
    recorder,
    recorderNodeId,
  );
  c.partialRoots.add(g);
  const hook = (id: string) => c.options.available?.[id]?.({ graph: g, edges });
  sinkHook = hook("$sink");
  const execution = context({
    scheduler: c.options.scheduler(label),
    graph: g,
    ...(c.options.ladder === undefined ? {} : { ladder: c.options.ladder }),
  });
  for (const [id, node] of Object.entries(spec.nodes)) {
    c.options.signal?.throwIfAborted();
    const outbound = outboundEdges(spec, id)
      .filter((e) => e.kind === "message")
      .map((e) => edgeOf(edges, edgeId(e)));
    const is_available = hook(id);
    const key = path === "" ? id : `${path}/${id}`;
    const profiles = nodeProfiles(c, key, node);
    const registration: Registration = {
      id: graph.NodeId.create(id),
      description: node.description,
      ...(is_available ? { is_available } : {}),
      ...(profiles ? { profiles } : {}),
    };
    if (node.kind === "emit") {
      registerEmit(g, registration, node.text, outbound);
    } else if (node.kind === "graph") {
      const child = await buildGraph(
        c,
        node.graph,
        node.graph.name ?? id,
        g.tracer,
        outbound,
        key,
        g.recorder,
        id,
      );
      g.addNode({
        ...registration,
        trigger: resolveTrigger(spec, id, edges, node.trigger),
        state: child,
      });
      c.partialRoots.delete(child.graph);
    } else if (node.kind === "code") {
      const definition = c.options.code?.[id];
      if (definition === undefined)
        throw new graph.DataflowDefinitionError(
          `junco-syntax: code node "${id}" has no definition in options.code`,
        );
      const created = await definition({
        graph: g,
        label,
        node: id,
        edges,
        policy: c.policy,
        collection: c.collection,
        recorder: g.recorder,
        recorderNodeId: id,
        context: c.options.context,
        signal: c.options.signal,
      });
      g.addNode({
        ...registration,
        ...(created.is_available ? { is_available: created.is_available } : {}),
        trigger: resolveTrigger(spec, id, edges, node.trigger),
        state: created.state,
        ...(created.contract ? { contract: created.contract } : {}),
      });
    } else {
      await registerAgent(c, g, spec, edges, id, node, registration, key);
    }
  }
  for (const edge of spec.edges ?? [])
    g.addEdge(
      graph.NodeId.create(edge.from),
      graph.NodeId.create(edge.to),
      edgeOf(edges, edgeId(edge)),
    );
  return execution;
}

async function rollback(
  c: Pick<Construction, "acquired" | "partialRoots">,
  error: unknown,
): Promise<never> {
  const failures: unknown[] = [];
  for (const instance of [...c.acquired].reverse()) {
    try {
      await instance.return();
    } catch (failure) {
      failures.push(failure);
    }
  }
  for (const root of [...c.partialRoots].reverse()) {
    try {
      await root.close();
    } catch (failure) {
      const errors =
        failure instanceof AggregateError ? failure.errors : [failure];
      for (const error of errors)
        if (!failures.includes(error)) failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      [error, ...failures],
      "build failed and agent cleanup failed",
    );
  throw error;
}

/**
 * A placeholder's text for one payload of edge `id`: chat input text (`appendMessage` contributes
 * nothing) or a normally completed assistant result. Other payloads are read through `recv` or code.
 */
function render(payload: unknown, id: string): string {
  if (Value.Check(agent.AgenticInputSchema, payload))
    return "text" in payload ? payload.text : "";
  if (Value.Check(agent.AssistantMessageSchema, payload))
    return finalText(payload, id);
  throw new TypeError(
    `Prompt placeholder {{${id}}} renders only AgenticInput or AssistantMessage payloads; read edge "${id}" with recv or a code node`,
  );
}

function compilePrompt(
  text: string,
): string | ((inputs: graph.ParentView<TSchema, unknown>) => string) {
  if (![...text.matchAll(PLACEHOLDER)].length) return text;
  return (inputs) =>
    text.replace(PLACEHOLDER, (_, id: string) => {
      const key = graph.EdgeId.create(id);
      if (inputs.values.has(key)) return render(inputs.values.get(key), id);
      return (inputs.messages.get(key) ?? [])
        .map((payload) => render(payload, id))
        .join("\n\n");
    });
}

const codeIds = (spec: GraphSpec) =>
  [...walk(spec)].flatMap(({ id, node }) => (node.kind === "code" ? [id] : []));

/** Per-build state shared by every graph level; agents/graphs here are released on failure. */
type Construction = {
  readonly options: BuildOptions;
  readonly policy: tools.Policy;
  readonly collection: tools.ToolCollection | undefined;
  readonly profiled: boolean;
  readonly specs: Iterator<AgentSpec>;
  readonly agents: ReadonlyMap<string, YamlAgent> | undefined;
  /** Owned agents in acquisition order, including prepared agents not yet registered. */
  readonly acquired: YamlAgent[];
  /** Graphs not yet adopted by a parent. */
  readonly partialRoots: Set<JuncoGraph<TSchema, unknown>>;
  /** Registered factory nodes, caller-owned until the whole build commits. */
  readonly borrowed: NodePolicy[];
};
type Registration = {
  readonly id: graph.NodeIdType;
  readonly description: string | undefined;
  readonly is_available?: Available;
  readonly profiles?: graph.ProfileSet;
};
type Available = graph.AvailabilityFn<TSchema, unknown>;

function validateAgents(
  spec: GraphSpec,
  agents: ReadonlyMap<string, YamlAgent>,
): void {
  if (new Set(agents.values()).size !== agents.size)
    throw new graph.DataflowDefinitionError(
      "junco-syntax: agents must not assign the same agent to multiple node paths",
    );
  const unused = new Set(agents.keys());
  for (const { key, node } of walk(spec)) {
    if (!isAgent(node)) continue;
    if (!agents.has(key))
      throw new graph.DataflowDefinitionError(
        `junco-syntax: missing prepared agent for node "${key}"`,
      );
    if (!unused.delete(key))
      throw new graph.DataflowDefinitionError(
        `junco-syntax: duplicate prepared agent node path "${key}"`,
      );
  }
  if (unused.size)
    throw new graph.DataflowDefinitionError(
      `junco-syntax: unused prepared agents: ${[...unused].join(", ")}`,
    );
}

export async function build<C = unknown>(
  doc: JuncoDocument,
  options: BuildOptions<C>,
): Promise<Execution> {
  const agents =
    options.agents === undefined
      ? undefined
      : new Map(Object.entries(options.agents));
  const owned = {
    acquired: agents ? [...new Set(agents.values())] : [],
    partialRoots: new Set<JuncoGraph<TSchema, unknown>>(),
  };
  let creates: boolean;
  let profiled: boolean;
  let policy: tools.Policy;
  try {
    if (agents && options.createAgent !== undefined)
      throw new graph.DataflowDefinitionError(
        "junco-syntax: agents and createAgent are mutually exclusive",
      );
    if (
      options.createAgentOwnership !== undefined &&
      options.createAgent === undefined
    )
      throw new graph.DataflowDefinitionError(
        "junco-syntax: createAgentOwnership requires createAgent",
      );
    if (agents) validateAgents(doc.graph, agents);
    creates =
      !options.collection &&
      !options.createAgent &&
      !agents &&
      hasAgents(doc.graph);
    if (
      !creates &&
      (options.resources !== undefined || options.onResourceEvent !== undefined)
    )
      throw new graph.DataflowDefinitionError(
        "junco-syntax: resources and onResourceEvent apply to the collection build creates; open the supplied collection with them instead",
      );
    for (const id of codeIds(doc.graph))
      if (options.code?.[id] === undefined)
        throw new graph.DataflowDefinitionError(
          `junco-syntax: code node "${id}" has no definition in options.code`,
        );
    if (options.ladder !== undefined) validateLadder(options.ladder);
    if (
      hasAgents(doc.graph) &&
      !agents &&
      options.createAgent === undefined &&
      options.ladder === undefined
    )
      throw new graph.DataflowDefinitionError(
        "junco-syntax: a ladder is required to create agents; pass ladder or createAgent",
      );
    profiled = options.profiles !== undefined || hasProfiles(doc.graph);
    policy = options.policy ?? tools.LockPolicy;
  } catch (error) {
    return rollback(owned, error);
  }
  const construct = async (
    collection?: tools.ToolCollection,
  ): Promise<Execution> => {
    try {
      const c: Construction = {
        // Code nodes receive exactly this build's `context`, so erasing `C` is sound.
        options: options as BuildOptions,
        policy,
        collection,
        profiled,
        specs: (agents
          ? []
          : await resolveAgents(doc, { ...options, collection }))[
          Symbol.iterator
        ](),
        agents,
        ...owned,
        borrowed: [],
      };
      const execution = await buildGraph(
        c,
        doc.graph,
        doc.graph.name ?? "graph",
        options.tracer,
        [],
        "",
        options.recorder,
        options.recorderNodeId,
      );
      if (options.createAgentOwnership !== "caller")
        for (const policy of c.borrowed) policy.agentOwnership = "graph";
      return execution;
    } catch (error) {
      return rollback(owned, error);
    }
  };
  if (creates)
    return JuncoGraph.create(
      options.cwd,
      {
        policy,
        ...(options.recorder ? { recorder: options.recorder } : {}),
        ...(options.resources ? { resources: options.resources } : {}),
        ...(options.onResourceEvent
          ? { onResourceEvent: options.onResourceEvent }
          : {}),
      },
      construct,
    );
  return construct(options.collection);
}
