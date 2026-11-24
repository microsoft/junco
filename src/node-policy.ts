import type { ModelIdentity } from "@earendil-works/pi-agent-core";
import type { ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  DataflowTracer,
  EdgeIdType as EdgeId,
  InputSchedule,
  Lookup,
  Message,
  Node,
  NodeAvailability,
  NodeIdType,
  ResourceKind,
} from "dataflow-engine";
import {
  DataflowDefinitionError,
  holdsUsageFailure,
  messageInputs,
  triggerInputs,
} from "dataflow-engine";
import type {
  AgenticYieldReason,
  Agentic as AgentProtocol,
  JuncoAgentNodeContext,
} from "junco-agent";
import {
  MODEL_STRENGTHS,
  type ModelStrength,
  type ModelStrengthName,
  type Scheduler,
  type SchedulerContext,
  context as schedulerContext,
} from "junco-scheduler";
import type { ProfileRecorder, ToolCollection } from "junco-tools";
import type { TSchema } from "typebox";
import type { Agentic, AnyJuncoAgent, AnyMockAgent } from "./agentic.js";
import type { JuncoGraph } from "./junco-graph.js";

/** One rung: a "provider/model-id" and its reasoning effort (`"off"` when omitted). */
export type LadderRung = {
  readonly model: string;
  readonly thinking?: ThinkingLevel;
};
/** Every strength's model; all five rungs are required. */
export type Ladder = Readonly<Record<ModelStrengthName, LadderRung>>;

/** Reject a ladder unless all five rungs name a `"provider/model-id"` model; throws `DataflowDefinitionError`. */
export function validateLadder(ladder: Ladder): void {
  for (const name of MODEL_STRENGTHS) {
    const rung = ladder?.[name];
    if (
      rung === null ||
      typeof rung !== "object" ||
      Array.isArray(rung) ||
      typeof rung.model !== "string" ||
      !/^[^/]+\/.+$/.test(rung.model)
    )
      throw new DataflowDefinitionError(
        `ladder.${name}.model must be "provider/model-id"`,
      );
  }
}

/** The same rung at every strength. */
export const uniformLadder = (rung: LadderRung): Ladder =>
  Object.fromEntries(MODEL_STRENGTHS.map((name) => [name, rung])) as Ladder;

/** Every available model (`models`) and the five rungs this ladder allows (`rungs`), checked against the catalog. */
export class ModelLadder {
  constructor(
    readonly models: ModelRuntime,
    readonly rungs: Ladder,
  ) {
    validateLadder(rungs);
    for (const name of MODEL_STRENGTHS) {
      const { model, thinking = "off" } = rungs[name];
      const slash = model.indexOf("/");
      const resolved = models.getModel(
        model.slice(0, slash),
        model.slice(slash + 1),
      );
      if (resolved === undefined)
        throw new DataflowDefinitionError(
          `ladder.${name}.model ${model} is not in the model catalog`,
        );
      const supported = getSupportedThinkingLevels(resolved);
      if (!supported.includes(thinking))
        throw new DataflowDefinitionError(
          `ladder.${name}.thinking ${thinking} is not supported by ${model} (supported: ${supported.join(", ")})`,
        );
    }
  }
}

/** The provider, model and thinking level `strength` selects in `ladder` (`thinking` defaults to `"off"`). */
export function resolveRung(
  ladder: Ladder,
  strength: ModelStrength,
): { provider: string; modelId: string; thinking: ModelThinkingLevel } {
  const { model, thinking = "off" } = ladder[MODEL_STRENGTHS[strength]];
  const slash = model.indexOf("/");
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
    thinking,
  };
}

/** The `provider/model@thinking` each agent last switched to. */
const appliedModels = new WeakMap<object, string>();

/** Switch `member` to `model` at `thinking`; a no-op when that is the last switch applied to it. */
export async function applyModel(
  member: Pick<AgentProtocol, "setModel" | "setThinkingLevel">,
  model: ModelIdentity,
  thinking: ModelThinkingLevel,
): Promise<void> {
  const key = `${model.provider}/${model.modelId}@${thinking}`;
  if (appliedModels.get(member) === key) return;
  await member.setModel(model);
  await member.setThinkingLevel(thinking);
  appliedModels.set(member, key);
}

