import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { DataflowDefinitionError } from "./errors.js";
import type { Identifiable } from "./identifiable.js";
import { EdgeId } from "./identity.js";
import { Queue } from "./queue.js";

declare const edgeMessages: unique symbol;

/**
 * A graph edge. Its `transport` is `Either<Queue<Static<N>>, Option<T>>`: **Left = message
 * queue**, drained per the destination node's trigger rule, **Right = return-value cell**, holding
 * the source node's latest return value.
 *
 * `schema` is the runtime contract every admitted payload satisfies: the message schema `N` on a
 * message edge, the result schema on a value edge. `N` is also carried by a type-only brand, so a
 * container erasing `schema` to `TSchema` keeps the edge's concrete message domain.
 *
 * `transport` is mutable because fp-ts `Right<A>.right` is readonly — resolving a value edge
 * replaces the whole `Either`; the queue side is mutated in place and never replaced, which is what
 * lets the runtime alias a live queue by reference into a node's readiness probe.
 *
 * `probe`, when present, observes every successful publication: called with each admitted message
 * after it is queued, or each admitted return value after the cell is updated. Its exceptions are
 * isolated from delivery.
 */
export type Edge<N extends TSchema, T> = Identifiable<EdgeId> & {
  readonly schema: TSchema;
  transport: E.Either<Queue<Static<N>>, O.Option<T>>;
  readonly probe?: (value: unknown) => void;
  /** Only a successful value return may publish to this FIFO. */
  readonly onReturn?: true;
  readonly [edgeMessages]: N;
};

/** An absolute URI: a scheme followed by `:`. */
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * `schema` as its own resource: an existing absolute root `$id` is kept, anything else gets a
 * fresh URN, so two edges' identically named local `$defs` never resolve against each other once
 * composed into one port or tool schema. The caller's schema is never mutated.
 */
function scoped<N extends TSchema>(
  kind: "Message" | "Value",
  id: string,
  schema: N,
): N {
  if (!Type.IsSchema(schema))
    throw new DataflowDefinitionError(
      `${kind} edge "${id}" requires a TypeBox schema`,
    );
  if (
    "$id" in schema &&
    typeof schema.$id === "string" &&
    ABSOLUTE_URI.test(schema.$id)
  )
    return schema;
  return Type.With(schema, {
    $id: `urn:uuid:${crypto.randomUUID()}`,
  }) as N;
}

/** Construction of {@link Edge}s. */
export const Edge = {
  /** Mint a message edge: a FIFO queue of `Static<N>`, drained per the destination node's trigger rule. */
  message: <N extends TSchema, T = never>(
    id: string,
    schema: N,
    probe?: (value: unknown) => void,
  ): Edge<N, T> & { readonly schema: N } =>
    ({
      id: EdgeId.create(id),
      schema: scoped("Message", id, schema),
      transport: E.left(Queue.empty<Static<N>>()),
      ...(probe === undefined ? {} : { probe }),
    }) as unknown as Edge<N, T> & { readonly schema: N },
  /** Mint a message FIFO carrying one product per successful return, including repeated values. */
  returned: <N extends TSchema>(
    id: string,
    schema: N,
    probe?: (value: unknown) => void,
  ): Edge<N, Static<N>> & { readonly schema: N; readonly onReturn: true } => ({
    ...Edge.message<N, Static<N>>(id, schema, probe),
    onReturn: true,
  }),
  /** Mint a value edge: a cell holding the source node's latest return value, admitted by `schema`. */
  value: <V extends TSchema>(
    id: string,
    schema: V,
    probe?: (value: unknown) => void,
  ): Edge<never, Static<V>> & { readonly schema: V } =>
    ({
      id: EdgeId.create(id),
      schema: scoped("Value", id, schema),
      transport: E.right(O.none),
      ...(probe === undefined ? {} : { probe }),
    }) as unknown as Edge<never, Static<V>> & { readonly schema: V },
};

/**
 * Assert `payload` satisfies `schema`, reporting the first violation as
 * `<context>: <instancePath-or-/> <message>`. A validator exception becomes a
 * {@link DataflowDefinitionError} with the same context and the exception as its cause.
 */
export function checkPayload<N extends TSchema>(
  schema: N,
  payload: unknown,
  context: string,
): asserts payload is Static<N> {
  let valid: boolean;
  try {
    valid = Value.Check(schema, payload);
  } catch (cause) {
    throw new DataflowDefinitionError(
      `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (valid) return;
  const [error] = Value.Errors(schema, payload);
  throw new DataflowDefinitionError(
    `${context}: ${error === undefined ? "invalid value" : `${error.instancePath || "/"} ${error.message}`}`,
  );
}
