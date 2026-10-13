import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Message, NodeGenerator, ParentView } from "dataflow-engine";
import { JuncoAgentError } from "junco-agent";
import type { ToolCollection } from "junco-tools";
import type { AgenticInput } from "./agentic.js";
import { checkPolicy } from "./node-policy.js";

type Advance<N, T> = IteratorResult<Message<N>[], T>;

/**
 * A deterministic graph node body: one async generator speaking the engine's own
 * yield/view/result protocol, plus a cooperative abort signal and close.
 *
 * `body(signal, collection)` is invoked exactly once, by the constructor; its closure holds any
 * domain state. `collection` is the constructor's, borrowed: the coroutine holds its own lease on
 * it from construction until {@link close} finishes. The body may use its tools and mux but must
 * never close it; take `collection.lease()` to keep it beyond the coroutine. A pure coroutine
 * passes none and allocates no collection.
 *
 * The coroutine has a single consumer: {@link step} hands out this instance once, and every
 * advance delegates to the one underlying generator without changing its yields or terminal value.
 * A dependent body normally begins with `let view = yield []`; a source may emit immediately.
 *
 * {@link abort} signals `signal` and joins the advance in flight. {@link close} additionally drains
 * the generator through `return()`, discarding any cleanup batches, then releases its collection
 * lease, and rejects every later advance. Neither can preempt a body that ignores its signal.
 */
export class Deterministic<N = AgenticInput, T = AssistantMessage>
  implements NodeGenerator<N, T>
{
  readonly #controller = new AbortController();
  readonly #generator: NodeGenerator<N, T>;
  /** Handed to its consumer by {@link step}, or advanced directly. */
  #claimed = false;
  /** Completed naturally or failed with an uncaught error. */
  #finished = false;
  /** The latest advance still in flight. */
  #pending: Promise<Advance<N, T>> | undefined;
  #close: Promise<void> | undefined;
  readonly #lease: { close(): Promise<void> } | undefined;

  /** Aborted by {@link abort} or {@link close}; never replaced. */
  readonly signal: AbortSignal = this.#controller.signal;
  /** Authorization policy of this node; equals `collection.policy` when one is supplied. */
  readonly policy: ToolCollection["policy"];
  /** The borrowed collection handed to the body; never closed by the coroutine. */
  readonly collection: ToolCollection | undefined;

  /**
   * @throws {TypeError} for a missing policy, or a collection with another policy (policies
   *   compare by identity).
   */
  constructor(
    body: (
      signal: AbortSignal,
      collection?: ToolCollection,
    ) => NodeGenerator<N, T>,
    policy: ToolCollection["policy"],
    collection?: ToolCollection,
  ) {
    checkPolicy(policy, collection);
    this.policy = policy;
    this.collection = collection;
    this.#generator = body(this.signal, collection);
    this.#lease = collection?.lease();
  }

  /**
   * The node body: returns this instance to its first and only consumer.
   *
   * @throws {JuncoAgentError} `invalid_state` once claimed or advanced directly.
   */
  readonly step = (): NodeGenerator<N, T> => {
    if (this.#claimed) {
      throw new JuncoAgentError(
        "invalid_state",
        "Deterministic coroutine already has a consumer",
      );
    }
    this.#claimed = true;
    return this;
  };

  next(...args: [] | [ParentView<N, T>]): Promise<Advance<N, T>> {
    return this.#advance(true, () => this.#generator.next(...args));
  }

  return(value: T | PromiseLike<T>): Promise<Advance<N, T>> {
    return this.#advance(false, () => this.#generator.return(value));
  }

  throw(error: unknown): Promise<Advance<N, T>> {
    return this.#advance(true, () => this.#generator.throw(error));
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Abort {@link signal} with `reason` and join the advance in flight. Its rejection with exactly
   * `signal.reason` is cancellation, not failure; any other error is preserved. After close has
   * started, joins that close instead.
   */
  abort(
    reason: unknown = new DOMException("Deterministic aborted", "AbortError"),
  ): Promise<void> {
    if (this.#close !== undefined) return this.#close;
    this.#controller.abort(reason);
    return this.#joinPending();
  }

  /**
   * Close once: signal pending work, join it, then return the generator — running its `finally`
   * blocks and discarding any batches they yield. Repeated calls join the same close. A sole failure
   * rejects as itself, several as an `AggregateError`.
   */
  close(): Promise<void> {
    if (this.#close !== undefined) return this.#close;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#close = promise;
    // Installed before cleanup starts, so re-entrant calls join this close.
    this.#finishClose().then(resolve, reject);
    return this.#close;
  }

  #advance(
    guardFinished: boolean,
    request: () => Promise<Advance<N, T>>,
  ): Promise<Advance<N, T>> {
    if (this.#close !== undefined) {
      return Promise.reject(
        new JuncoAgentError("closed", "Deterministic is closed"),
      );
    }
    if (guardFinished && this.#finished) {
      return Promise.reject(
        new JuncoAgentError(
          "invalid_state",
          "Deterministic coroutine has finished",
        ),
      );
    }
    this.#claimed = true;
    let underlying: Promise<Advance<N, T>>;
    try {
      underlying = request();
    } catch (error) {
      underlying = Promise.reject(error);
    }
    const tracked = underlying.then(
      (result) => {
        if (result.done === true) this.#finished = true;
        return result;
      },
      (error: unknown) => {
        this.#finished = true;
        throw error;
      },
    );
    this.#pending = tracked;
    const settle = (): void => {
      if (this.#pending === tracked) this.#pending = undefined;
    };
    tracked.then(settle, settle);
    // Close started while this advance ran: its batch or value would be cleanup output.
    return tracked.then((result) => {
      if (this.#close !== undefined) throw this.signal.reason;
      return result;
    });
  }

  async #joinPending(): Promise<void> {
    const pending = this.#pending;
    if (pending === undefined) return;
    try {
      await pending;
    } catch (error) {
      if (!(this.signal.aborted && error === this.signal.reason)) throw error;
    }
  }

  async #finishClose(): Promise<void> {
    const errors: unknown[] = [];
    if (!this.signal.aborted)
      this.#controller.abort(
        new DOMException("Deterministic closed", "AbortError"),
      );
    const pending = this.#pending;
    if (pending !== undefined) {
      try {
        await pending;
      } catch (error) {
        if (error !== this.signal.reason) errors.push(error);
      }
    }
    try {
      // The cleanup value is never published as a node result.
      let result = await this.#generator.return(undefined as T);
      while (result.done !== true) result = await this.#generator.next();
    } catch (error) {
      errors.push(error);
    }
    this.#finished = true;
    try {
      await this.#lease?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Deterministic close failed");
  }
}