// Internal execution bookkeeping of adapter-built node bodies; not part of the public surface.

/** What an adapter records about one node body, keyed by that body. */
export type NodePolicy = {
  /** The prompt agent a prompt-agent body drives. */
  readonly agent?: AnyJuncoAgent | AnyMockAgent;
  /** Present for a builder-staged YAML prompt, even when it interpolates no return FIFOs. */
  promptReturnEdges?: ReadonlySet<string>;
  /** A nested-graph body that parks instead of returning; only message edges may touch it. */
  readonly persistent?: true;
  /**
   * `all-messages`: every activation reads every nonempty inbound message queue, whatever the
   * trigger, and no value edge. Prompt agents use it so messaging is independent of activation.
   */
  readonly inputMode?: "all-messages";
  /** Reasons of the agent's latest pause. */
  lastYield?: readonly AgenticYieldReason[];
};

/** Source-derived policy metadata; native descriptions remain on native observations. */
export type AgencyNodeMetadata = Readonly<
  Pick<NodePolicy, "lastYield"> & {
    agentStatus?: NonNullable<NodePolicy["agent"]>["status"];
  }
>;

/** Keyed by the generated body, so node state itself stays the original instance. */
export const nodePolicies = new WeakMap<object, NodePolicy>();

// A controller cannot replay a consumed settlement. Keep even a thrown undefined for later drives.
const controllerFailures = new WeakMap<object, { readonly cause: unknown }>();

export function latchControllerFailure(graph: { readonly signal: AbortSignal }, cause: unknown): never {
  if (graph.signal.aborted || cause instanceof DataflowDefinitionError || holdsUsageFailure(cause))
    throw cause;
  const failure = controllerFailures.get(graph) ?? { cause };
  controllerFailures.set(graph, failure);
  throw failure.cause;
}

export function rethrowControllerFailure(graph: object, parent?: object): void {
  const failure = controllerFailures.get(graph);
  if (failure === undefined) return;
  if (parent && !controllerFailures.has(parent)) controllerFailures.set(parent, failure);
  throw failure.cause;
}

/**
 * What one node registration in a {@link JuncoGraph} binds: its graph's tracer, signal and routes,
 * plus the send tool schema read live from the node's actual outbound message links.
 */
export type NodeRegistration<N extends TSchema = TSchema> = Pick<
  NonNullable<JuncoAgentNodeContext<N>["messaging"]>,
  "info" | "sendParameters"
> & {
  /** Emits `message` as is; an agent node's `send` has already attached its task provenance. */
  send(message: Message<N>): void;
  readonly tracer: DataflowTracer;
  /** The owning graph's current recorder view, if it records. */
  readonly recorder:
    | ProfileRecorder<
        "memory" | "tokens" | "cost" | "edits" | "operations" | "probe"
      >
    | undefined;
  /** The owning graph's current signal. */
  readonly signal: AbortSignal;
};

/**
 * Each node record's registration, keyed by that registration's own Node record: a reused spec or
 * body registered in several graphs keeps each graph's tracer and routes.
 */
export const registeredNodeContexts = new WeakMap<object, NodeRegistration>();

/** The registration of `node`, with the domains of the graph that registered it. */
export const registrationOf = <N extends TSchema, V>(
  node: Node<Agentic<N, V>, N, V>,
): NodeRegistration<N> | undefined =>
  // Only JuncoGraph<N,V>.addNode stores the registration of its own node records.
  registeredNodeContexts.get(node) as NodeRegistration<N> | undefined;

/**
 * Rejects a missing policy (anything without a `toNative` method), or a collection opened under
 * another policy (policies compare by identity).
 */
export function checkPolicy(
  policy: ToolCollection["policy"] | undefined,
  collection: ToolCollection | undefined,
): asserts policy is ToolCollection["policy"] {
  if (
    typeof (policy as Partial<typeof policy> | undefined)?.toNative !==
    "function"
  )
    throw new TypeError("A policy is required");
  if (collection !== undefined && collection.policy !== policy)
    throw new TypeError("Collection policy does not match the selected policy");
}

