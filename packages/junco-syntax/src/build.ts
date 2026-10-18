import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
export type BuildOptions = {
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

export async function resolveAgents(
  doc: JuncoDocument,
  options: Pick<BuildOptions, "cwd" | "tools" | "collection">,
): Promise<readonly AgentSpec[]> {
  const definitions = new Map<string, mcp.JuncoMcpTools>();
  const loaded = new Map<string, Skill>();
  const result: AgentSpec[] = [];
  async function skill(name: string): Promise<Skill> {
    const cached = loaded.get(name);
    if (cached) return cached;
    const path = resolve(options.cwd, doc.skills![name]!);
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
    const value: Skill = {
      name: entry.name,
      description: entry.description,
      content: await readFile(path, "utf8"),
      filePath: entry.filePath,
      disableModelInvocation: entry.disableModelInvocation,
    };
    loaded.set(name, value);
    return value;
  }
  async function visit(spec: GraphSpec, label: string): Promise<void> {
    for (const [id, node] of Object.entries(spec.nodes)) {
      if (node.kind === "graph") {
        await visit(node.graph, node.graph.name ?? id);
        continue;
      }
      if (node.kind === "emit") continue;
      const skills: Skill[] = [];
      for (const name of node.skills ?? []) skills.push(await skill(name));
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
          const { timeout, ...server } = doc.mcp![name]!;
          definition = mcp.JuncoMcpTools.add({
            ...server,
            name,
            type: "stdio",
            ...(timeout === undefined
              ? {}
              : { clientOptions: { requestTimeoutMs: timeout } }),
          });
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
        tools: [
          new tools.YieldTool(),
          new tools.InfoTool(),
          new tools.SendTool(),
          new tools.RecvTool(),
          new tools.TaskTool(),
          ...extra,
          ...servers,
        ],
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

export async function build(
  doc: JuncoDocument,
  options: BuildOptions,
): Promise<Execution> {
  const policy = options.policy ?? tools.LockPolicy;
  function hasAgents(spec: GraphSpec): boolean {
    return Object.values(spec.nodes).some((node) =>
      node.kind === "graph" ? hasAgents(node.graph) : node.kind !== "emit",
    );
  }
  async function construct(
    collection?: tools.ToolCollection,
  ): Promise<Execution> {
    const acquired: agent.JuncoAgent[] = [];
    try {
      const specs = (await resolveAgents(doc, { ...options, collection }))[
        Symbol.iterator
      ]();
      async function buildGraph(
        spec: GraphSpec,
        label: string,
        observer: tracer.DataflowTracer | undefined,
        parentOutputs: Edge[],
      ): Promise<Execution> {
        options.signal?.throwIfAborted();
        const edges = new Map(
          (spec.edges ?? []).map((edge) => [
            edgeId(edge),
            edge.kind === "message"
              ? graph.Edge.message<AgenticInput, AssistantMessage>(edgeId(edge))
              : graph.Edge.value<AgenticInput, AssistantMessage>(edgeId(edge)),
          ]),
        );
        const source = new graph.nodes.Source<AgenticInput, AssistantMessage>(
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
                messages.push(
                  graph.Message.create(edges.get(target)!, payload),
                );
            }
            for (const id of view.messages.keys())
              for (const payload of view.messages.get(id) ?? [])
                forward(id, payload);
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
        const returns =
          spec.sink?.returns ?? inboundEdges(spec, "$sink")[0]!.from;
        let sinkHook:
          | graph.AvailabilityFn<AgenticInput, AssistantMessage>
          | undefined;
        const sink: graph.nodes.Sink<AgenticInput, AssistantMessage> =
          new graph.nodes.Sink<AgenticInput, AssistantMessage>(
            async function* (
              port,
            ): graph.NodeGenerator<AgenticInput, AssistantMessage> {
              yield [];
              const r = g.result(graph.NodeId.create(returns));
              if (O.isNone(r))
                throw new Error(`${returns} did not produce a result`);
              if (parentOutputs.length) {
                const text = finalText(r.value, returns);
                for (const edge of parentOutputs)
                  port.send(
                    graph.Message.create(edge, { kind: "prompt", text }),
                  );
              }
              return r.value;
            },
            {
              id: graph.NodeId.create("$sink"),
              description: spec.sink?.description,
              trigger: resolveTrigger(spec, "$sink", spec.sink?.trigger),
              ...(options.available?.$sink
                ? { is_available: (v, t) => sinkHook!(v, t) }
                : {}),
            },
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
          policy,
          collection,
        );
        const hook = (id: string) =>
          options.available?.[id]?.({ graph: g, edges });
        sinkHook = hook("$sink");
        const execution = schedulers.context({
          scheduler: options.scheduler(label),
          graph: g,
        });
        for (const [id, node] of Object.entries(spec.nodes)) {
          options.signal?.throwIfAborted();
          const outbound = outboundEdges(spec, id)
            .filter((e) => e.kind === "message")
            .map((e) => edges.get(edgeId(e))!);
          const is_available = hook(id);
          const registration = {
            id: graph.NodeId.create(id),
            description: node.description,
            ...(is_available ? { is_available } : {}),
          };
          if (node.kind === "emit") {
            let published = false;
            const state = new Deterministic<AgenticInput, AssistantMessage>(
              async function* (
                signal,
              ): graph.NodeGenerator<AgenticInput, AssistantMessage> {
                const payload = { kind: "prompt", text: node.text } as const;
                while (true) {
                  signal.throwIfAborted();
                  published = true;
                  yield outbound.map((edge) =>
                    graph.Message.create(edge, payload),
                  );
                }
              },
              tools.EmptyPolicy,
            );
            g.addNode({
              ...registration,
              trigger: graph.trigger.TriggerRule.always(),
              is_available: is_available ?? (() => !published),
              state,
            });
          } else if (node.kind === "graph") {
            const child = await buildGraph(
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
          } else {
            const resolved = specs.next().value!;
            const instance = options.createAgent
              ? await options.createAgent(resolved)
              : await createJuncoAgent(resolved, options.models);
            if (!options.createAgent)
              acquired.push(instance as agent.JuncoAgent);
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
                policy,
              });
              if (is_available)
                Object.assign(g.getNode(registered)!, { is_available });
            } else
              g.addNode({
                ...registration,
                trigger: resolveTrigger(spec, id, node.trigger),
                state: instance,
                policy,
                ...(contract ? { contract } : {}),
              });
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
      return await buildGraph(
        doc.graph,
        doc.graph.name ?? "graph",
        options.tracer,
        [],
      );
    } catch (error) {
      const failures: unknown[] = [];
      for (const instance of acquired.reverse()) {
        try {
          await instance.return();
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "build failed and agent cleanup failed",
        );
      throw error;
    }
  }
  if (!options.collection && !options.createAgent && hasAgents(doc.graph))
    return JuncoGraph.create(options.cwd, { policy }, construct);
  return construct(options.collection);
}
