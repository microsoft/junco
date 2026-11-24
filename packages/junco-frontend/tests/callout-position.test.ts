import { expect, test } from "bun:test";
import { calloutPosition } from "../client/callout-position.ts";

test("the tip follows the visible part of the rightmost card until it leaves the panel", () => {
  const panel = { left: 8, right: 792, top: 306, bottom: 592 };
  const card = { left: 740, right: 810, top: 504, bottom: 544 };
  expect(calloutPosition(card, panel, 300, 800, 600)).toEqual({
    side: "above",
    left: 492,
    inset: 104,
    maxHeight: 488,
    tip: 274,
  });
  expect(
    calloutPosition({ ...card, top: 600, bottom: 640 }, panel, 300, 800, 600),
  ).toBeUndefined();
});
