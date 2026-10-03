import type {
  EdgeIdType,
  InputSchedule,
  NodeAvailability,
  NodeOptions,
  ParentView,
  TriggerEntry,
  TriggerRule,
} from "../src/index.ts";
import {
  allOf,
  always,
  anyOf,
  EdgeId,
  messageEdge,
  never,
  on,
  triggerInputs,
  valueEdge,
  when,
} from "../src/index.ts";

// Exported so `noUnusedLocals` does not report the fixtures as dead. Nothing imports this file; it
// exists to be compiled.

const numberEdge = messageEdge<number, string>("number");
const numberListEdge = messageEdge<number[], string>("number-list");
const stringEdge = messageEdge<string, string>("string");
const numberResultEdge = messageEdge<number, number>("number-result");
const messageOnly = messageEdge<number, never>("message-only");
const resultOnly = valueEdge<never, string>("result-only");

// --- 1. entries carry both payloads; a bare id carries neither ----------------------------------

export const entry: TriggerEntry<number, string> = on(numberEdge);
export const entryIsEdgeId: EdgeIdType = on(numberEdge);
// @ts-expect-error a number-message entry is not a string-message entry
export const wrongEntryMessage: TriggerEntry<string, string> = on(numberEdge);
// @ts-expect-error a string-result entry is not a Date-result entry
export const wrongEntryResult: TriggerEntry<number, Date> = on(numberEdge);
export const bareIdRule = allOf(
  // @ts-expect-error a bare edge id carries no payload evidence
  EdgeId("bare"),
);

// --- 2. heterogeneous entries infer both dimensions ---------------------------------------------

const inferredAll = allOf(on(messageOnly), on(resultOnly));
const inferredAny = anyOf(on(messageOnly), on(resultOnly));
export const inferredAllRule: TriggerRule<number, string> = inferredAll;
export const inferredAnyRule: TriggerRule<number, string> = inferredAny;
// @ts-expect-error the inferred message payload is number, not string
export const inferredWrongMessage: TriggerRule<string, string> = inferredAll;
// @ts-expect-error the inferred result payload is string, not Date
export const inferredWrongResult: TriggerRule<number, Date> = inferredAny;
// @ts-expect-error anyOf retains the inferred number message payload
export const inferredAnyWrongMessage: TriggerRule<string, string> = inferredAny;
// @ts-expect-error allOf retains the inferred string result payload
export const inferredAllWrongResult: TriggerRule<number, Date> = inferredAll;
export const explicitWrongEntry = allOf<number, string>(
  on(numberEdge),
  // @ts-expect-error an explicit rule rejects an entry of another message type
  on(stringEdge),
);

// --- 3. every entry contributes to the inferred unions ------------------------------------------

const messageUnionAll = allOf(on(numberEdge), on(numberListEdge));
const messageUnionAny = anyOf(on(numberEdge), on(numberListEdge));
export const messageUnionAllRule: TriggerRule<number | number[], string> =
  messageUnionAll;
export const messageUnionAnyRule: TriggerRule<number | number[], string> =
  messageUnionAny;
// @ts-expect-error the second entry's number[] messages survive inference
export const messageUnionNarrowed: TriggerRule<number, string> =
  messageUnionAll;
// @ts-expect-error anyOf retains the second entry's number[] messages
export const messageUnionAnyNarrowed: TriggerRule<number, string> =
  messageUnionAny;

const resultUnionAll = allOf(on(numberEdge), on(numberResultEdge));
const resultUnionAny = anyOf(on(numberEdge), on(numberResultEdge));
export const resultUnionAllRule: TriggerRule<number, string | number> =
  resultUnionAll;
export const resultUnionAnyRule: TriggerRule<number, string | number> =
  resultUnionAny;
// @ts-expect-error the second entry's number results survive inference
export const resultUnionNarrowed: TriggerRule<number, string> = resultUnionAny;
// @ts-expect-error allOf retains the second entry's number results
export const resultUnionAllNarrowed: TriggerRule<number, string> =
  resultUnionAll;

// --- 4. empty rules fit every graph; literals are checked per entry ------------------------------

const emptyAll = allOf();
const emptyAny = anyOf();
const source = always();
const closed = never();
export const emptyRules: readonly TriggerRule<number | number[], string>[] = [
  emptyAll,
  emptyAny,
  source,
  closed,
];
export const literalRule: TriggerRule<number, string> = {
  kind: "all",
  rule: [on(numberEdge)],
};
export const wrongLiteralRule: TriggerRule<number, string> = {
  kind: "any",
  // @ts-expect-error a string-message entry does not fit a number-message rule
  rule: [on(stringEdge)],
};

// --- 5. a narrow rule serves a wider graph; wrong payloads do not -------------------------------

const narrowRule = when(numberEdge);
const stringRule = allOf(on(stringEdge));
const dateResultRule = allOf<number, Date>();

export const wideOptions: NodeOptions<number | number[], string> = {
  trigger: narrowRule,
};
export const stringOptions: NodeOptions<number | number[], string> = {
  // @ts-expect-error string messages do not fit a number | number[] graph
  trigger: stringRule,
};
export const dateOptions: NodeOptions<number | number[], string> = {
  // @ts-expect-error Date results do not fit a string-result graph
  trigger: dateResultRule,
};

const view: ParentView<number | number[], string> = {
  messages: new Map([[numberEdge.id, [1, [2, 3]]]]),
  values: new Map(),
};
const available: NodeAvailability<number | number[], string> = {
  view,
  trigger: narrowRule,
  satisfied: [numberEdge.id],
  status: "ready",
};
export const narrowInputs: InputSchedule = triggerInputs(available);
export const stringAvailability: NodeAvailability<number | number[], string> = {
  view,
  // @ts-expect-error string messages do not fit a number | number[] graph
  trigger: stringRule,
  satisfied: [stringEdge.id],
  status: "running",
};
export const dateAvailability: NodeAvailability<number | number[], string> = {
  view,
  // @ts-expect-error Date results do not fit a string-result graph
  trigger: dateResultRule,
  satisfied: [],
  status: "ready",
};
