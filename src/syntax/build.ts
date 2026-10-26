import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type AgentTool,
  formatSkillsForSystemPrompt,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
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
import type { Agentic, AgenticInput } from "../agentic.js";
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

type Edge = graph.Edge<AgenticInput, AssistantMessage>;
type Execution = SchedulerContext<
  Agentic,
  AgenticInput,
  AssistantMessage,
  AgencyNodeMetadata,
  JuncoGraph
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
    "memory" | "tokens" | "edits" | "operations"
  >;
  /** The agent's local node ID. */
  readonly recorderNodeId?: string;
};
/** What a `kind: code` definition sees when its node is registered. */
export type CodeContext<C = unknown> = {
  readonly graph: JuncoGraph;
  readonly label: string;
  readonly node: string;
  readonly edges: ReadonlyMap<string, Edge>;
  readonly policy: tools.Policy;
  readonly collection?: tools.ToolCollection;
  /** The enclosing graph's recorder view; the node's context is `recorderNodeId` in it. */
  readonly recorder?: tools.ProfileRecorder<
    "memory" | "tokens" | "edits" | "operations"
  >;
  readonly recorderNodeId?: string;
  readonly context: C;
  readonly signal?: AbortSignal;
};
export type CodeRegistration = {
  readonly state: Deterministic<AgenticInput, AssistantMessage>;
  readonly is_available?: graph.AvailabilityFn<AgenticInput, AssistantMessage>;
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
  ) => Scheduler<Agentic, AgenticInput, AssistantMessage, AgencyNodeMetadata>;
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
    "memory" | "tokens" | "edits" | "operations"
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
  readonly agents?: Readonly<Record<string, agent.JuncoAgent>>;
  /** Factory agents stay caller-owned on construction failure; `createAgentOwnership` decides on success. */
  readonly createAgent?: (
    spec: AgentSpec,
  ) => Promise<agent.JuncoAgent | MockAgent>;
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
        graph: JuncoGraph;
        edges: ReadonlyMap<string, Edge>;
      }) => graph.AvailabilityFn<AgenticInput, AssistantMessage> | undefined
    >
  >;
  readonly context?: C;
  readonly signal?: AbortSignal;
};
export type FromYamlOptions<C = unknown> = BuildOptions<C> & {
  readonly params?: ParseOptions["params"];
};

