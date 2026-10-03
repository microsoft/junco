// Compile-only: Pi scheduler factory options. Covered by tsconfig.typecheck.json; never executed.

import type { PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import type { AgenticOptions } from "junco-agent";
import {
  PiScheduler,
  type PiSchedulerOptions,
  type ScheduleTool,
} from "../src/agent.ts";

export function bothFactoriesShareOneOptionsShape<
  N,
  T,
  S extends Skill,
  P extends PromptTemplate,
>(
  shared: PiSchedulerOptions<N, T, S, P>,
  native: Required<
    Pick<AgenticOptions<S, P, ScheduleTool>, "model" | "models" | "session">
  >,
) {
  const empty: PiSchedulerOptions = {};
  const made: Promise<PiScheduler<N, T, S, P>> = PiScheduler.make(shared);
  const opus: Promise<PiScheduler<N, T, S, P>> = PiScheduler.opus(shared);
  const resolved: PiSchedulerOptions<N, T, S, P> = {
    ...native,
    prompt: "Run available work.",
  };
  const fromNative: Promise<PiScheduler<N, T, S, P>> =
    PiScheduler.make(resolved);
  // A redundant model is accepted on opus, which keeps its own fixed selection.
  const opusWithModel: Promise<PiScheduler<N, T, S, P>> =
    PiScheduler.opus(resolved);
  const unchecked: Promise<PiScheduler> = PiScheduler.make({});
  const defaulted: Promise<PiScheduler> = PiScheduler.opus();
  return [empty, made, opus, fromNative, opusWithModel, unchecked, defaulted];
}
