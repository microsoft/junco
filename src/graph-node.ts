import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DataflowDefinitionError,
  DataflowNodeError,
  type DataflowScheduler,
  type EdgeIdType as EdgeId,
  type NodeGenerator,
  type NodeIdType,
  type NodeOptions,
  type ParentView,
  type StepFn,
} from "dataflow-engine";
import * as O from "fp-ts/lib/Option.js";
import { type AgenticStep, JuncoAgentError } from "junco-agent";
import { PiScheduler } from "junco-scheduler/agent";
import type { Agentic, AgenticInput, AgenticNode } from "./agentic.js";
import type { JuncoGraph } from "./junco-graph.js";
import { nodePolicies, unseenValues } from "./node-policy.js";

/** How a nested-graph node executes; carries no registration options. */
export type GraphNodeBinding<N = AgenticInput, T = AssistantMessage> = {
  /** The already registered child node whose result becomes this node's result. */
  readonly result: NodeIdType;
  /**
   * Called on every delivery before the child advances, with the consumed batch and only parent
   * results not delivered before. Use it to feed the child graph.
   */
  readonly receive?: (view: ParentView<N, T>) => void | Promise<void>;
  /** Called after each successful child advance, before completion is tested. */
  readonly afterStep?: () => void | Promise<void>;
};

/** `error`, or `signal.reason` when `error` is that cancellation, possibly wrapped by node errors. */
function cancellation(signal: AbortSignal, error: unknown): unknown {
  if (!signal.aborted) return error;
  let current = error;
  while (current instanceof DataflowNodeError) current = current.cause;
  return current === signal.reason ? signal.reason : error;
}

/**
 * A graph node whose state is the nested `graph` itself and whose result is the selected child's.
 *
 * The body first yields `[]`. Each later activation calls `receive`, then advances the child once:
 * a policy-scheduled child takes one `step()`, a `PiScheduler` child one `scheduler.next()`. After
 * each successful advance it calls `afterStep`, then completes with the selected result once a
 * policy child is quiescent or a Pi child settled normally with nothing available; otherwise it
 * yields `[]` and stays resumable. Cancellation through the child's signal captured for the
 * activation wins over any result. Unless `options.is_available` replaces it, the node is
 * available once started or whenever its trigger fires.
 *
 * @throws {DataflowDefinitionError} when `binding.result` names no registered child node.
 */
export function graphNode<N, T, EH, Q extends DataflowScheduler<N, T>>(
  graph: JuncoGraph<N, T, EH, Q>,
  options: NodeOptions<N, T>,
  binding: GraphNodeBinding<N, T>,
): AgenticNode<N, T> {
  const { result, receive, afterStep } = binding;
  if (graph.getNode(result) === undefined) {
    throw new DataflowDefinitionError(`Unknown graph result node "${result}"`);
  }
  const seenValues = new Set<EdgeId>();
  let started = false;

  /** The selected child's retained result; a nested graph that stopped without one is invalid. */
  const selected = (): T => {
    const retained = graph.result(result);
    if (O.isSome(retained)) return retained.value;
    throw new JuncoAgentError(
      "invalid_state",
      "Nested graph stopped before producing its selected result",
    );
  };

  const step: StepFn<Agentic<N, T>, N, T> = async function* (): NodeGenerator<
    N,
    T
  > {
    let view = yield [];
    started = true;
    while (true) {
      const signal = graph.signal;
      signal.throwIfAborted();
      await receive?.({
        messages: view.messages,
        values: unseenValues(view.values, seenValues),
      });
      signal.throwIfAborted();

      const scheduler: unknown = graph.scheduler;
      let settled = false;
      if (scheduler instanceof PiScheduler) {
        if (scheduler.status === "idle") {
          const retained = graph.result(result);
          if (graph.available().size === 0 && O.isSome(retained))
            return retained.value;
          throw new JuncoAgentError(
            "invalid_state",
            "Nested graph scheduler requires a staged prompt",
          );
        }
        let advanced: IteratorResult<AgenticStep, void>;
        try {
          advanced = await scheduler.next();
        } catch (error) {
          throw cancellation(signal, error);
        }
        signal.throwIfAborted();
        if (advanced.done === true) {
          throw new JuncoAgentError(
            "closed",
            "Nested graph scheduler closed before settlement",
          );
        }
        const boundary = advanced.value;
        if (boundary.kind === "failed")
          throw cancellation(signal, boundary.error);
        if (boundary.kind === "settled") {
          if (boundary.message.stopReason !== "stop") {
            throw new JuncoAgentError(
              "invalid_state",
              "Nested graph scheduler did not finish normally",
            );
          }
          settled = true;
        }
      } else {
        if (graph.available().size === 0) return selected();
        try {
          await graph.step({ signal });
        } catch (error) {
          throw cancellation(signal, error);
        }
        signal.throwIfAborted();
        settled = true;
      }

      await afterStep?.();
      signal.throwIfAborted();

      if (settled) {
        const quiescent = graph.available().size === 0;
        if (scheduler instanceof PiScheduler && !quiescent) {
          throw new JuncoAgentError(
            "invalid_state",
            "PiScheduler finished while graph work is available",
          );
        }
        if (quiescent) return selected();
      }
      view = yield [];
    }
  };
  nodePolicies.set(step, { seenValues });

  return {
    ...options,
    state: graph,
    step,
    is_available:
      options.is_available ?? ((_view, triggered) => started || triggered),
  };
}
