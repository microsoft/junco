The language should denote one scheduling step, not a future plan:

⟦S⟧:Snapshot→Decision\llbracket S \rrbracket : \mathsf{Snapshot} \rightarrow \mathsf{Decision}

A snapshot contains everything needed to make the decision, including scheduler history. This keeps schedulers pure, makes round-robin derivable, and gives separating composition a precise ownership meaning.

1. Semantic objects

Assume stable node identifiers:

type NodeId = string;

Snapshot

The scheduler receives a read-only observation of the runtime:

interface Snapshot<N, E> {
  readonly graph: Graph<N, E>;

  /** Nodes whose trigger rules currently hold. */
  readonly available: ReadonlySet<NodeId>;

  /** Nodes over which this scheduler has authority. */
  readonly owned: ReadonlySet<NodeId>;

  /** Completed scheduling decisions, oldest first. */
  readonly history: readonly PastDecision[];

  /** Monotonically increasing runtime version. */
  readonly version: number;
}

interface PastDecision {
  readonly selected: readonly NodeId[];
}


The important fields are:

available: determined by the graph runtime.
owned: determined by scheduler composition.
history: makes stateful policies expressible as pure functions.
graph: read-only structural and metadata information.

The scheduler does not inspect or mutate edge queues directly unless that is intentionally exposed through Graph. Availability remains authoritative.

Decision

A decision says which nodes to start now:

interface Decision {
  readonly selected: readonly NodeId[];
}


The empty decision denotes abstention:

const none: Decision = { selected: [] };


There is no Node[][] in the semantic domain. A matrix is an agent-produced prediction about future decisions, not the decision itself. The adapter takes the first currently applicable wave.

Scheduler
type Scheduler<N, E> =
  (snapshot: Snapshot<N, E>) => Decision;


For an asynchronous implementation:

type AsyncScheduler<N, E> =
  (snapshot: Snapshot<N, E>) => Promise<Decision>;


The pure function is the semantic model. Promise is an implementation concern representing the time required to compute the decision.

2. Scheduler validity

A scheduler is safe when it selects only available nodes it owns:

safe(S)≜∀σ.  selected(S(σ))⊆σ.available∩σ.owned\mathsf{safe}(S) \quad\triangleq\quad \forall \sigma.\; \mathsf{selected}(S(\sigma)) \subseteq \sigma.\mathsf{available} \cap \sigma.\mathsf{owned}

In TypeScript:

function isSafe<N, E>(
  snapshot: Snapshot<N, E>,
  decision: Decision,
): boolean {
  return decision.selected.every(
    id =>
      snapshot.available.has(id) &&
      snapshot.owned.has(id),
  );
}


The runtime should validate this property even if constructors preserve it by design. In particular, an LLM scheduler is untrusted.

Decisions should also be duplicate-free:

∣selected(d)∣=∣set(selected(d))∣|\mathsf{selected}(d)| = |\mathsf{set}(\mathsf{selected}(d))|

Dependency and trigger correctness do not belong in the scheduler language. They are represented by available.

3. The smallest useful deterministic primitive

A deterministic scheduler needs only:

A candidate predicate.
A ranking.
A width.
type Rank<N, E> = (
  snapshot: Snapshot<N, E>,
  left: NodeId,
  right: NodeId,
) => number;

interface ChooseOptions<N, E> {
  /**
   * Optional additional restriction.
   * Availability and ownership are enforced automatically.
   */
  readonly where?: (
    snapshot: Snapshot<N, E>,
    node: NodeId,
  ) => boolean;

  /**
   * Negative means left precedes right.
   */
  readonly rank: Rank<N, E>;

  readonly width?: (
    snapshot: Snapshot<N, E>,
  ) => number;
}

function choose<N, E>(
  options: ChooseOptions<N, E>,
): Scheduler<N, E> {
  return snapshot => {
    const width = Math.max(
      0,
      options.width?.(snapshot) ?? 1,
    );

    const candidates = [...snapshot.available]
      .filter(id => snapshot.owned.has(id))
      .filter(id => options.where?.(snapshot, id) ?? true)
      .sort((x, y) => {
        const ranked = options.rank(snapshot, x, y);

        // Stable, total fallback order.
        return ranked !== 0
          ? ranked
          : x.localeCompare(y);
      });

    return {
      selected: candidates.slice(0, width),
    };
  };
}


Semantically, let:

C(σ)=σ.available∩σ.owned∩{n∣P(σ,n)}C(\sigma) = \sigma.\mathsf{available} \cap \sigma.\mathsf{owned} \cap \{n \mid P(\sigma,n)\}

and let ⪯σ\preceq_\sigma be the order induced by rank. Then:

