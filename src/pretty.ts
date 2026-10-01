import type { IDoc } from "prettier-printer";
import * as PP from "prettier-printer";

export interface Pretty {
  pretty(): IDoc;
}

export function renderPretty(value: Pretty): string {
  return PP.render(0, value.pretty());
}
