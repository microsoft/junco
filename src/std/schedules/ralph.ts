import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  EdgeId,
  type EdgeIdType,
  Message,
  type ParentView,
} from "dataflow-engine";
import { TaskSchema } from "junco-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { Deterministic } from "../../deterministic.js";
import { latchControllerFailure } from "../../node-policy.js";
import { type DeterministicNode, finalText } from "../../syntax/build.js";

/** Synchronous success check of one completed Ralph result; `round` is one-based, `label` is the graph level's. */
export type RalphPredicate = (
  result: AssistantMessage,
  context: {
    /** The assignment's objectives in delivery order: one per prompt message on the assignment route. */
    readonly objectives: readonly string[];
    readonly round: number;
    readonly label: string;
  },
) => boolean;

/** Round control of `schedules.ralph`: a fixed `rounds` count, or an `until` success check with an optional `rounds` cap. */
export type RalphOptions = {
  /**
   * A positive safe integer. Without `until`: the full-assignment rounds to run, two when omitted.
   * With `until`: a hard cap (omitted: uncapped); a false decision at the cap fails Ralph.
   */
  readonly rounds?: number;
  /** Evaluated once per completed result: true publishes that result, false requests a revision. */
  readonly until?: RalphPredicate;
};
/** Ralph round control with bounded provider-error retries. */
export type RalphLoopOptions = RalphOptions & {
  /** Same-round re-runs after a provider-error result (`stopReason: "error"`), per Ralph level; 0 (default) keeps the error as the round's result. */
  readonly retries?: number;
};

const INPUT = EdgeId.create("$source~>Ralph");
const COMPLETE = EdgeId.create("ralph-complete");

/**
 * @throws {RangeError} when `rounds` is not a positive safe integer or `retries` is not a non-negative safe integer.
 * @throws {TypeError} when `until` is not a function.
 */
export function createRalphController(options: RalphOptions = {}, retries = 0) {
  if (!(Number.isSafeInteger(retries) && retries >= 0))
    throw new RangeError("Ralph retries must be a non-negative safe integer");
  const { until } = options;
  const rounds = options.rounds ?? (until === undefined ? 2 : undefined);
  if (rounds !== undefined && !(Number.isSafeInteger(rounds) && rounds >= 1))
    throw new RangeError("Ralph rounds must be a positive safe integer");
  if (until !== undefined && typeof until !== "function")
    throw new TypeError("Ralph until must be a function");
  return (label: string) => {
    let completed = 0;
    let retried = 0;
    let objectives: string[] = [];
    return {
      admit(view: ParentView<TSchema, unknown>, input: EdgeIdType): string {
        if (objectives.length)
          throw new Error("Ralph accepts only one assignment batch");
        const batch = view.messages.get(input);
        if (
          !batch?.length ||
          [...view.messages.keys()].some((id) => id !== input) ||
          [...view.values.keys()].length > 0
        )
          throw new Error("Ralph requires one or more prompt objectives");
        objectives = batch.map((task) => {
          if (
            !Value.Check(TaskSchema, task) ||
            task.kind !== "prompt" ||
            (task.images?.length ?? 0) > 0
          )
            throw new Error("Ralph requires one or more prompt objectives");
          return task.text;
        });
        return objectives.length === 1
          ? objectives[0]!
          : objectives.map((text, i) => `${i + 1}. ${text}`).join("\n\n");
      },
      retry(product: unknown): boolean {
        if (
          retried >= retries ||
          product === null ||
          typeof product !== "object" ||
          !("stopReason" in product) ||
          product.stopReason !== "error"
        )
          return false;
        retried++;
        return true;
      },
      accept(product: unknown): boolean {
        completed++;
        // Fixed mode publishes the last raw result, even an exhausted provider error.
        if (until === undefined && completed === rounds) return true;
        finalText(product, "Ralph");
        if (until === undefined) return false;
        const decision: unknown = until(product as AssistantMessage, {
          objectives,
          round: completed,
          label,
        });
        if (typeof decision !== "boolean")
          throw new TypeError("Ralph until must return a boolean");
        if (!decision && completed === rounds)
          throw new Error("Ralph reached the round limit without success");
        return decision;
      },
      work(phase: "retry" | "revise") {
        return { phase, round: completed + 1, objectives };
      },
    };
  };
}

/** Drive one Ralph session from its assignment and completed rounds. */
export function ralph(options: RalphLoopOptions = {}) {
  const makeRounds = createRalphController(options, options.retries ?? 0);
  const RalphControl: DeterministicNode = ({ edges, graph, label, policy }) => {
    const work = edges.get("RalphControl~>Ralph");
    const accepted = edges.get("ralph-accepted");
    const ack = edges.get("ingress-ack");
    if (!work || !accepted || !ack || !edges.has(INPUT) || !edges.has(COMPLETE))
      throw new TypeError(
        "RalphControl requires the standard Ralph workflow edges",
      );
    const rounds = makeRounds(label);
    return new Deterministic<TSchema, unknown>(async function* (signal) {
      let view = yield [];
      while (true) {
        signal.throwIfAborted();
        const output: Message<TSchema>[] = [];
        try {
          const tasks = view.messages.get(INPUT);
          if (tasks?.length) {
            rounds.admit(view, INPUT);
            for (const task of tasks) output.push(Message.create(work, task));
          } else {
            for (const product of view.messages.get(COMPLETE) ?? []) {
              if (rounds.retry(product))
                output.push(Message.create(work, rounds.work("retry")));
              else if (rounds.accept(product))
                output.push(
                  Message.create(accepted, true),
                  Message.create(ack, true),
                );
              else output.push(Message.create(work, rounds.work("revise")));
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          latchControllerFailure(graph, error);
        }
        signal.throwIfAborted();
        view = yield output;
      }
    }, policy);
  };
  return { code: { RalphControl } };
}
