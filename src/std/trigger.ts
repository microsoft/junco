// `trigger` (also `graph.trigger`): a node's readiness rule over its inbound edges. A rule's kind
// is "all" or "any"; `TriggerEntry.on(edge)` names an entry for `TriggerRule.allOf`/`anyOf`.

export {
  evaluateTrigger,
  satisfiedEdges,
  TriggerEntry,
  type TriggerKind,
  TriggerRule,
} from "dataflow-engine";
