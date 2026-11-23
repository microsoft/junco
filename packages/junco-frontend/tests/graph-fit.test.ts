import { expect, test } from "bun:test";
import { fitDirection } from "../client/graph-fit.ts";

const size = (width: number, height: number) => ({ width, height });
const lr = size(600, 100);
const tb = size(150, 500);

test("choose the drawing with the larger uniform scale", () => {
  expect(fitDirection(size(800, 200), lr, tb)).toBe("LR");
  expect(fitDirection(size(200, 800), lr, tb)).toBe("TB");
  expect(fitDirection(size(640, 240), size(160, 600), size(520, 160))).toBe("TB");
  expect(fitDirection(size(1200, 1000), size(600, 100), size(150, 400))).toBe("TB");
  expect(fitDirection(size(1200, 1000), lr, tb)).toBe("LR");
});

test("ignore unusable bounds and wait for a measurable panel", () => {
  const panel = size(800, 200);
  expect(fitDirection(panel, undefined, tb)).toBe("TB");
  expect(fitDirection(panel, lr, size(0, 10))).toBe("LR");
  expect(fitDirection(panel, size(1, NaN), size(Infinity, 1))).toBeUndefined();
  expect(fitDirection(size(800, 0), lr, tb)).toBeUndefined();
});
