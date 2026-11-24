import type { EdgeIdType } from "dataflow-engine";
import { type TSchema, Type } from "typebox";
import { SendTool, type SendToolHost } from "../ts/messaging.js";

// Compiled by `bun run typecheck`, never executed. Exported so `noUnusedLocals` keeps the fixtures.

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const NumberSchema = Type.Number();
type Num = typeof NumberSchema;
declare const sendHost: SendToolHost<Num>;
declare const signal: AbortSignal;
const meta = { handoff: "h", task: "t", spec: "s" };

/** Unhosted tools promise no payload domain. */
const unsent = new SendTool();
export type _unhostedSend = Expect<Equal<typeof unsent, SendTool<never>>>;

/** A hosted send infers its domain; `invoke` checks a programmatic payload against it. */
export const sent: SendTool<Num> = new SendTool(sendHost);
export const sendNumber = SendTool.invoke(
  unsent,
  sendHost,
  "c",
  { ...meta, id: "n", payload: 7 },
  signal,
);
export const sendString = SendTool.invoke(
  unsent,
  sendHost,
  "c",
  // @ts-expect-error a string is outside the numeric host's domain
  { ...meta, id: "n", payload: "7" },
  signal,
);

/** Schema builders accept any edge schema. */
declare const id: EdgeIdType;
export const schemas: readonly TSchema[] = [
  SendTool.parametersFor([[id, NumberSchema]]),
];
