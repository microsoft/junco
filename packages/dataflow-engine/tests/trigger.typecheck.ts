import { Type } from "typebox";
import type {
  EdgeIdType,
  InputSchedule,
  NodeAvailability,
  NodeOptions,
  ParentView,
} from "../src/index.ts";
import {
  Edge,
  EdgeId,
  TriggerEntry,
  TriggerRule,
  triggerInputs,
} from "../src/index.ts";

const NumberSchema = Type.Number();
const StringSchema = Type.String();
type Num = typeof NumberSchema;
type Str = typeof StringSchema;
const NumberListSchema = Type.Array(NumberSchema);
type NumList = typeof NumberListSchema;

// Exported so `noUnusedLocals` does not report the fixtures as dead. Nothing imports this file; it
// exists to be compiled.

const numberEdge = Edge.message<Num, string>("number", NumberSchema);
const numberListEdge = Edge.message<NumList, string>(
  "number-list",
  NumberListSchema,
);
const stringEdge = Edge.message<Str, string>("string", StringSchema);
const numberResultEdge = Edge.message<Num, number>(
  "number-result",
  NumberSchema,
);
const messageOnly = Edge.message("message-only", NumberSchema);
const resultOnly = Edge.value("result-only", StringSchema);

// --- 1. entries carry both payloads; a bare id carries neither ----------------------------------

export const entry: TriggerEntry<Num, string> = TriggerEntry.on(numberEdge);
export const entryIsEdgeId: EdgeIdType = TriggerEntry.on(numberEdge);
// @ts-expect-error a number-message entry is not a string-message entry
export const wrongEntryMessage: TriggerEntry<Str, string> =
  TriggerEntry.on(numberEdge);
// @ts-expect-error a string-result entry is not a Date-result entry
export const wrongEntryResult: TriggerEntry<Num, Date> =
  TriggerEntry.on(numberEdge);
export const bareIdRule = TriggerRule.allOf(
  // @ts-expect-error a bare edge id carries no payload evidence
  EdgeId.create("bare"),
);

// --- 2. heterogeneous entries infer both dimensions ---------------------------------------------

const inferredAll = TriggerRule.allOf(
  TriggerEntry.on(messageOnly),
  TriggerEntry.on(resultOnly),
);
const inferredAny = TriggerRule.anyOf(
  TriggerEntry.on(messageOnly),
  TriggerEntry.on(resultOnly),
);
export const inferredAllRule: TriggerRule<Num, string> = inferredAll;
export const inferredAnyRule: TriggerRule<Num, string> = inferredAny;
// @ts-expect-error the inferred message payload is number, not string
export const inferredWrongMessage: TriggerRule<Str, string> = inferredAll;
// @ts-expect-error the inferred result payload is string, not Date
export const inferredWrongResult: TriggerRule<Num, Date> = inferredAny;
// @ts-expect-error anyOf retains the inferred number message payload
export const inferredAnyWrongMessage: TriggerRule<Str, string> = inferredAny;
// @ts-expect-error allOf retains the inferred string result payload
export const inferredAllWrongResult: TriggerRule<Num, Date> = inferredAll;
export const explicitWrongEntry = TriggerRule.allOf<Num, string>(
  TriggerEntry.on(numberEdge),
  // @ts-expect-error an explicit rule rejects an entry of another message type
  TriggerEntry.on(stringEdge),
);

// --- 3. every entry contributes to the inferred unions ------------------------------------------

const messageUnionAll = TriggerRule.allOf(
  TriggerEntry.on(numberEdge),
  TriggerEntry.on(numberListEdge),
);
const messageUnionAny = TriggerRule.anyOf(
  TriggerEntry.on(numberEdge),
  TriggerEntry.on(numberListEdge),
);
export const messageUnionAllRule: TriggerRule<Num | NumList, string> =
  messageUnionAll;
export const messageUnionAnyRule: TriggerRule<Num | NumList, string> =
  messageUnionAny;
// @ts-expect-error the second entry's number[] messages survive inference
export const messageUnionNarrowed: TriggerRule<Num, string> = messageUnionAll;
// @ts-expect-error anyOf retains the second entry's number[] messages
export const messageUnionAnyNarrowed: TriggerRule<Num, string> =
  messageUnionAny;

const resultUnionAll = TriggerRule.allOf(
  TriggerEntry.on(numberEdge),
  TriggerEntry.on(numberResultEdge),
);
const resultUnionAny = TriggerRule.anyOf(
  TriggerEntry.on(numberEdge),
  TriggerEntry.on(numberResultEdge),
);
export const resultUnionAllRule: TriggerRule<Num, string | number> =
  resultUnionAll;
export const resultUnionAnyRule: TriggerRule<Num, string | number> =
  resultUnionAny;
// @ts-expect-error the second entry's number results survive inference
export const resultUnionNarrowed: TriggerRule<Num, string> = resultUnionAny;
// @ts-expect-error allOf retains the second entry's number results
export const resultUnionAllNarrowed: TriggerRule<Num, string> = resultUnionAll;

// --- 4. empty rules fit every graph; literals are checked per entry ------------------------------

const emptyAll = TriggerRule.allOf();
const emptyAny = TriggerRule.anyOf();
const source = TriggerRule.always();
const closed = TriggerRule.never();
export const emptyRules: readonly TriggerRule<Num | NumList, string>[] = [
  emptyAll,
  emptyAny,
  source,
  closed,
];
export const literalRule: TriggerRule<Num, string> = {
  kind: "all",
  rule: [TriggerEntry.on(numberEdge)],
};
export const wrongLiteralRule: TriggerRule<Num, string> = {
  kind: "any",
  // @ts-expect-error a string-message entry does not fit a number-message rule
  rule: [TriggerEntry.on(stringEdge)],
};

// --- 5. a narrow rule serves a wider graph; wrong payloads do not -------------------------------

const narrowRule = TriggerRule.when(numberEdge);
const stringRule = TriggerRule.allOf(TriggerEntry.on(stringEdge));
const dateResultRule = TriggerRule.allOf<Num, Date>();

export const wideOptions: NodeOptions<Num | NumList, string> = {
  trigger: narrowRule,
};
export const stringOptions: NodeOptions<Num | NumList, string> = {
  // @ts-expect-error string messages do not fit a number | number[] graph
  trigger: stringRule,
};
export const dateOptions: NodeOptions<Num | NumList, string> = {
  // @ts-expect-error Date results do not fit a string-result graph
  trigger: dateResultRule,
};

const view: ParentView<Num | NumList, string> = {
  messages: new Map([[numberEdge.id, [1, [2, 3]]]]),
  values: new Map(),
};
const available: NodeAvailability<Num | NumList, string> = {
  view,
  trigger: narrowRule,
  satisfied: [numberEdge.id],
  continuationOnly: false,
  status: "ready",
};
export const narrowInputs: InputSchedule = triggerInputs(available);
export const stringAvailability: NodeAvailability<Num | NumList, string> = {
  view,
  // @ts-expect-error string messages do not fit a number | number[] graph
  trigger: stringRule,
  satisfied: [stringEdge.id],
  continuationOnly: false,
  status: "running",
};
export const dateAvailability: NodeAvailability<Num | NumList, string> = {
  view,
  // @ts-expect-error Date results do not fit a string-result graph
  trigger: dateResultRule,
  satisfied: [],
  continuationOnly: false,
  status: "ready",
};
