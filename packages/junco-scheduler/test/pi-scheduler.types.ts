// Compile-only: Pi scheduler factory options. Covered by tsconfig.typecheck.json; never executed.

import type { PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import type { DataflowTracer } from "dataflow-engine";
import type { AgenticOptions } from "junco-agent";
import type { Issue } from "junco-tools";
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

export function inheritedComplainTakesCompleteIssue<N>(
  scheduler: PiScheduler<N>,
  issue: Issue<N>,
  tracer: Pick<DataflowTracer, "complain">,
) {
  const recorded: void = scheduler.complain(issue);
  const observed: void = scheduler.complain(issue, tracer);
  // @ts-expect-error a complaint string alone is not an issue
  scheduler.complain("I am stuck.");
  // @ts-expect-error an issue requires its node, messages and prompt context
  scheduler.complain({ complaint: "I am stuck." });
  // @ts-expect-error an issue is required
  scheduler.complain();
  return [recorded, observed];
}
