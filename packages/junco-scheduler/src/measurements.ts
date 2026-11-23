import {
  DataflowDefinitionError,
  type NodeIdType,
  RESOURCE_KINDS,
  type ResourceKind,
} from "dataflow-engine";

type Series = {
  values: number[];
  next: number;
  snapshot?: readonly number[];
};

/** One context's rolling windows. Only observed node/resource pairs allocate a series. */
export class Measurements {
  readonly #windows = new Map<ResourceKind, number>();
  readonly #nodes = new Map<NodeIdType, Map<ResourceKind, Series>>();

  constructor(windows: ReadonlyMap<ResourceKind, number>) {
    for (const [kind, n] of windows) {
      if (!RESOURCE_KINDS.includes(kind) || !Number.isSafeInteger(n) || n < 0)
        throw new DataflowDefinitionError(
          `measurementWindows: expected a known resource and a non-negative safe integer, got ${kind}=${n}`,
        );
      if (n > 0) this.#windows.set(kind, n);
    }
  }

  get measureRuntime(): boolean {
    return this.#windows.has("runtime");
  }

  get report() {
    return this.#windows.size > 0 ? this.#record : undefined;
  }

  readonly #record = (
    id: NodeIdType,
    kind: ResourceKind,
    value: number,
  ): void => {
    const n = this.#windows.get(kind);
    if (n === undefined) return;
    let node = this.#nodes.get(id);
    if (node === undefined) {
      node = new Map();
      this.#nodes.set(id, node);
    }
    let series = node.get(kind);
    if (series === undefined) {
      series = { values: [], next: 0 };
      node.set(kind, series);
    }
    series.values[series.next] = value;
    series.next = (series.next + 1) % n;
    series.snapshot = undefined;
  };

  snapshot(): ReadonlyMap<
    NodeIdType,
    ReadonlyMap<ResourceKind, readonly number[]>
  > {
    const result = new Map<NodeIdType, Map<ResourceKind, readonly number[]>>();
    for (const [id, seriesByKind] of this.#nodes) {
      const node = new Map<ResourceKind, readonly number[]>();
      for (const [kind, series] of seriesByKind) {
        const { values, next } = series;
        series.snapshot ??= Object.freeze(
          next === 0 || next === values.length
            ? values.slice()
            : values.map((_, i) => values[(i + next) % values.length]),
        );
        node.set(kind, series.snapshot);
      }
      result.set(id, node);
    }
    return result;
  }
}