/** Only the resolved parent results `seen` has not recorded, recording them now. */
export function unseenValues<T>(
  values: Lookup<EdgeId, T>,
  seen: Map<EdgeId, unknown>,
): Lookup<EdgeId, T> {
  const fresh = new Set<EdgeId>();
  for (const id of values.keys())
    if (!seen.has(id) || seen.get(id) !== values.get(id)) fresh.add(id);
  for (const id of fresh) seen.set(id, values.get(id));
  return {
    get: (id) => (fresh.has(id) ? values.get(id) : undefined),
    has: (id) => fresh.has(id),
    keys: () => fresh.keys(),
  };
}

/**
 * The reads of one occurrence of the node whose body is `step`. An `all-messages` body reads every
 * nonempty message queue. Other nodes use the trigger's default plan, including ordered `any`.
 */
export function nodeInputs<N extends TSchema, T>(
  step: object | undefined,
  candidate: NodeAvailability<N, T>,
): InputSchedule {
  const policy = step === undefined ? undefined : nodePolicies.get(step);
  if (policy?.inputMode === "all-messages") return messageInputs(candidate);
  return triggerInputs(candidate);
}

/** Pair a passive agency graph with policy, sidecar metadata and agency input semantics. */
export function context<
  N extends TSchema,
  T,
  G extends JuncoGraph<N, T, never>,
>(options: {
  readonly scheduler: Scheduler<
    NoInfer<Agentic<N, T>>,
    NoInfer<N>,
    NoInfer<T>,
    AgencyNodeMetadata
  >;
  readonly graph: G & JuncoGraph<N, T, never>;
  readonly ladder?: Ladder;
  readonly measurementWindows?: ReadonlyMap<ResourceKind, number>;
}): SchedulerContext<Agentic<N, T>, N, T, AgencyNodeMetadata, G> {
  const { graph, ladder } = options;
  if (ladder !== undefined) validateLadder(ladder);
  return schedulerContext<Agentic<N, T>, N, T, AgencyNodeMetadata, G>({
    ...options,
    ...(ladder === undefined
      ? {}
      : {
          prepare: async (selected) => {
            for (const { nodeId, modelStrength } of selected) {
              const node = graph.getNode(nodeId);
              const member =
                node === undefined
                  ? undefined
                  : nodePolicies.get(node.step)?.agent;
              if (member === undefined) continue;
              const { provider, modelId, thinking } = resolveRung(
                ladder,
                modelStrength,
              );
              await applyModel(member, { provider, modelId }, thinking);
            }
          },
        }),
    readInputs: (id, candidate) =>
      nodeInputs(graph.getNode(id)?.step, candidate),
    describeNode: (id): AgencyNodeMetadata | undefined => {
      const node = graph.getNode(id);
      const policy =
        node === undefined ? undefined : nodePolicies.get(node.step);
      if (policy?.agent === undefined && policy?.lastYield === undefined)
        return undefined;
      return {
        ...(policy.agent === undefined
          ? {}
          : { agentStatus: policy.agent.status }),
        ...(policy.lastYield === undefined
          ? {}
          : { lastYield: policy.lastYield }),
      };
    },
  });
}

/**
 * Whether `nodeId` is paused at a loop-guard hold: its agent is suspended and its latest pause
 * carries a `guard` reason (see `agent.LoopGuard`). Skip stuck nodes with
 * `schedules.separate(schedules.stuck, () => ({ selected: [] }), inner)` — when every available
 * node is stuck, `run()` then ends with the engine's "no work while nodes are available"
 * `DataflowDefinitionError` — or escalate them with
 * `schedules.strength((s, id) => (schedules.stuck(s, id) ? "xhigh" : "med"), inner)`.
 */
export function stuck(
  snapshot: { readonly context: ReadonlyMap<NodeIdType, AgencyNodeMetadata> },
  nodeId: NodeIdType,
): boolean {
  const meta = snapshot.context.get(nodeId);
  // A stale `lastYield` of a node that resumed and settled is not a hold.
  return (
    meta?.agentStatus === "suspended" &&
    (meta.lastYield ?? []).some((reason) => reason.kind === "guard")
  );
}
