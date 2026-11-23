export type Size = { width: number; height: number };

export function validSize(size: Size | undefined): size is Size {
  return size !== undefined && Number.isFinite(size.width) && size.width > 0 &&
    Number.isFinite(size.height) && size.height > 0;
}

export function fitDirection(panel: Size, lr: Size | undefined, tb: Size | undefined) {
  if (!validSize(panel)) return undefined;
  if (!validSize(lr)) return validSize(tb) ? "TB" : undefined;
  if (!validSize(tb)) return "LR";
  const scale = (drawing: Size) => Math.min(panel.width / drawing.width, panel.height / drawing.height);
  return scale(lr) >= scale(tb) ? "LR" : "TB";
}
