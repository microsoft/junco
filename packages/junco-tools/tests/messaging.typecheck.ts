import type { EdgeIdType, Message, ParentView } from "dataflow-engine";
import { type TSchema, Type } from "typebox";
import {
  RecvTool,
  type RecvToolHost,
  SendTool,
  type SendToolHost,
} from "../ts/messaging.js";

// Compiled by `bun run typecheck`, never executed. Exported so `noUnusedLocals` keeps the fixtures.

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const NumberSchema = Type.Number();
type Num = typeof NumberSchema;
type Details<R> = Awaited<R> extends { details: infer D } ? D : never;
type Messages<R> =
  Details<R> extends { messages: readonly (infer M)[] } ? M : never;
type Values<R> =
  Details<R> extends { values: readonly (infer V)[] } ? V : never;

declare const recvHost: RecvToolHost<Num, string>;
declare const sendHost: SendToolHost<Num>;
declare const signal: AbortSignal;

/** A hosted constructor infers a number-message/string-result inbox; raw details are exactly those. */
const hosted = new RecvTool(recvHost);
type HostedResult = ReturnType<typeof hosted.execute>;
export type _hostedMessages = Expect<
  Equal<Messages<HostedResult>, Message<Num>>
>;
export type _hostedPayload = Expect<
  Equal<Messages<HostedResult>["payload"], number>
>;
export type _hostedValues = Expect<
  Equal<
    Values<HostedResult>,
    { readonly id: EdgeIdType; readonly payload: string }
  >
>;

/** `invoke` derives its result from the supplied host, not the tool's construction. */
const invoked = RecvTool.invoke(new RecvTool(), recvHost, "c", {}, signal);
export type _invokedPayload = Expect<
  Equal<Messages<typeof invoked>["payload"], number>
>;
export type _invokedValue = Expect<
  Equal<Values<typeof invoked>["payload"], string>
>;

/** Unhosted tools promise no payload domain. */
const unhosted = new RecvTool();
export type _unhostedRecv = Expect<
  Equal<typeof unhosted, RecvTool<never, never>>
>;
export type _unhostedPayload = Expect<
  Equal<Messages<ReturnType<typeof unhosted.execute>>["payload"], never>
>;
const unsent = new SendTool();
export type _unhostedSend = Expect<Equal<typeof unsent, SendTool<never>>>;

/** A nominal identity check proves only the erased domain. */
export const erased = (tool: object): void => {
  if (RecvTool.is(tool)) {
    type Payload = Messages<ReturnType<typeof tool.execute>>["payload"];
    const _check: Expect<Equal<Payload, unknown>> = true;
    void _check;
  }
};

/** A hosted send infers its domain; `invoke` checks a programmatic payload against it. */
export const sent: SendTool<Num> = new SendTool(sendHost);
export const sendNumber = SendTool.invoke(
  unsent,
  sendHost,
  "c",
  { id: "n", payload: 7 },
  signal,
);
export const sendString = SendTool.invoke(
  unsent,
  sendHost,
  "c",
  // @ts-expect-error a string is outside the numeric host's domain
  { id: "n", payload: "7" },
  signal,
);

/** A host whose view disagrees with its tool's domain is rejected. */
const StringSchema = Type.String();
declare const stringView: ParentView<typeof StringSchema, string>;
// @ts-expect-error a string inbox is not a numeric recv tool's inbox
export const mismatched: RecvTool<Num, string> = new RecvTool({
  view: stringView,
  recvOutputSchema: Type.Object({}),
  consume() {},
});

/** Schema builders accept any edge schema. */
declare const id: EdgeIdType;
export const schemas: readonly TSchema[] = [
  SendTool.parametersFor([[id, NumberSchema]]),
  RecvTool.outputSchemaFor([[id, NumberSchema]], []),
];
