type Box = Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom">;

export function calloutPosition(
  anchor: Box,
  panel: Box,
  width: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const left = Math.max(0, panel.left, anchor.left);
  const right = Math.min(viewportWidth, panel.right, anchor.right);
  const top = Math.max(0, panel.top, anchor.top);
  const bottom = Math.min(viewportHeight, panel.bottom, anchor.bottom);
  if (right <= left || bottom <= top) return undefined;

  const margin = 8;
  const center = (left + right) / 2;
  const x = Math.max(margin, Math.min(center - width / 2, viewportWidth - width - margin));
  const above = top >= viewportHeight - bottom;
  const maxHeight = (above ? top : viewportHeight - bottom) - 2 * margin;
  if (maxHeight <= 0) return undefined;
  return {
    side: above ? ("above" as const) : ("below" as const),
    left: x,
    inset: (above ? viewportHeight - top : bottom) + margin,
    maxHeight,
    tip: Math.max(margin, Math.min(center - x, width - margin)),
  };
}
