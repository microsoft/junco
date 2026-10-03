// `trigger` (also `graph.trigger`): a node's readiness rule over its inbound edges. A rule's kind
// is "all" or "any"; `on(edge)` names an entry for `allOf`/`anyOf`.

export {
  allOf,
  always,
  anyOf,
  evaluateTrigger,
  never,
  on,
  satisfiedEdges,
  type TriggerEntry,
  type TriggerKind,
  type TriggerRule,
  when,
} from "dataflow-engine";
