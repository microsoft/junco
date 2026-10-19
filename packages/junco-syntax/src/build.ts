import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AgentTool,
  formatSkillsForSystemPrompt,
  type Skill,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  contentText,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  loadSkillsFromDir,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import * as O from "fp-ts/lib/Option.js";
import {
  type Agentic,
  type AgenticInput,
  agent,
  Deterministic,
  graph,
  JuncoGraph,
  type MockAgent,
  mcp,
  schedulers,
  tools,
  type tracer,
} from "junco-agency";
import { Ralph } from "junco-agency/workflows";
import {
  edgeId,
  inboundEdges,
  outboundEdges,
  PLACEHOLDER,
  resolveTrigger,
} from "./parse.js";
import {
  BUILTIN_TOOL_NAMES,
  type GraphSpec,
  type JuncoDocument,
  type NodeSpec,
} from "./schema.js";

type Edge = graph.Edge<AgenticInput, AssistantMessage>;
type Execution = schedulers.SchedulerContext<
  Agentic,
  AgenticInput,
  AssistantMessage,
  schedulers.AgencyNodeMetadata,
  JuncoGraph
>;
export type AgentSpec = {
  readonly graph: string;
  readonly node: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly systemPrompt?: string;
  readonly tools: (AgentTool | mcp.JuncoMcpTools)[];
  readonly skills: Skill[];
  readonly cwd: string;
  readonly collection?: tools.ToolCollection;
};
/** What a `kind: code` definition sees when its node is registered. */
export type CodeContext<C = unknown> = {
  readonly graph: JuncoGraph;
  readonly label: string;
  readonly node: string;
  readonly edges: ReadonlyMap<string, Edge>;
  readonly policy: tools.Policy;
  readonly collection?: tools.ToolCollection;
  readonly context: C;
  readonly signal?: AbortSignal;
};
export type CodeRegistration = {
  readonly state: Deterministic<AgenticInput, AssistantMessage>;
  readonly is_available?: graph.AvailabilityFn<AgenticInput, AssistantMessage>;
  readonly contract?: (edgeId: graph.EdgeIdType) => { expect: string };
};
/** Module export named by a `code:` registry key; backs every `kind: code` node using it. */
export interface DeterministicNode<C = unknown> {
  create(context: CodeContext<C>): CodeRegistration | Promise<CodeRegistration>;
}
export type BuildOptions<C = unknown> = {
  readonly cwd: string;
  readonly scheduler: (
    graph: string,
  ) => schedulers.Scheduler<
    Agentic,
    AgenticInput,
    AssistantMessage,
    schedulers.AgencyNodeMetadata
  >;
  readonly policy?: tools.Policy;
  readonly collection?: tools.ToolCollection;
  readonly models?: ModelRuntime;
  readonly tracer?: tracer.DataflowTracer;
  readonly tools?: Readonly<Record<string, AgentTool>>;
  readonly createAgent?: (
    spec: AgentSpec,
  ) => Promise<agent.JuncoAgent | MockAgent>;
  readonly available?: Readonly<
    Record<
      string,
      (context: {
        graph: JuncoGraph;
        edges: ReadonlyMap<string, Edge>;
      }) => graph.AvailabilityFn<AgenticInput, AssistantMessage>
    >
  >;
  readonly context?: C;
  readonly signal?: AbortSignal;
};