⟦choose(P,⪯,k)⟧(σ)=takek(σ)(sort⪯σ(C(σ)))\llbracket \mathsf{choose}(P,\preceq,k) \rrbracket(\sigma) = \mathsf{take}_{k(\sigma)} \left( \mathsf{sort}_{\preceq_\sigma}(C(\sigma)) \right)

choose is safe by construction because it begins with available ∩ owned.

Scoring is derived

chooseBest is not fundamental. It derives a ranking from a score:

type Score<N, E> = (
  snapshot: Snapshot<N, E>,
  node: NodeId,
) => number;

function byDescendingScore<N, E>(
  score: Score<N, E>,
): Rank<N, E> {
  return (snapshot, x, y) =>
    score(snapshot, y) - score(snapshot, x);
}


Usage:

const highestPriority = choose({
  rank: byDescendingScore(
    (snapshot, id) => snapshot.graph.node(id).priority,
  ),
});


A comparator is the better semantic primitive because rankings need not embed naturally into numbers.

4. Round-robin as a pure derived scheduler

Round-robin requires:

a stable circular order;
the position following the most recently selected node.

The cursor is derived from history, so no hidden mutable scheduler state is required.

function roundRobin<N, E>(
  order: readonly NodeId[],
  width = 1,
): Scheduler<N, E> {
  const index = new Map(
    order.map((id, i) => [id, i] as const),
  );

  const cursor = (
    snapshot: Snapshot<N, E>,
  ): number => {
    for (
      let i = snapshot.history.length - 1;
      i >= 0;
      i--
    ) {
      const selected = snapshot.history[i].selected;

      for (let j = selected.length - 1; j >= 0; j--) {
        const position = index.get(selected[j]);

        if (position !== undefined) {
          return (position + 1) % order.length;
        }
      }
    }

    return 0;
  };

  const distance = (
    start: number,
    id: NodeId,
  ): number => {
    const position = index.get(id);

    return position === undefined
      ? Number.MAX_SAFE_INTEGER
      : (position - start + order.length) % order.length;
  };

  return choose({
    where: (_snapshot, id) => index.has(id),

    rank: (snapshot, x, y) => {
      const start = cursor(snapshot);

      return (
        distance(start, x) -
        distance(start, y)
      );
    },

    width: () => width,
  });
}


The mathematical ranking is:

distanceσ(ni)=(i−cσ+N) mod N\mathsf{distance}_{\sigma}(n_i) = (i-c_\sigma+N)\bmod N

where cσc_\sigma is one position after the most recently selected node in the scheduler’s order.

Then:

ni⪯σnj⟺distanceσ(ni)≤distanceσ(nj)n_i \preceq_\sigma n_j \quad\Longleftrightarrow\quad \mathsf{distance}_{\sigma}(n_i) \le \mathsf{distance}_{\sigma}(n_j)

The score formulation is equivalent:

scoreσ(ni)=N−distanceσ(ni)\mathsf{score}_{\sigma}(n_i) = N-\mathsf{distance}_{\sigma}(n_i)

Your n - i formulation is the special case cσ=0c_\sigma=0.

History scoping matters

A round-robin scheduler must see only decisions made under its own ownership domain. Otherwise, decisions by unrelated schedulers could move its cursor.

Therefore snapshot restriction must also project history:

function projectHistory(
  history: readonly PastDecision[],
  owned: ReadonlySet<NodeId>,
): readonly PastDecision[] {
  return history
    .map(decision => ({
      selected: decision.selected.filter(id => owned.has(id)),
    }))
    .filter(decision => decision.selected.length > 0);
}


This is essential for compositionality.

5. Ownership restriction

Define projection of a snapshot to an ownership set AA:

σ ⁣↾A\sigma\!\upharpoonright_A

It preserves global read-only information but restricts authority and scheduler history:

(σ ⁣↾A).graph=σ.graph(σ ⁣↾A).available=σ.available(σ ⁣↾A).owned=σ.owned∩A(σ ⁣↾A).history=σ.history ⁣↾A\begin{aligned} (\sigma\!\upharpoonright_A).\mathsf{graph} &= \sigma.\mathsf{graph} \\ (\sigma\!\upharpoonright_A).\mathsf{available} &= \sigma.\mathsf{available} \\ (\sigma\!\upharpoonright_A).\mathsf{owned} &= \sigma.\mathsf{owned} \cap A \\ (\sigma\!\upharpoonright_A).\mathsf{history} &= \sigma.\mathsf{history}\!\upharpoonright_A \end{aligned}

In TypeScript:

function restrictSnapshot<N, E>(
  snapshot: Snapshot<N, E>,
  ownership: ReadonlySet<NodeId>,
): Snapshot<N, E> {
  const owned = new Set(
    [...snapshot.owned].filter(id => ownership.has(id)),
  );

  return {
    ...snapshot,
    owned,
    history: projectHistory(snapshot.history, owned),
  };
}


