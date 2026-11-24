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
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import * as graph from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import * as agent from "junco-agent";
import type * as mcp from "junco-mcp";
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
  type ModelLadder,
  type NodePolicy,
  nodePolicies,
  resolveRung,
} from "../node-policy.js";
import type * as tracer from "../std/tracer.js";
import type { ParseOptions } from "./parse.js";
import {
  edgeId,
  type EdgeSpec,
  type GraphSpec,
  inboundEdges,
  type JuncoDocument,
  type NodeSpec,
  outboundEdges,
  PLACEHOLDER,
  resolveTrigger,
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
  /** The enclosing graph's display label; labels may repeat across nested graphs. */
  readonly graph: string;
  /** The agent's local node ID within its enclosing graph. */
  readonly node: string;
  /** The agent's unique root-relative node path: `Worker`, `Child/Worker`, `Child/Grandchild/Worker`. */
  readonly path: string;
  readonly systemPrompt?: string;
  readonly tool_block?: readonly string[];
  readonly tools: (AgentTool | mcp.JuncoMcpTools)[];
  readonly toolSource?: string;
  readonly skills: Skill[];
  readonly cwd: string;
  readonly collection?: tools.ToolCollection;
  /** The immediate parent graph's recorder view; the agent's context is `recorderNodeId` in it. */
  readonly recorder?: tools.ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >;
  /** The agent's local node ID. */
  readonly recorderNodeId?: string;
  /** The build's `loopGuard`, shared by every agent it creates. */
  readonly loopGuard?: agent.LoopGuard;
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
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >;
  readonly recorderNodeId?: string;
  readonly context: C;
  readonly signal?: AbortSignal;
};
/** Definition keyed by the code node's id in the workflow config. */
export type DeterministicNode<C = unknown> = (
  context: CodeContext<C>,
) => Deterministic<TSchema, unknown> | Promise<Deterministic<TSchema, unknown>>;
export type BuildOptions<C = unknown> = {
  readonly cwd: string;
  /**
   * A fresh policy per graph level: `graph` is the level's display label (labels may repeat),
   * `graphPath` its unique wrapper path (`""` at the root, `Child` or `Child/Grandchild` nested).
   */
  readonly scheduler: (
    graph: string,
    graphPath: string,
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
  /** `tool_pruning` of the collection build creates; rejected with a supplied collection, like `resources`. */
  readonly tool_pruning?: boolean;
  /** Failure-loop guard of every agent the build creates (`createJuncoAgent`); `createAgent` receives it as `spec.loopGuard`. */
  readonly loopGuard?: agent.LoopGuard;
  /**
   * Samples retained per node and resource at each graph level; zero or omitted means none.
   * For native memory on a caller-owned collection, open it with `measureMemory: true`.
   */
  readonly measurementWindows?: ReadonlyMap<graph.ResourceKind, number>;
  /** Code-node definitions by node id, exported by the same-named workflow module. */
  readonly code?: Readonly<Record<string, DeterministicNode<C>>>;
  /** The runtime and the rungs agents may use; required when build creates agents, optional otherwise (model switching only). */
  readonly ladder?: ModelLadder;
  readonly tracer?: tracer.DataflowTracer;
  /** Profiling session of every graph, agent and created collection; independent of `tracer`. */
  readonly recorder?: tools.ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >;
  /** The root graph's context in `recorder` (default: the recorder's own context). */
  readonly recorderNodeId?: string;
  readonly tools?: Readonly<Record<string, AgentTool>>;
  /** Display-ready declaration module path for selected tool registrations. */
  readonly toolSource?: string;
  /**
   * Prepared agents keyed by node path (`Worker` or `Child/Worker`), exclusive with createAgent.
   * Ownership transfers at build entry: failure closes every supplied agent; success leaves
   * registered agents owned by the graph. Models, tools, skills and system prompts are already
   * configured on these agents; node prompts still apply.
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

function builtinTools(blocked: ReadonlySet<string>): AgentTool[] {
  const defaults: readonly (readonly [string, () => AgentTool])[] = [
    ["yield", () => new tools.YieldTool()],
    ["info", () => new tools.InfoTool()],
    ["send", () => new tools.SendTool()],
    ["task", () => new tools.TaskTool()],
  ];
  return defaults.flatMap(([name, create]) =>
    blocked.has(name) ? [] : [create()],
  );
}

export async function resolveAgents(
  doc: JuncoDocument,
  options: Pick<
    BuildOptions,
    "cwd" | "tools" | "collection" | "toolSource" | "loopGuard"
  >,
): Promise<readonly AgentSpec[]> {
  const loaded = new Map<string, Skill>();
  const result: AgentSpec[] = [];
  for (const { id, node, key, label } of walk(doc.graph)) {
    if (!isAgent(node)) continue;
    const block = node.tool_block ?? [];
    const blocked = new Set(block);
    const overlap = (node.tools ?? []).find((name) => blocked.has(name));
    if (overlap !== undefined)
      throw new TypeError(
        `build: node "${key}": tools and tool_block both list "${overlap}"; remove it from either tools or tool_block`,
      );
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
    const defaults = builtinTools(blocked);
    const extra = (node.tools ?? []).map((name) => {
      const tool =
        options.tools?.[name] ??
        options.collection?.tools.find((t) => t.name === name) ??
        defaults.find((t) => t.name === name);
      if (!tool)
        throw new TypeError(`build: unknown tool "${name}" for node "${id}"`);
      if (blocked.has(tool.name))
        throw new TypeError(
          `build: node "${key}": tool "${name}" resolves to blocked tool "${tool.name}"; remove it from tools or tool_block`,
        );
      return tool;
    });
    result.push({
      graph: label,
      node: id,
      path: key,
      systemPrompt:
        [
          node.system,
          skills.length ? formatSkillsForSystemPrompt(skills) : undefined,
        ]
          .filter(Boolean)
          .join("\n\n") || undefined,
      tools: [
        ...defaults.filter(
          (tool) => !extra.some((selected) => selected.name === tool.name),
        ),
        ...extra,
      ],
      ...(node.tool_block === undefined ? {} : { tool_block: block }),
      skills,
      cwd: options.cwd,
      collection: options.collection,
      toolSource: options.toolSource,
      ...(options.loopGuard === undefined
        ? {}
        : { loopGuard: options.loopGuard }),
    });
  }
  return result;
}

export function createJuncoAgent(
  spec: AgentSpec,
  ladder: ModelLadder,
): Promise<YamlAgent> {
  const { provider, modelId, thinking } = resolveRung(
    ladder.rungs,
    DEFAULT_MODEL_STRENGTH,
  );
  return agent.JuncoAgent.create({
    provider,
    model: modelId,
    models: ladder.models,
    thinkingLevel: thinking,
    systemPrompt: spec.systemPrompt,
    cwd: spec.cwd,
    tools: spec.tools,
    toolSource: spec.toolSource,
    tool_block: spec.tool_block,
    collection: spec.collection,
    recorder: spec.recorder,
    recorderNodeId: spec.recorderNodeId,
    loopGuard: spec.loopGuard,
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
        edge.on === "return"
          ? graph.Edge.returned(id, edge.schema, probe)
          : edge.kind === "message"
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
      trigger: resolveTrigger(spec, "$source", edges, spec.source?.trigger ?? "always"),
      schema: domain(
        Object.values(routes ?? {})
          .flat()
          .map((target) => edgeOf(edges, target)),
      ),
    },
  );
}

function createSink(
  spec: GraphSpec,
  edges: ReadonlyMap<string, Edge>,
  parentOutputs: readonly Edge[],
  root: boolean,
  result: (id: string) => O.Option<unknown>,
): graph.Sink<TSchema, unknown> {
  const options = {
    id: graph.NodeId.create("$sink"),
    description: spec.sink?.description,
    trigger: resolveTrigger(spec, "$sink", edges, spec.sink?.trigger),
  };
  if (spec.sink?.stream === true) {
    const inbound = inboundEdges(spec, "$sink").map((e) =>
      edgeOf(edges, edgeId(e)),
    );
    // Forward every delivered message, never returning: nested onto each parent output, root under its own edge.
    return new graph.Sink<TSchema, unknown>(
      async function* (): graph.NodeGenerator<TSchema, unknown> {
        let view = yield [];
        while (true)
          view = yield inbound.flatMap((edge) =>
            graph
              .from(view, edge)
              .flatMap((payload) =>
                (root ? [edge] : parentOutputs).map((target) =>
                  graph.Message.create(target, payload),
                ),
              ),
          );
      },
      { ...options, schema: domain(root ? inbound : parentOutputs) },
    );
  }
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
    { ...options, schema: domain(parentOutputs) },
  );
}

function registerEmit(
  g: JuncoGraph<TSchema, unknown>,
  registration: Registration,
  task: { readonly text: string; readonly spec: string },
  outbound: readonly Edge[],
): void {
  const state = new Deterministic<TSchema, unknown>(async function* (
    signal,
  ): graph.NodeGenerator<TSchema, unknown> {
    signal.throwIfAborted();
    // One task, broadcast on every outbound edge.
    const payload = agent.Task.create({
      kind: "prompt",
      text: task.text,
      spec: task.spec,
    });
    return new graph.FinalMessages(
      outbound.map((edge) => graph.Message.create(edge, payload)),
    );
  }, tools.EmptyPolicy);
  g.addNode({ ...registration, state });
}

async function registerAgent(
  c: Construction,
  g: JuncoGraph<TSchema, unknown>,
  spec: GraphSpec,
  id: string,
  node: Extract<NodeSpec, { kind?: "agent" }>,
  registration: Registration,
  key: string,
): Promise<void> {
  const { prompt, promptReturnEdges } = compilePrompt(
    node.prompt, id, inboundEdges(spec, id),
  );
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
      const created = await createJuncoAgent(spec, ladder);
      c.acquired.push(created);
      instance = created;
    }
  }
  const registered = g.addNode({
    ...registration,
    prompt,
    state: instance,
    policy: c.policy,
  });
  // Until commit, rollback disposes acquired agents itself; factory agents stay borrowed.
  const step = g.getNode(registered)?.step;
  const policy = step && nodePolicies.get(step);
  if (policy === undefined)
    throw new agent.JuncoAgentError(
      "invalid_state",
      `Node "${id}" has no policy`,
    );
  if (promptReturnEdges.size) policy.promptReturnEdges = promptReturnEdges;
  policy.agentOwnership = "caller";
  c.borrowed.push(policy);
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
  const source = createSource(spec, label, edges);
  const sink = createSink(
    spec,
    edges,
    parentOutputs,
    path === "",
    (id) => g.result(graph.NodeId.create(id)),
  );
  // The document validator checked these dynamic integers; Width.create only accepts numeric literals.
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
  const execution = context({
    scheduler: c.options.scheduler(label, path),
    graph: g,
    measurementWindows: c.options.measurementWindows,
    ...(c.options.ladder === undefined
      ? {}
      : { ladder: c.options.ladder.rungs }),
  });
  for (const [id, node] of Object.entries(spec.nodes)) {
    c.options.signal?.throwIfAborted();
    const outbound = outboundEdges(spec, id)
      .filter((e) => e.kind === "message" && e.on !== "return")
      .map((e) => edgeOf(edges, edgeId(e)));
    const key = path === "" ? id : `${path}/${id}`;
    const registration: Registration = {
      id: graph.NodeId.create(id),
      description: node.description,
      repeat: node.repeat,
      trigger: resolveTrigger(spec, id, edges, node.trigger),
    };
    if (node.kind === "emit") {
      registerEmit(g, registration, node, outbound);
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
        state: child,
        ...(node.graph.sink?.stream === true
          ? { persistent: true as const }
          : {}),
      });
      c.partialRoots.delete(child.graph);
    } else if (node.kind === "code") {
      const definition = c.options.code?.[id];
      if (definition === undefined)
        throw new graph.DataflowDefinitionError(
          `junco-syntax: code node "${id}" has no definition in options.code`,
        );
      const state: unknown = await definition({
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
      if (!(state instanceof Deterministic)) {
        // The old factory shape may already have acquired a collection lease.
        const unregistered =
          typeof state === "object" && state !== null && "state" in state ? state.state : undefined;
        if (unregistered instanceof Deterministic) c.acquired.push(unregistered);
        throw new graph.DataflowDefinitionError(
          `junco-syntax: code node "${key}" must return a Deterministic directly; declare its admission with trigger`,
        );
      }
      c.acquired.push(state);
      g.addNode({ ...registration, state });
      c.acquired.pop(); // Registered: its graph now owns cleanup.
    } else {
      await registerAgent(c, g, spec, id, node, registration, key);
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
      await instance[Symbol.asyncDispose]();
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
 * nothing) or a normally completed assistant result. Other payloads are read through code.
 */
function render(payload: unknown, id: string): string {
  if (Value.Check(agent.TaskSchema, payload))
    return "text" in payload ? payload.text : "";
  if (Value.Check(agent.AssistantMessageSchema, payload))
    return finalText(payload, id);
  throw new TypeError(
    `Prompt placeholder {{${id}}} renders only Task or AssistantMessage payloads; read edge "${id}" with a code node`,
  );
}

function compilePrompt(text: string, node: string, inbound: readonly EdgeSpec[]) {
  const parts = text.split(PLACEHOLDER);
  const head = parts[0]!;
  const promptReturnEdges = new Set<string>();
  if (parts.length === 1) return { prompt: head, promptReturnEdges };
  const substitutions: { key: graph.EdgeIdType; returned: boolean; tail: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i]!;
    const edge = inbound.find((candidate) => edgeId(candidate) === id);
    if (!edge || (edge.kind === "message" && edge.on !== "return"))
      throw new graph.DataflowDefinitionError(
        `junco-syntax: prompt placeholder {{${id}}} of node "${node}" names message edge "${id}"; placeholders require a value or on: return edge`,
      );
    const returned = edge.on === "return";
    if (returned) promptReturnEdges.add(id);
    substitutions.push({ key: graph.EdgeId.create(id), returned, tail: parts[i + 1]! });
  }
  const prompt = (inputs: graph.ParentView<TSchema, unknown>): string => {
    let rendered = head;
    for (const { key, returned, tail } of substitutions) {
      if (returned)
        rendered += inputs.messages.get(key)?.map((payload) => render(payload, key)).join("\n\n") ?? "";
      else if (inputs.values.has(key))
        rendered += render(inputs.values.get(key), key);
      rendered += tail;
    }
    return rendered;
  };
  return { prompt, promptReturnEdges };
}

const codeIds = (spec: GraphSpec) =>
  [...walk(spec)].flatMap(({ id, node }) => (node.kind === "code" ? [id] : []));

/** Per-build state shared by every graph level; agents/graphs here are released on failure. */
type Construction = {
  readonly options: BuildOptions;
  readonly policy: tools.Policy;
  readonly collection: tools.ToolCollection | undefined;
  readonly specs: Iterator<AgentSpec>;
  readonly agents: ReadonlyMap<string, YamlAgent> | undefined;
  /** Owned agents in acquisition order, plus any code state not yet adopted by a graph. */
  readonly acquired: AsyncDisposable[];
  /** Graphs not yet adopted by a parent. */
  readonly partialRoots: Set<JuncoGraph<TSchema, unknown>>;
  /** Graphs borrow registered agents until the build commits. */
  readonly borrowed: NodePolicy[];
};
type Registration = {
  readonly id: graph.NodeIdType;
  readonly description: string | undefined;
  readonly repeat?: number;
  readonly trigger: graph.TriggerRule<TSchema, unknown>;
};

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
  let policy: tools.Policy;
  try {
    if ("available" in options)
      throw new graph.DataflowDefinitionError(
        "junco-syntax: available is no longer supported; declare admission with trigger",
      );
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
    if (!creates && options.tool_pruning !== undefined)
      throw new graph.DataflowDefinitionError(
        "junco-syntax: tool_pruning applies to the collection build creates; open the supplied collection with { tool_pruning: true } instead",
      );
    for (const id of codeIds(doc.graph))
      if (options.code?.[id] === undefined)
        throw new graph.DataflowDefinitionError(
          `junco-syntax: code node "${id}" has no definition in options.code`,
        );
    if (
      hasAgents(doc.graph) &&
      !agents &&
      options.createAgent === undefined &&
      options.ladder === undefined
    )
      throw new graph.DataflowDefinitionError(
        "junco-syntax: a ladder is required to create agents; pass ladder or createAgent",
      );
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
        ...((options.measurementWindows?.get("memory") ?? 0) > 0
          ? { measureMemory: true }
          : {}),
        ...(options.onResourceEvent
          ? { onResourceEvent: options.onResourceEvent }
          : {}),
        ...(options.tool_pruning ? { tool_pruning: true } : {}),
      },
      construct,
    );
  return construct(options.collection);
}
