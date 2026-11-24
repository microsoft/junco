import { EdgeId, Message } from "dataflow-engine";
import { TaskSchema } from "junco-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { Deterministic } from "../../deterministic.js";
import { latchControllerFailure } from "../../node-policy.js";
import { type DeterministicNode, finalText } from "../../syntax/build.js";

const input = EdgeId.create("$source~>AnyFanIn");
const selected = EdgeId.create("AnyFanIn->AnyFanInPublish");

/** Admit one candidate batch, then reopen ingress only when its selection is published. */
export function anyFanIn() {
  const AnyFanInInput: DeterministicNode = ({ graph, edges, policy }) => {
    const work = edges.get("AnyFanInInput~>AnyFanIn");
    if (!work)
      throw new TypeError("AnyFanInInput requires a selector work edge");
    return new Deterministic<TSchema, unknown>(async function* (signal) {
      let view = yield [];
      while (true) {
        signal.throwIfAborted();
        const batch = view.messages.get(input) ?? [];
        for (const candidate of batch) {
          if (
            !Value.Check(TaskSchema, candidate) ||
            candidate.kind !== "prompt"
          )
            latchControllerFailure(
              graph,
              new TypeError("AnyFanIn requires prompt candidate messages"),
            );
          if (!candidate.text.trim())
            latchControllerFailure(
              graph,
              new Error("AnyFanIn candidate text must not be empty"),
            );
        }
        view = yield batch.map((candidate) => Message.create(work, candidate));
      }
    }, policy);
  };
  const AnyFanInPublish: DeterministicNode = ({ graph, edges, policy }) => {
    const output = edges.get("AnyFanInPublish~>$sink");
    const ack = edges.get("ingress-ack");
    if (!output || !ack)
      throw new TypeError(
        "AnyFanInPublish requires output and ingress-ack edges",
      );
    return new Deterministic<TSchema, unknown>(async function* (signal) {
      let view = yield [];
      while (true) {
        signal.throwIfAborted();
        const messages = [];
        for (const result of view.messages.get(selected) ?? []) {
          try {
            finalText(result, "AnyFanIn");
          } catch (error) {
            latchControllerFailure(graph, error);
          }
          messages.push(
            Message.create(output, result),
            Message.create(ack, true),
          );
        }
        view = yield messages;
      }
    }, policy);
  };
  return { code: { AnyFanInInput, AnyFanInPublish } };
}