This is not a partition of the graph. The graph and its edge queues remain shared runtime state. What separates is the authority to select nodes.

6. Separating scheduler composition

A bare binary S₁ * S₂ is underspecified because something must determine the ownership split. Make the split explicit:

interface Partition<N, E> {
  readonly left: (
    snapshot: Snapshot<N, E>,
    node: NodeId,
  ) => boolean;
}


The right side receives the complement within the current ownership domain.

function separate<N, E>(
  partition: Partition<N, E>,
  left: Scheduler<N, E>,
  right: Scheduler<N, E>,
): Scheduler<N, E> {
  return snapshot => {
    const leftOwned = new Set<NodeId>();
    const rightOwned = new Set<NodeId>();

    for (const id of snapshot.owned) {
      if (partition.left(snapshot, id)) {
        leftOwned.add(id);
      } else {
        rightOwned.add(id);
      }
    }

    const dl = left(restrictSnapshot(snapshot, leftOwned));
    const dr = right(restrictSnapshot(snapshot, rightOwned));

    return {
      selected: [...dl.selected, ...dr.selected],
    };
  };
}


Surface use:

const hybrid = separate(
  {
    left: (snapshot, id) =>
      snapshot.graph.node(id).kind === "agentic",
  },
  agentScheduler,
  roundRobin(stableOrder),
);

Denotation

Let AσA_\sigma be the nodes satisfying the partition and:

Bσ=σ.owned∖AσB_\sigma = \sigma.\mathsf{owned} \setminus A_\sigma

Then:

⟦separate(P,S1,S2)⟧(σ)=⟦S1⟧(σ ⁣↾Aσ)  ⊎  ⟦S2⟧(σ ⁣↾Bσ)\llbracket \mathsf{separate}(P,S_1,S_2) \rrbracket(\sigma) = \llbracket S_1 \rrbracket (\sigma\!\upharpoonright_{A_\sigma}) \;\uplus\; \llbracket S_2 \rrbracket (\sigma\!\upharpoonright_{B_\sigma})

Here ⊎\uplus is disjoint decision union.

Because:

Aσ∩Bσ=∅A_\sigma \cap B_\sigma = \varnothing

and safe schedulers select only owned nodes, their decisions must be disjoint:

selected(d1)∩selected(d2)=∅\mathsf{selected}(d_1) \cap \mathsf{selected}(d_2) = \varnothing

This is the scheduler analogue of the CSL parallel rule. The composition is sound because each component acts only upon authority it owns. The underlying graph, much like an invariant-protected shared resource, remains globally observable but is not divided into disconnected graphs. This follows the ownership-centered compositionality of Concurrent Separation Logic.

Safety theorem

If S1S_1 and S2S_2 are safe, then:

separate(P,S1,S2)\mathsf{separate}(P,S_1,S_2)

is safe.

The proof is immediate:

S1S_1 selects only from available ∩ owned ∩ A.
S2S_2 selects only from available ∩ owned ∩ complement(A).
Their selections are disjoint.
Their union is contained in the original available ∩ owned.
7. The locality property

Safety is not enough for compositional reasoning. A scheduler should also be local with respect to ownership.

Intuitively, adding nodes that the scheduler does not own should not change its decision.

For A⊆BA \subseteq B, define observational equality on AA:

σA≡AσB\sigma_A \equiv_A \sigma_B

when the snapshots agree on:

graph observations relevant to nodes in AA;
availability of nodes in AA;
projected history on AA;
ownership AA.

Then locality is:

σ1≡Aσ2  ⟹  S(σ1)=S(σ2)\sigma_1 \equiv_A \sigma_2 \implies S(\sigma_1)=S(\sigma_2)

for a scheduler receiving ownership AA.

In implementation terms, components under separate must observe the projected snapshot, not close over an unrestricted outer snapshot. Otherwise this apparently innocent scheduler violates locality:

const bad: Scheduler<N, E> = snapshot => {
  const unownedNodeExists =
    [...globalSnapshot.available]
      .some(id => !snapshot.owned.has(id));

  return unownedNodeExists
    ? { selected: [] }
    : { selected: [...snapshot.owned].slice(0, 1) };
};


TypeScript cannot enforce locality by its regular type system. The library can encourage it by:

Passing only SnapshotView, with no ambient runtime handle.
Avoiding mutable global variables.
Testing frame properties.
Optionally branding validated scheduler constructors.

The combinator fragment generated by choose, separate, and pure ranking functions should be local by construction, provided ranking functions inspect nodes only through the projected view.

8. Agent scheduling

An LLM returning NodeId[][] is an oracle for a decision. The matrix is not the denotation.

type AgentPlan =
  readonly (readonly NodeId[])[];

