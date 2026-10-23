import {
  EdgeId,
  type ProfileData,
  type ResourceKind,
  type ResourceUnit,
} from "../src/index.ts";

/** A zero-predicting profile counting messages on `ports`. */
export function stubProfile<R extends ResourceKind>(
  resource: R,
  unit: ResourceUnit<R>,
  ports: readonly string[] = [],
): ProfileData<R> {
  return {
    resource,
    unit,
    features: ports.map((port) => ({
      port: EdgeId.create(port),
      measure: "count",
    })),
    predict: () => ({ value: 0, safe: 0, source: "model" }),
  };
}
