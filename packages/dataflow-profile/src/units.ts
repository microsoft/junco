import { hours, milliseconds, minutes, seconds } from "@buge/ts-units/time";
import { DataflowDefinitionError, bytes, gibibytes, gigabytes, kibibytes, kilobytes, mebibytes, megabytes, tokens, type ResourceKind, type ResourceUnit } from "dataflow-engine";

export const UNITS = {
  memory: { B: bytes, kB: kilobytes, MB: megabytes, GB: gigabytes, KiB: kibibytes, MiB: mebibytes, GiB: gibibytes },
  runtime: { ms: milliseconds, s: seconds, min: minutes, h: hours },
  tokens: { tok: tokens },
} as const satisfies { readonly [R in ResourceKind]: Readonly<Record<string, ResourceUnit<R>>> };
type Symbols = { readonly [R in ResourceKind]: keyof (typeof UNITS)[R] & string };
export type UnitSymbol<R extends ResourceKind> = Symbols[R];
const units: { readonly [R in ResourceKind]: Readonly<Record<string, ResourceUnit<R>>> } = UNITS;

export function unitOf<R extends ResourceKind>(resource: R, symbol: string): ResourceUnit<R> {
  const table = units[resource];
  if (!Object.hasOwn(table, symbol))
    throw new DataflowDefinitionError(`profile ${resource}: unknown unit "${symbol}"`);
  return table[symbol]!;
}

export function symbolOf<R extends ResourceKind>(resource: R, unit: ResourceUnit<R>): UnitSymbol<R> {
  const table = units[resource];
  for (const symbol of Object.keys(table))
    if (table[symbol] === unit) return symbol as UnitSymbol<R>;
  throw new DataflowDefinitionError(`profile ${resource}: unit "${unit.symbol}" is not in the unit table`);
}