/** The trimmed text of `member`'s normally completed result; throws on a missing, abnormal or blank result. */
export function finalText(
  message: AssistantMessage | undefined,
  member: string,
): string {
  if (message?.stopReason !== "stop") {
    const detail = message?.errorMessage ? `: ${message.errorMessage}` : "";
    throw new Error(
      `${member} did not finish normally: ${message?.stopReason ?? "no final message"}${detail}`,
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
      const skill =
        loaded.get(name) ??
        (await loadSkill(name, resolve(options.cwd, doc.skills![name]!)));
      loaded.set(name, skill);
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
        definition = mcpDefinition(name, doc.mcp![name]!);
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
): Promise<agent.JuncoAgent> {
  const { provider, modelId, thinking } = resolveRung(
    ladder,
    DEFAULT_MODEL_STRENGTH,
  );
  return agent.JuncoAgent.create({
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
      Object.keys(file.nodes[key]!) as graph.ResourceKind[],
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

function createEdges(spec: GraphSpec): Map<string, Edge> {
  return new Map(
    (spec.edges ?? []).map((edge) => [
      edgeId(edge),
      edge.kind === "message"
        ? graph.Edge.message<AgenticInput, AssistantMessage>(edgeId(edge))
        : graph.Edge.value<AgenticInput, AssistantMessage>(edgeId(edge)),
    ]),
  );
}

function createSource(
  spec: GraphSpec,
  label: string,
  edges: ReadonlyMap<string, Edge>,
  profiles: graph.ProfileSet | undefined,
): graph.Source<AgenticInput, AssistantMessage> {
  return new graph.Source<AgenticInput, AssistantMessage>(
    (view) => {
      const routes = spec.source?.routes;
      if (routes === undefined)
        throw new graph.DataflowDefinitionError(
          `${label} does not accept external input`,
        );
      const messages: graph.Message<AgenticInput>[] = [];
      function forward(id: string, payload: AgenticInput): void {
        if (!Object.hasOwn(routes!, id))
          throw new graph.DataflowDefinitionError(
            `${label} does not accept input on edge "${id}"`,
          );
        for (const target of routes![id]!)
          messages.push(graph.Message.create(edges.get(target)!, payload));
      }
      for (const id of view.messages.keys())
        for (const payload of view.messages.get(id) ?? []) forward(id, payload);
      for (const id of view.values.keys())
        forward(id, {
          kind: "prompt",
          text: finalText(view.values.get(id), id),
        });
      return messages;
    },
    {
      id: graph.NodeId.create("$source"),
      description: spec.source?.description,
      ...(profiles ? { profiles } : {}),
    },
  );
}

function createSink(
  spec: GraphSpec,
  parentOutputs: readonly Edge[],
  result: (id: string) => O.Option<AssistantMessage>,
  is_available: Available | undefined,
  profiles: graph.ProfileSet | undefined,
): graph.Sink<AgenticInput, AssistantMessage> {
  const returns = spec.sink?.returns ?? inboundEdges(spec, "$sink")[0]!.from;
  return new graph.Sink<AgenticInput, AssistantMessage>(
    async function* (
      port,
    ): graph.NodeGenerator<AgenticInput, AssistantMessage> {
      yield [];
      const r = result(returns);
      if (O.isNone(r)) throw new Error(`${returns} did not produce a result`);
      if (parentOutputs.length) {
        const text = finalText(r.value, returns);
        for (const edge of parentOutputs)
          port.send(graph.Message.create(edge, { kind: "prompt", text }));
      }
      return r.value;
    },
    {
      id: graph.NodeId.create("$sink"),
      description: spec.sink?.description,
      trigger: resolveTrigger(spec, "$sink", spec.sink?.trigger),
      ...(is_available ? { is_available } : {}),
      ...(profiles ? { profiles } : {}),
    },
  );
}

function registerEmit(
  g: JuncoGraph,
  registration: Registration,
  text: string,
  outbound: readonly Edge[],
): void {
  let published = false;
  const state = new Deterministic<AgenticInput, AssistantMessage>(
    async function* (
      signal,
    ): graph.NodeGenerator<AgenticInput, AssistantMessage> {
      const payload = { kind: "prompt", text } as const;
      while (true) {
        signal.throwIfAborted();
        published = true;
        yield outbound.map((edge) => graph.Message.create(edge, payload));
      }
    },
    tools.EmptyPolicy,
  );
  g.addNode({
    ...registration,
    trigger: graph.TriggerRule.always(),
    is_available: registration.is_available ?? (() => !published),
    state,
  });
}

async function registerAgent(
  c: Construction,
  g: JuncoGraph,
  spec: GraphSpec,
  id: string,
  node: Extract<NodeSpec, { kind?: "agent" }>,
  registration: Registration,
  key: string,
): Promise<void> {
  const instance = c.agents
    ? c.agents.get(key)!
    : c.options.createAgent
      ? await c.options.createAgent(placed(c.specs.next().value!, g, id))
      : await createJuncoAgent(
          placed(c.specs.next().value!, g, id),
          c.options.ladder!,
          c.options.models,
        );
  if (!c.agents && !c.options.createAgent)
    c.acquired.push(instance as agent.JuncoAgent);
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
          return { expect: byEdge[edgeId]! };
        };
  const registered = g.addNode({
    ...registration,
    trigger: resolveTrigger(spec, id, node.trigger),
    state: instance,
    policy: c.policy,
    ...(contract ? { contract } : {}),
  });
  if (c.options.createAgent) {
    // No await since registration: until the build commits, rollback never disposes this agent.
    const policy = nodePolicies.get(g.getNode(registered)!.step)!;
    policy.agentOwnership = "caller";
    c.borrowed.push(policy);
  }
}

/** `spec` at node `id` of `g`, carrying `g`'s recorder view when it records. */
const placed = (spec: AgentSpec, g: JuncoGraph, id: string): AgentSpec =>
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
  const edges = createEdges(spec);
  const portProfiles = c.profiled ? ZERO : undefined;
  const source = createSource(spec, label, edges, portProfiles);
  let sinkHook: Available | undefined;
  const sink = createSink(
    spec,
    parentOutputs,
    (id) => g.result(graph.NodeId.create(id)),
    c.options.available?.$sink
      ? (v, t) => (sinkHook ? sinkHook(v, t) : t)
      : undefined,
    portProfiles,
  );
  // parse validated these dynamic integers; Width.create only accepts numeric literals.
  const g: JuncoGraph = new JuncoGraph(
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
      .map((e) => edges.get(edgeId(e))!);
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
        trigger: resolveTrigger(spec, id, node.trigger),
        state: child,
      });
      c.partialRoots.delete(child.graph);
    } else if (node.kind === "code") {
      const created = await c.options.code![id]!({
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
        trigger: resolveTrigger(spec, id, node.trigger),
        state: created.state,
        ...(created.contract ? { contract: created.contract } : {}),
      });
    } else {
      await registerAgent(c, g, spec, id, node, registration, key);
    }
  }
  for (const edge of spec.edges ?? [])
    g.addEdge(
      graph.NodeId.create(edge.from),
      graph.NodeId.create(edge.to),
      edges.get(edgeId(edge))!,
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

function compilePrompt(
  text: string,
): NonNullable<agent.AgenticOptions["prompt"]> {
  if (![...text.matchAll(PLACEHOLDER)].length) return text;
  return (inputs) =>
    text.replace(PLACEHOLDER, (_, id: string) => {
      const key = graph.EdgeId.create(id);
      if (inputs.values.has(key)) return finalText(inputs.values.get(key), id);
      return (inputs.messages.get(key) ?? [])
        .map((m) => ("text" in m ? (m.text ?? "") : ""))
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
  readonly agents: ReadonlyMap<string, agent.JuncoAgent> | undefined;
  /** Owned agents in acquisition order, including prepared agents not yet registered. */
  readonly acquired: agent.JuncoAgent[];
  /** Graphs not yet adopted by a parent. */
  readonly partialRoots: Set<JuncoGraph>;
  /** Registered factory nodes, caller-owned until the whole build commits. */
  readonly borrowed: NodePolicy[];
};
type Registration = {
  readonly id: graph.NodeIdType;
  readonly description: string | undefined;
  readonly is_available?: graph.AvailabilityFn<AgenticInput, AssistantMessage>;
  readonly profiles?: graph.ProfileSet;
};
type Available = graph.AvailabilityFn<AgenticInput, AssistantMessage>;

function validateAgents(
  spec: GraphSpec,
  agents: ReadonlyMap<string, agent.JuncoAgent>,
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
    partialRoots: new Set<JuncoGraph>(),
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
