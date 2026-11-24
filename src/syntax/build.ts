import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type AgentTool,
  BACKGROUND_CONTEXT,
  formatSkillsForSystemPrompt,
  type PromptTemplate,
  type Session,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import * as graph from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import * as agent from "junco-agent";
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
import { checkRecorder, JuncoGraph } from "../junco-graph.js";
import {
  type AgencyNodeMetadata,
  checkPolicy,
  context,
  type ModelLadder,
  nodePolicies,
  resolveRung,
} from "../node-policy.js";
import type * as tracer from "../std/tracer.js";
import { ValidationError } from "./errors.js";
import { parse, type ParseOptions } from "./parse.js";
import { JuncoGraphValidator } from "./validator.js";
import {
  edgeId,
  type EdgeSpec,
  type GraphSpec,
  inboundEdges,
  type JuncoDocument,
  type NodeSpec,
  nodeKey,
  outboundEdges,
  PLACEHOLDER,
  resolveTrigger,
  walk,
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
type CreateOptions = agent.JuncoAgentCreateOptions<Skill, PromptTemplate, AgentTool, TSchema, unknown>;
const constructorFields = [
  "session", "activeToolNames", "streamOptions", "retry", "compaction", "steeringMode",
  "followUpMode", "toProviderMessages", "entryProjectors", "errorHandler", "tokenMonitor",
  "loopGuard", "toolSource",
] as const satisfies readonly (keyof CreateOptions)[];
const allowedOptions = new Set<string>([...constructorFields, "images", "resources"]);

/** Per-node harness settings; model, placement, permissions and instruction belong to the workflow. */
export type YamlAgentOptions = Pick<CreateOptions, typeof constructorFields[number] | "images"> & {
  readonly resources?: Pick<NonNullable<CreateOptions["resources"]>, "promptTemplates">;
};
export type AgentSpec = {
  /** The enclosing graph's display label; labels may repeat across nested graphs. */
  readonly graph: string;
  /** The agent's local node ID within its enclosing graph. */
  readonly node: string;
  /** The agent's unique root-relative node path: `Worker`, `Child/Worker`, `Child/Grandchild/Worker`. */
  readonly path: graph.NodeIdType;
  readonly systemPrompt?: string;
  readonly tool_block?: readonly string[];
  readonly toolSource?: string;
  readonly skills: Skill[];
  readonly cwd: string;
  readonly collection?: tools.ToolCollection;
  /** Recorder view scoped to this agent. */
  readonly recorder?: tools.ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >;
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
  /** Current recorder view scoped to this code node. */
  readonly recorder?: tools.ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >;
  readonly context: C;
  readonly signal?: AbortSignal;
};
/** Definition keyed by the code node's id in the workflow config. */
export type DeterministicNode<C = unknown> = (
  context: CodeContext<C>,
) => Deterministic<TSchema, unknown> | Promise<Deterministic<TSchema, unknown>>;
/** Program inputs and capabilities supplied to a YAML workflow. */
export type JuncoArgs<C = unknown> = ParseOptions & {
  readonly cwd: string;
  readonly policy?: tools.Policy;
  readonly collection?: tools.ToolCollection;
  /** Code-node definitions by node id, exported by the same-named workflow module. */
  readonly code?: Readonly<Record<string, DeterministicNode<C>>>;
  readonly tracer?: tracer.DataflowTracer;
  /** Recorder view for the root graph and builder-created collection; independent of `tracer`. */
  readonly recorder?: tools.ProfileRecorder<
    "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
  >;
  /** Borrowed collections by qualified agent ID. Missing entries use the graph-wide fallback. */
  readonly tools?: ReadonlyMap<graph.NodeIdType, tools.ToolCollection>;
  /** A supplied session transfers to the graph at entry, including on parse or preflight failure. */
  readonly agentOptions?: ReadonlyMap<graph.NodeIdType, YamlAgentOptions>;
  /** Display-ready declaration module path for selected tool registrations. */
  readonly toolSource?: string;
  readonly context?: C;
  readonly signal?: AbortSignal;
};
/** Execution settings that may vary between runs of the same program. */
export type JuncoParameters = {
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
  /** Runtime and model rungs; required if any graph level declares an agent. */
  readonly ladder?: ModelLadder;
  /** Limits/monitoring of the native fallback collection, when this build creates one. */
  readonly resources?: tools.NativeResourceOptions;
  /** Monitor callback; pair with resources.monitorIntervalMs. Recorders take `recorder` instead. */
  readonly onResourceEvent?: (event: tools.NativeResourceEvent) => void;
  /** `tool_pruning` of the collection build creates; rejected with a supplied collection, like `resources`. */
  readonly tool_pruning?: boolean;
  /** Default failure-loop guard for agents without a node override. */
  readonly loopGuard?: agent.LoopGuard;
  /**
   * Samples retained per node and resource at each graph level; zero or omitted means none.
   * For native memory on a caller-owned collection, open it with `measureMemory: true`.
   */
  readonly measurementWindows?: ReadonlyMap<graph.ResourceKind, number>;
};

export type FromYamlOptions<C = unknown> = {
  readonly args: JuncoArgs<C>;
  readonly parameters: JuncoParameters;
};

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

export async function resolveAgents(
  doc: JuncoDocument,
  options: Pick<JuncoArgs, "cwd" | "tools" | "collection" | "toolSource"> & Pick<JuncoParameters, "loopGuard">,
): Promise<readonly AgentSpec[]> {
  const loaded = new Map<string, Skill>();
  const result: AgentSpec[] = [];
  for (const { id, node, key, label } of walk(doc.graph)) {
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
      ...(node.tool_block === undefined ? {} : { tool_block: node.tool_block }),
      skills,
      cwd: options.cwd,
      collection: options.tools?.get(key) ?? options.collection,
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
  init: Omit<YamlAgentOptions, "images"> = {},
): Promise<YamlAgent> {
  const { provider, modelId, thinking } = resolveRung(
    ladder.rungs,
    DEFAULT_MODEL_STRENGTH,
  );
  return agent.JuncoAgent.create({
    ...Object.fromEntries(constructorFields.filter((key) => Object.hasOwn(init, key)).map((key) => [key, init[key]])),
    provider,
    model: modelId,
    models: ladder.models,
    thinkingLevel: thinking,
    systemPrompt: spec.systemPrompt,
    cwd: spec.cwd,
    toolSource: init.toolSource ?? spec.toolSource,
    tool_block: spec.tool_block,
    collection: spec.collection,
    recorder: spec.recorder,
    loopGuard: init.loopGuard ?? spec.loopGuard,
    resources: { skills: spec.skills, promptTemplates: init.resources?.promptTemplates },
  });
}

const isAgent = (
  node: NodeSpec,
): node is Extract<NodeSpec, { kind?: "agent" }> =>
  node.kind !== "graph" && node.kind !== "emit" && node.kind !== "code";

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
  recorder: (() => JuncoArgs["recorder"]) | undefined,
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

async function registerAgent<C>(
  c: Construction<C>,
  g: JuncoGraph<TSchema, unknown>,
  spec: GraphSpec,
  id: string,
  node: Extract<NodeSpec, { kind?: "agent" }>,
  registration: Registration,
  key: graph.NodeIdType,
): Promise<void> {
  const compiled = node.prompt === undefined ? undefined : compilePrompt(node.prompt, id, inboundEdges(spec, id));
  const specForNode = c.specs.get(key)!;
  const init = c.agentOptions.get(key);
  const creating = createJuncoAgent({
    ...specForNode, collection: specForNode.collection ?? c.collection, recorder: g.recorder?.add_context(id),
  }, c.parameters.ladder!, init);
  if (init?.session !== undefined) c.sessions.delete(init.session);
  const instance = await creating;
  c.acquired.push(instance);
  c.args.signal?.throwIfAborted();
  if (compiled) instance.stagePrompt(compiled.prompt, { images: init?.images });
  const registered = g.addNode({
    ...registration,
    prompt: compiled?.prompt,
    state: instance,
    policy: c.policy,
  });
  c.acquired.pop(); // The graph, not rollback's unregistered list, now owns the agent.
  const step = g.getNode(registered)?.step;
  const policy = step && nodePolicies.get(step);
  if (policy === undefined)
    throw new agent.JuncoAgentError(
      "invalid_state",
      `Node "${id}" has no policy`,
    );
  if (compiled) policy.promptReturnEdges = compiled.promptReturnEdges;
}

async function buildGraph<C>(
  c: Construction<C>,
  spec: GraphSpec,
  label: string,
  observer: tracer.DataflowTracer | undefined,
  parentOutputs: readonly Edge[],
  path: string,
  recorder: JuncoArgs["recorder"],
): Promise<Execution> {
  c.args.signal?.throwIfAborted();
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
  );
  c.partialRoots.add(g);
  const execution = context({
    scheduler: c.parameters.scheduler(label, path),
    graph: g,
    measurementWindows: c.parameters.measurementWindows,
    ...(c.parameters.ladder === undefined
      ? {}
      : { ladder: c.parameters.ladder.rungs }),
  });
  for (const [id, node] of Object.entries(spec.nodes)) {
    c.args.signal?.throwIfAborted();
    const outbound = outboundEdges(spec, id)
      .filter((e) => e.kind === "message" && e.on !== "return")
      .map((e) => edgeOf(edges, edgeId(e)));
    const key = nodeKey(path, id);
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
        g.recorder?.add_context(id),
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
      const definition = c.args.code?.[id];
      if (definition === undefined)
        throw new graph.DataflowDefinitionError(
          `junco-syntax: code node "${id}" has no definition in args.code`,
        );
      const state: unknown = await definition({
        graph: g,
        label,
        node: id,
        edges,
        policy: c.policy,
        collection: c.collection,
        get recorder() { return g.recorder?.add_context(id); },
        context: c.args.context!,
        signal: c.args.signal,
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
  c: Pick<Construction<unknown>, "acquired" | "partialRoots" | "sessions">,
  creator: tools.ToolCollection | undefined,
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
  for (const session of c.sessions) {
    try {
      await session.close(BACKGROUND_CONTEXT);
    } catch (failure) {
      failures.push(failure);
    }
  }
  try {
    await creator?.close();
  } catch (failure) {
    failures.push(failure);
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

/** Per-build state shared by every graph level; agents/graphs here are released on failure. */
type Construction<C> = FromYamlOptions<C> & {
  readonly policy: tools.Policy;
  readonly collection: tools.ToolCollection | undefined;
  readonly specs: ReadonlyMap<graph.NodeIdType, AgentSpec>;
  readonly agentOptions: ReadonlyMap<graph.NodeIdType, YamlAgentOptions>;
  readonly sessions: Set<Session>;
  /** Code or agent states not yet registered with a graph. */
  readonly acquired: AsyncDisposable[];
  /** Graphs not yet adopted by a parent. */
  readonly partialRoots: Set<JuncoGraph<TSchema, unknown>>;
};
type Registration = {
  readonly id: graph.NodeIdType;
  readonly description: string | undefined;
  readonly repeat?: number;
  readonly trigger: graph.TriggerRule<TSchema, unknown>;
};

export function build<C = unknown>(
  doc: JuncoDocument,
  config: FromYamlOptions<C>,
): Promise<Execution> {
  return construct(config, () => doc);
}

export function buildYaml<C>(source: string | object, config: FromYamlOptions<C>): Promise<Execution> {
  return construct(config, (args) => parse(source, args));
}

async function construct<C>(
  config: FromYamlOptions<C>,
  document: (args: JuncoArgs<C>) => JuncoDocument,
): Promise<Execution> {
  const sessions = new Set<Session>();
  const acquired: AsyncDisposable[] = [];
  const partialRoots = new Set<JuncoGraph<TSchema, unknown>>();
  let created: tools.ToolCollection | undefined;
  try {
    const args = config?.args;
    let duplicate = false;
    for (const init of args?.agentOptions?.values?.() ?? []) {
      const session = init?.session;
      if (session === undefined) continue;
      if (sessions.has(session)) duplicate = true;
      sessions.add(session);
    }
    const parameters = config?.parameters;
    if (!args || typeof args !== "object" || Array.isArray(args) ||
      !parameters || typeof parameters !== "object" || Array.isArray(parameters))
      throw new graph.DataflowDefinitionError("junco-syntax: fromYaml requires { args, parameters }");
    if (duplicate)
      throw new graph.DataflowDefinitionError("junco-syntax: cannot assign the same session to multiple agent paths");
    args.signal?.throwIfAborted();
    for (const name of ["agents", "createAgent", "createAgentOwnership"])
      if (name in args)
        throw new graph.DataflowDefinitionError(`junco-syntax: ${name} is no longer supported; YAML owns its agents`);
    const doc = document(args);
    if ("available" in config || "available" in args || "available" in parameters)
      throw new graph.DataflowDefinitionError(
        "junco-syntax: available is no longer supported; declare admission with trigger",
      );
    const maps = {
      ...(args.tools === undefined ? {} : { tools: { map: args.tools } }),
      ...(args.agentOptions === undefined ? {} : { agentOptions: { map: args.agentOptions } }),
    };
    if (args.tools !== undefined || args.agentOptions !== undefined)
      JuncoGraphValidator.validateNodeMaps(doc, maps);
    const policy = args.policy ?? tools.LockPolicy;
    checkPolicy(policy, args.collection);
    checkRecorder(args.recorder, args.collection?.recorder);
    const members = new Map<graph.NodeIdType, Extract<NodeSpec, { kind?: "agent" }>>();
    for (const { id, node, key } of walk(doc.graph)) {
      if (isAgent(node)) members.set(key, node);
      else if (node.kind === "code" && args.code?.[id] === undefined)
        throw new graph.DataflowDefinitionError(`junco-syntax: code node "${id}" has no definition in args.code`);
    }
    for (const [name, { map }] of Object.entries(maps))
      for (const key of map.keys())
        if (!members.has(key))
          throw new ValidationError({ code: "node-map", path: `/options/${name}`,
            message: `"${key}" is not an agent`, help: "configure only agent node paths" });
    for (const [key, collection] of args.tools ?? []) {
      if (!(collection instanceof tools.ToolCollection))
        throw new TypeError(`junco-syntax: tools for "${key}" must be a ToolCollection`);
      checkPolicy(policy, collection);
      checkRecorder(args.recorder, collection.recorder);
    }
    const agentOptions = new Map<graph.NodeIdType, YamlAgentOptions>();
    for (const [key, init] of args.agentOptions ?? []) {
      if (typeof init !== "object" || init === null || Array.isArray(init))
        throw new TypeError(`junco-syntax: agentOptions for "${key}" must be an object`);
      for (const field of Object.keys(init))
        if (!allowedOptions.has(field))
          throw new TypeError(`junco-syntax: unsupported agentOptions field "${field}" for "${key}"`);
      if (init.resources !== undefined && (init.resources === null || typeof init.resources !== "object" ||
        Array.isArray(init.resources) || Object.keys(init.resources).some((field) => field !== "promptTemplates")))
        throw new TypeError(`junco-syntax: only resources.promptTemplates may be configured for "${key}"`);
      if (init.images?.length && members.get(key)?.prompt === undefined)
        throw new TypeError(`junco-syntax: images for "${key}" require a YAML prompt`);
      agentOptions.set(key, { ...init, session: init.session });
    }
    if (members.size && parameters.ladder === undefined)
      throw new graph.DataflowDefinitionError("junco-syntax: a ladder is required for agent nodes");
    const creates = args.collection === undefined && members.size > (args.tools?.size ?? 0);
    if (
      !creates &&
      (parameters.resources !== undefined || parameters.onResourceEvent !== undefined)
    )
      throw new graph.DataflowDefinitionError(
        "junco-syntax: resources and onResourceEvent apply to the collection build creates; open the supplied collection with them instead",
      );
    if (!creates && parameters.tool_pruning !== undefined)
      throw new graph.DataflowDefinitionError(
        "junco-syntax: tool_pruning applies to the collection build creates; open the supplied collection with { tool_pruning: true } instead",
      );
    // Skill loading can suspend; retain the grants we just checked, not a caller's mutable Map.
    const mapped = args.tools === undefined ? undefined : new Map(args.tools);
    const specs = new Map((await resolveAgents(doc, {
      cwd: args.cwd, tools: mapped, collection: args.collection, toolSource: args.toolSource,
      loopGuard: parameters.loopGuard,
    })).map((spec) => [spec.path, spec]));
    args.signal?.throwIfAborted();
    if (creates)
      created = await tools.ToolCollection.create(args.cwd, {
        policy, recorder: args.recorder, resources: parameters.resources,
        onResourceEvent: parameters.onResourceEvent, tool_pruning: parameters.tool_pruning,
        measureMemory: (parameters.measurementWindows?.get("memory") ?? 0) > 0,
      });
    const c: Construction<C> = {
      args, parameters, policy, collection: args.collection ?? created,
      specs, agentOptions, sessions, acquired, partialRoots,
    };
    const execution = await buildGraph(c, doc.graph, doc.graph.name ?? "graph", args.tracer, [], "", args.recorder);
    args.signal?.throwIfAborted();
    // This fallback has no extension; graph leases and agent bindings now hold it.
    const creator = created;
    created = undefined;
    await creator?.close();
    return execution;
  } catch (error) {
    return rollback({ acquired, partialRoots, sessions }, created, error);
  }
}