function finalText(
  message: AssistantMessage | undefined,
  member: string,
): string {
  if (message?.stopReason !== "stop") {
    throw new Error(
      `${member} did not finish normally: ${message?.stopReason ?? "no final message"}`,
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
  async function visit(spec: GraphSpec, label: string): Promise<void> {
    for (const [id, node] of Object.entries(spec.nodes)) {
      if (node.kind === "graph") {
        await visit(node.graph, node.graph.name ?? id);
        continue;
      }
      if (node.kind === "emit" || node.kind === "code") continue;
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
      const slash = node.model.indexOf("/");
      result.push({
        graph: label,
        node: id,
        provider: node.model.slice(0, slash),
        model: node.model.slice(slash + 1),
        thinkingLevel: node.thinking,
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
  }
  await visit(doc.graph, doc.graph.name ?? "graph");
  return result;
}

export function createJuncoAgent(
  spec: AgentSpec,
  models?: ModelRuntime,
): Promise<agent.JuncoAgent> {
  return agent.JuncoAgent.create({
    provider: spec.provider,
    model: spec.model,
    models,
    thinkingLevel: spec.thinkingLevel,
    systemPrompt: spec.systemPrompt,
    cwd: spec.cwd,
    tools: spec.tools,
    collection: spec.collection,
    ...(spec.skills.length ? { resources: { skills: spec.skills } } : {}),
  });
}

function hasAgents(spec: GraphSpec): boolean {
  return Object.values(spec.nodes).some((node) =>
    node.kind === "graph"
      ? hasAgents(node.graph)
      : node.kind !== "emit" && node.kind !== "code",
  );
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
): graph.nodes.Source<AgenticInput, AssistantMessage> {
  return new graph.nodes.Source<AgenticInput, AssistantMessage>(
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
    },
  );
}

function createSink(
  spec: GraphSpec,
  parentOutputs: readonly Edge[],
  result: (id: string) => O.Option<AssistantMessage>,
  is_available: Available | undefined,
): graph.nodes.Sink<AgenticInput, AssistantMessage> {
  const returns = spec.sink?.returns ?? inboundEdges(spec, "$sink")[0]!.from;
  return new graph.nodes.Sink<AgenticInput, AssistantMessage>(
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
    trigger: graph.trigger.TriggerRule.always(),
    is_available: registration.is_available ?? (() => !published),
    state,
  });
}

async function registerAgent(
  c: Construction,
  g: JuncoGraph,
  spec: GraphSpec,
  id: string,
  node: Extract<NodeSpec, { model: string }>,
  registration: Registration,
  outbound: readonly Edge[],
  edges: ReadonlyMap<string, Edge>,
): Promise<void> {
  const resolved = c.specs.next().value!;
  const instance = c.options.createAgent
    ? await c.options.createAgent(resolved)
    : await createJuncoAgent(resolved, c.options.models);
  if (!c.options.createAgent) c.acquired.push(instance as agent.JuncoAgent);
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
  if (node.kind === "ralph") {
    if (!(instance instanceof agent.JuncoAgent))
      throw new TypeError("ralph node requires a JuncoAgent");
    const registered = Ralph.register(g, instance, {
      id: registration.id,
      description: node.description,
      input: edges.get(edgeId(inboundEdges(spec, id)[0]!))!,
      output: outbound[0]!,
      rounds: node.rounds,
      policy: c.policy,
    });
    const is_available = registration.is_available;
    if (is_available) Object.assign(g.getNode(registered)!, { is_available });
  } else
    g.addNode({
      ...registration,
      trigger: resolveTrigger(spec, id, node.trigger),
      state: instance,
      policy: c.policy,
      ...(contract ? { contract } : {}),
    });
}

async function buildGraph(
  c: Construction,
  spec: GraphSpec,
  label: string,
  observer: tracer.DataflowTracer | undefined,
  parentOutputs: readonly Edge[],
): Promise<Execution> {
  c.options.signal?.throwIfAborted();
  const edges = createEdges(spec);
  const source = createSource(spec, label, edges);
  let sinkHook: Available | undefined;
  const sink = createSink(
    spec,
    parentOutputs,
    (id) => g.result(graph.NodeId.create(id)),
    c.options.available?.$sink ? (v, t) => sinkHook!(v, t) : undefined,
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
  );
  if (c.options.createAgent === undefined) c.partialRoots.add(g);
  const hook = (id: string) => c.options.available?.[id]?.({ graph: g, edges });
  sinkHook = hook("$sink");
  const execution = schedulers.context({
    scheduler: c.options.scheduler(label),
    graph: g,
  });
  for (const [id, node] of Object.entries(spec.nodes)) {
    c.options.signal?.throwIfAborted();
    const outbound = outboundEdges(spec, id)
      .filter((e) => e.kind === "message")
      .map((e) => edges.get(edgeId(e))!);
    const is_available = hook(id);
    const registration: Registration = {
      id: graph.NodeId.create(id),
      description: node.description,
      ...(is_available ? { is_available } : {}),
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
      );
      g.addNode({
        ...registration,
        trigger: resolveTrigger(spec, id, node.trigger),
        state: child,
      });
      c.partialRoots.delete(child.graph);
    } else if (node.kind === "code") {
      const created = await c.code.get(node.name)!.create({
        graph: g,
        label,
        node: id,
        edges,
        policy: c.policy,
        collection: c.collection,
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
      await registerAgent(c, g, spec, id, node, registration, outbound, edges);
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

async function rollback(c: Construction, error: unknown): Promise<never> {
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

function codeNames(spec: GraphSpec, names: Set<string>): Set<string> {
  for (const node of Object.values(spec.nodes))
    if (node.kind === "graph") codeNames(node.graph, names);
    else if (node.kind === "code") names.add(node.name);
  return names;
}

async function resolveCode(
  doc: JuncoDocument,
  cwd: string,
): Promise<ReadonlyMap<string, DeterministicNode>> {
  const resolved = new Map<string, DeterministicNode>();
  for (const name of codeNames(doc.graph, new Set())) {
    const path = resolve(cwd, doc.code![name]!);
    let module: Record<string, unknown>;
    try {
      // Module path comes from the document's `code:` registry at runtime.
      module = await import(pathToFileURL(path).href);
    } catch (error) {
      throw new graph.DataflowDefinitionError(
        `junco-syntax: code "${name}": cannot import ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const definition = module[name];
    if (
      !definition ||
      typeof definition !== "object" ||
      !("create" in definition) ||
      typeof definition.create !== "function"
    )
      throw new graph.DataflowDefinitionError(
        `junco-syntax: code "${name}": ${path} has no DeterministicNode export "${name}"`,
      );
    // Shape checked above; the context type C is the document author's contract.
    const node: DeterministicNode = definition as DeterministicNode;
    resolved.set(name, node);
  }
  return resolved;
}

/** Per-build state shared by every graph level; agents/graphs here are released on failure. */
type Construction = {
  readonly options: BuildOptions;
  readonly code: ReadonlyMap<string, DeterministicNode>;
  readonly policy: tools.Policy;
  readonly collection: tools.ToolCollection | undefined;
  readonly specs: Iterator<AgentSpec>;
  /** Default-factory agents in acquisition order. */
  readonly acquired: agent.JuncoAgent[];
  /** Default-factory graphs not yet adopted by a parent. */
  readonly partialRoots: Set<JuncoGraph>;
};
type Registration = {
  readonly id: graph.NodeIdType;
  readonly description: string | undefined;
  readonly is_available?: graph.AvailabilityFn<AgenticInput, AssistantMessage>;
};
type Available = graph.AvailabilityFn<AgenticInput, AssistantMessage>;

export async function build<C = unknown>(
  doc: JuncoDocument,
  options: BuildOptions<C>,
): Promise<Execution> {
  const code = await resolveCode(doc, options.cwd);
  const policy = options.policy ?? tools.LockPolicy;
  const construct = async (
    collection?: tools.ToolCollection,
  ): Promise<Execution> => {
    const c: Construction = {
      options,
      code,
      policy,
      collection,
      specs: (await resolveAgents(doc, { ...options, collection }))[
        Symbol.iterator
      ](),
      acquired: [],
      partialRoots: new Set(),
    };
    try {
      return await buildGraph(
        c,
        doc.graph,
        doc.graph.name ?? "graph",
        options.tracer,
        [],
      );
    } catch (error) {
      return rollback(c, error);
    }
  };
  if (!options.collection && !options.createAgent && hasAgents(doc.graph))
    return JuncoGraph.create(options.cwd, { policy }, construct);
  return construct(options.collection);
}