function firstApplicableWave<N, E>(
  snapshot: Snapshot<N, E>,
  plan: AgentPlan,
): Decision {
  for (const wave of plan) {
    const selected = [...new Set(wave)].filter(
      id =>
        snapshot.owned.has(id) &&
        snapshot.available.has(id),
    );

    if (selected.length > 0) {
      return { selected };
    }
  }

  return none;
}


Thus an agent scheduler is semantically:

⟦agent(a)⟧(σ)=firstApplicable(σ, a(encode(σ)))\llbracket \mathsf{agent}(a) \rrbracket(\sigma) = \mathsf{firstApplicable} \left( \sigma,\, a(\mathsf{encode}(\sigma)) \right)

The agent may speculate about future waves, but only the first currently valid wave becomes the decision. The runtime invokes the scheduler again after graph state changes.

In TypeScript:

function agent<N, E>(
  invoke: (
    snapshot: Snapshot<N, E>,
  ) => Promise<AgentPlan>,
): AsyncScheduler<N, E> {
  return async snapshot =>
    firstApplicableWave(snapshot, await invoke(snapshot));
}


The ownership projection is particularly important here. The LLM should preferably not be shown nodes it cannot schedule. Even if it is, validation prevents authority leakage.

9. Keep fallback outside the core

It is tempting to add many combinators, but the semantic core only needs:

choose(...)
separate(...)
agent(...)


Fallback is an ordinary function:

function orElse<N, E>(
  primary: Scheduler<N, E>,
  fallback: Scheduler<N, E>,
): Scheduler<N, E> {
  return snapshot => {
    const decision = primary(snapshot);

    return decision.selected.length > 0
      ? decision
      : fallback(snapshot);
  };
}


Denotationally:

⟦S1◃S2⟧(σ)={⟦S1⟧(σ),if nonempty⟦S2⟧(σ),otherwise\llbracket S_1 \mathbin{\triangleleft} S_2 \rrbracket(\sigma) = \begin{cases} \llbracket S_1 \rrbracket(\sigma), & \text{if nonempty}\\ \llbracket S_2 \rrbracket(\sigma), & \text{otherwise} \end{cases}

This operator does not separate authority. Both schedulers see the same ownership domain, but only one decision is used.

For an asynchronous agent:

function asyncOrElse<N, E>(
  primary: AsyncScheduler<N, E>,
  fallback: AsyncScheduler<N, E>,
): AsyncScheduler<N, E> {
  return async snapshot => {
    try {
      const decision = await primary(snapshot);

      return decision.selected.length > 0
        ? decision
        : fallback(snapshot);
    } catch {
      return fallback(snapshot);
    }
  };
}

10. Final shallow embedding

A complete scheduler remains small:

const deterministic = roundRobin<Node, Edge>(
  stableNodeOrder,
  1,
);

const reasoning = asyncOrElse(
  agent(async snapshot => {
    return invokeModel({
      available: [...snapshot.available],
      history: snapshot.history,
    });
  }),
  async snapshot => deterministic(snapshot),
);

const scheduler = asyncSeparate(
  {
    left: (snapshot, id) =>
      snapshot.graph.node(id).kind === "reasoning",
  },
  reasoning,
  async snapshot => deterministic(snapshot),
);


The synchronous semantic fragment is:

type Scheduler<N, E> =
  (snapshot: Snapshot<N, E>) => Decision;


with three central denotations:

⟦choose(r,k)⟧:Snapshot→Decision⟦separate(P,S1,S2)⟧:Snapshot→Decision⟦agent(a)⟧:Snapshot→Decision\begin{aligned} \llbracket \mathsf{choose}(r,k) \rrbracket &: \mathsf{Snapshot}\to\mathsf{Decision}\\ \llbracket \mathsf{separate}(P,S_1,S_2) \rrbracket &: \mathsf{Snapshot}\to\mathsf{Decision}\\ \llbracket \mathsf{agent}(a) \rrbracket &: \mathsf{Snapshot}\to\mathsf{Decision} \end{aligned}

Everything else is derived TypeScript:

round-robin is choose with cyclic ranking derived from history;
FIFO is choose ranked by first availability;
priority scheduling is choose ranked by node metadata;
fallback is conditional composition;
an agent plan is adapted to one validated current decision;
hybrid scheduling is separate over disjoint node authority.

The key design choice is that scheduler state is reified in the snapshot rather than hidden inside scheduler closures. That preserves the requested denotational domain, makes executions replayable, and lets separating composition project both authority and local scheduling history.


## OCAML
The core GC implementation is runtime/major_gc.c (runtime/major_gc.c) — major collection, marking, and collection-cycle coordination.

 Related components:
 - runtime/minor_gc.c (runtime/minor_gc.c) — minor collection and promotion.
 - runtime/shared_heap.c (runtime/shared_heap.c) — shared major heap, sweeping, and compaction.