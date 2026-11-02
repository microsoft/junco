import type { IDoc } from "prettier-printer";
import * as PP from "prettier-printer";

/** Renderable as a prettier-printer document; `renderPretty` turns it into text. */
export interface Pretty {
  pretty(): IDoc;
}

/** Render `value.pretty()` to a string. */
export function renderPretty(value: Pretty): string {
  return PP.render(0, value.pretty());
}
