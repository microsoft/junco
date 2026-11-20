# Junco

Junco is a multi-agent system for policy-validated software engineering at scale. It separates the data dependency graph ("what work must be done") from a learned scheduler ("when and at what cost to do it") and policy ("what not to do"). A multi-agent system that is profiled, analyzed and optimized this way can match or beat other multi-agent frameworks on software engineering benchmarks at a fraction of the cost: on CooperBench, Junco solves 38/50 paired features versus 31/50 for the best existing team harness, and resolves tasks at $0.55 each versus $1.70 to $7.98 for other frameworks.

![Junco architecture: junco over dataflow-engine, junco-scheduler and the Pi layer (junco-agent on pi-coding-agent, and junco-tools with its 18 tools); junco-tools calls the Rust crates marsh and rust-graph; marsh checks every event with the Verus-verified junco-policy and hosts rmux-server, whose brush-core shells run inside Btrfs snapshots](assets/svg/architecture.svg)

## How to use

### Prerequisites

Junco runs only on Linux, on Btrfs. Install:

- [Bun](https://bun.com/docs/installation) 1.4.2
- [Pi](https://docs.pi.dev/latest/quickstart), the agent harness Junco drives
- Rust 1.98.1 through [rustup](https://rust-lang.org/tools/install/)
- Clang and libbtrfsutil. On Ubuntu:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends \
  build-essential pkg-config clang libclang-dev llvm-dev \
  libbtrfsutil-dev zlib1g-dev ca-certificates curl git
```

### Prerequisites for observability

Opik and Grafana run in Docker containers started by Docker Compose from [`docker-compose.yml`](docker-compose.yml). On Ubuntu, install Docker Engine and the Compose plugin from [Docker's apt repository](https://docs.docker.com/engine/install/ubuntu/). Remove Ubuntu's `docker.io`, `docker-compose` and `docker-compose-v2` packages first if they are installed.

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"   # log out and back in to run docker without sudo
docker compose version
```

The Compose file includes Opik's own deployment from a checkout beside this one:

```sh
git clone https://github.com/comet-ml/opik.git ../opik
```

### Install

```sh
bun install --frozen-lockfile  # also builds the native addon
bun run install                # interactive: global CLIs plus the skills for the harnesses you pick
```

`bun run install` installs the `junco-profile-optimizer` CLI and copies the three skills into the harnesses you pick: GitHub Copilot CLI, Claude Code, Pi, OpenAI Codex or OpenCode.

### Set up a Btrfs subvolume

Marsh stages concurrent file access to prevent races, so Junco needs a Btrfs copy-on-write file system: either an existing Btrfs subvolume or a new loopback image. Agents work in a dedicated subvolume, the seed. Junco finds the seed that encloses the working directory and never creates one.

#### Existing Btrfs subvolume

The mount needs the option `user_subvol_rm_allowed`; Marsh refuses to run without it. Add the option to the mount's `/etc/fstab` entry to keep it after a reboot.

```sh
findmnt -T "$HOME/work" -o TARGET,FSTYPE,OPTIONS             # expect btrfs
sudo mount -o remount,user_subvol_rm_allowed /mount/target   # TARGET from findmnt
btrfs subvolume create "$HOME/work/seed"                     # clone your repository inside it
```

#### New Btrfs loopback

```sh
truncate -s 32G junco.img && mkfs.btrfs -q junco.img
sudo mount -o loop,user_subvol_rm_allowed,compress=zstd:1 junco.img /mnt/junco
sudo btrfs subvolume create /mnt/junco/seed && sudo chown "$USER" /mnt/junco/seed
```

### My first Junco workflow

A workflow has two files. `name.yml` declares the nodes, edges and triggers. `name.ts` builds it with `JuncoGraph.fromYaml(source, { cwd, scheduler, ladder, ... })`, awaits `execution.run()` and closes the graph; `cwd` selects the seed. In [`examples/first`](examples/first), two agents answer one question by browsing with the Playwright MCP server, and a reviewer merges their answers:

```yaml
graph:
  name: First
  nodes:
    Goals:
      kind: emit
      text: What are the current stable versions of Bun and of Rust, and when were they released? Cite the page you read each answer from.
      spec: Both versions and release dates are stated, each with a cited source page.
    Bun:
      prompt: Answer the question in the user message(s) following this prompt for Bun only, browsing from https://bun.sh with the playwright tools.
    Rust:
      prompt: Answer the question in the user message(s) following this prompt for Rust only, browsing from https://www.rust-lang.org with the playwright tools.
    Reviewer:
      prompt: |-
        Merge the two answers below into one table of tool, version, release date and source URL. Keep a claim only if it cites a page.

        Bun:
        {{Bun->Reviewer}}

        Rust:
        {{Rust->Reviewer}}
  edges:
    - {from: Goals, to: Bun, kind: message, schema: {}}
    - {from: Goals, to: Rust, kind: message, schema: {}}
    - {from: Bun, to: Reviewer, schema: {}}
    - {from: Rust, to: Reviewer, schema: {}}
    - {from: Reviewer, to: $sink, schema: {}}
```

MCP servers are attached in TypeScript like every other tool: `mcp.McpBuilder` opens a tool collection and connects each added stdio server on it, one process per server, published in `collection.tools` and closed with the collection. An agent over a collection gets all of its tools; `first.ts` builds one per browsing agent through `createAgent`, so `Bun` and `Rust` run in parallel, each with its own Playwright server (`mcp__playwright__*`) next to the built-in coding tools and the coordination tools `task`, `yield`, `send` and `info`, plus the default `complain` tool, which is enabled separately. `Reviewer` gets no server. `tool_block` removes names a node must not use. `Goals` sends its text once on each `~>` message edge. Each agent gets its prompt first and the delivered question after it. `Reviewer` runs once both `->` value edges hold a result, and reads them through the `{{edge}}` placeholders.

The scheduler decides which queued messages a node reads: each `NodeModel` it selects lists those edges in `readEdges`. `schedules.select(snapshot, ids, strength?)` reads the edges from `schedules.plannedReads(snapshot, id)` by default, and `schedules.reads(assign, inner)` overrides them. `schedules.reads(() => [], schedules.parallel())` runs nodes without consuming any message. If a decision is invalid, the scheduler is asked again with `snapshot.lastError`, up to three attempts in all, and then the run throws.

Each message a node reads reaches the agent as its own user message, in delivery order. `Task` text and images arrive as message content, the text followed by a `Task:` JSON line with the task's id, spec, deps and history, and the agent does not dispatch on their `kind`. Other payloads arrive as `JSON.stringify({ id, payload })`. Write prompts that refer to these messages, as the `Bun` and `Rust` prompts do, instead of copying their content. Value edges never arrive as messages. Prompt callbacks and YAML placeholders read them, and a placeholder that names a message edge fails at build time. Prompts can also use `params` substitutions.

Models and MCP servers are chosen in TypeScript. The YAML never names either:

```ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { graph, JuncoGraph, mcp, schedules, syntax, type tools, tracer } from "junco";
import source from "./first.yml" with { type: "text" };

const models = await ModelRuntime.create();
const ladder = new schedules.ModelLadder(models, schedules.uniformLadder({ model: "github-copilot/claude-sonnet-5.5", thinking: "medium" }));
const playwright = { name: "playwright", type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] } as const;
/** One Playwright server, and so one browser, per browsing agent: its own collection. */
const browsers = new Map<string, tools.ToolCollection>();
const observer = tracer.TuiTracer.shared();
let answer: string;
try {
  for (const node of ["Bun", "Rust"]) browsers.set(node, await new mcp.McpBuilder().add(playwright).build(process.cwd()));
  const execution = await JuncoGraph.fromYaml(source, {
    cwd: process.cwd(),
    scheduler: () => schedules.parallel(),
    ladder,
    createAgent: (spec) => syntax.createJuncoAgent({ ...spec, collection: browsers.get(spec.node) }, ladder),
    tracer: observer,
  });
  try {
    const results = await execution.run();
    answer = syntax.finalText(results.get(graph.NodeId.create("Reviewer")), "Reviewer");
  } finally {
    await execution.graph.close();
  }
} finally {
  for (const collection of browsers.values()) await collection.close();
  if (observer instanceof tracer.TuiTracer) await observer.finish();
}
console.log(answer);
```

```sh
pi                                                      # once: `/login`, pick GitHub Copilot, quit
cd "$HOME/work/seed" && bun run /path/to/junco/examples/first/first.ts
```

### The three skills

Installed skills answer plain requests; no slash command.

| Skill | Ask your harness to | What happens |
| --- | --- | --- |
| `junco-graph-create` | build "a multi-agent workflow", "fan-out/fan-in", "a Ralph loop", "committee rounds", "an agent pipeline" | Writes a runnable `name.yml` + `name.ts` pair from the standard workflows and schedulers in the [standard library](https://github.com/microsoft/junco/wiki/Standard-Library). |
| `junco-graph-optimizer` | "restructure", "decompose", "add a tournament to" or "prune" an existing graph | Rewrites the YAML topology from measured runs; models, scheduler and limits stay. |
| `junco-profile-optimizer` | "profile", "tune", "cheapen", "speed up" or "shrink" a workflow, "compare schedulers or model ladders" | Hill climbing over the unbounded space of models, thinking levels, scheduler configurations and limits (memory, CPU, tool calls), measuring each step, until the objective (USD, tokens, memory or a probe) converges while quality thresholds hold. |

<p>
<img src="assets/svg/graph-rewriting.svg" width="32%" alt="Graph rewriting: A and B, which both progress, become one worker C; R, which keeps backtracking, becomes R1, R2 and R3 with a fan-out and join">
<img src="assets/svg/parameter-optimization.svg" width="32%" alt="Parameter optimization loop: try parameters, run the rewritten graph, profile cost and quality, repeat; the adopted configuration costs $0.986 per run">
<img src="assets/svg/optimizer-cost-per-node.svg" width="32%" alt="Catalog USD per run for each agent role across the eight optimizer iterations; iteration 6 failed and has no point">
</p>

On the CooperBench pair the profile optimizer searched schedulers, model ladders and tool caps. GPT-6.1 Sol leading GPT-6 Luna workers cut the mean cost per run from $1.101 to $0.986 while resolving 5 of 5 pairs instead of 2 to 3.

## Results

### CooperBench

<p>
<img src="assets/svg/cooperbench-flash.svg" width="31%" alt="CooperBench flash, 50 pairs: Junco 38, CooperBench team harness 31, solo agent 24">
<img src="assets/svg/cooperbench-cost.svg" width="31%" alt="USD per solved pair on CooperBench core with solved count and wall time: Junco $0.55 (6/10, 9.7 min), claude_code ~$1.70 (5/10, 21 min), mini_swe_agent_v2 $2.23 (6/10, 24 min), openhands_sdk $7.98 (4/10, 16 min)">
<img src="assets/svg/workload-events.svg" width="36%" alt="Recorded problem events in CooperBench runs on LlamaIndex and Jinja: lost updates, stale state, other">
</p>

Two agents implement one pair of features on a shared checkout and succeed when both hidden suites pass on one merged tree. Junco's shared-worktree graph solved 38/50 in each of two independent runs; on CooperBench core the two-agent graph on claude-sonnet-5 spent $3.31 in total.

The problem events CooperBench records are lost updates and stale state, the two classes the ownership policy rejects. Recovering from one costs about 240K model tokens, about $4.7K across all of CooperBench.

### The policy validator

![Runtime policy validation: C reads package.json, R1 edits it, C's later edit is rejected and C must re-read](assets/svg/policy-validation.svg)

Every tool call is an event (agent, action, resource) checked against the policy and the history before it runs. The policy evaluation and history core is verified with Verus, and the engine is being integrated into Regorus, Azure's policy tool.

#### Checking is fast and policies are analyzable

<p>
<img src="assets/svg/lock.svg" width="32%" alt="Lock-policy decision runtime over committed trace lengths from 2^4 to 2^16 events, by operation; green points are grants and red points denials">
<img src="assets/svg/other.svg" width="32%" alt="Junco speedup over Dogwood and VeriMon on cold lock-policy replay at 16, 64, 256 and 1024 events">
<img src="assets/svg/regex-lib-cdf.svg" width="32%" alt="RegExLib inclusion latency CDF: all 90 sat cases complete by 45.50 ms, all 10 unsat cases by 6.79 ms">
</p>

Warm decisions: about 0.3 µs per read, under 0.2 ms per edit or remove at 65,536 committed events. Cold replay: 56 to 190 times faster than Dogwood and 47 to 169 times faster than VeriMon.

Policies are trace languages, so the same engine decides whether one policy subsumes another ($P \subseteq P'$), whether a policy accepts no trace or every trace ($P \subseteq \bot$, $\top \subseteq P$), and whether known good traces are allowed ($\{t_i\} \subseteq P$). The CDF covers the 100 RegExLib inclusion problems of the SMT-LIB regex benchmark.

## Further reading

- [`packages/dataflow-engine`](packages/dataflow-engine/README.md), [`packages/junco-tools`](packages/junco-tools/README.md), [`crates/marsh`](crates/marsh/README.md), [`crates/junco-policy`](crates/junco-policy/README.md).
- [`examples/`](examples): recursive agency, mixed, OSS committee, CaMeL, MCP, Verus loop, Yak shaver, CooperBench and SWE-bench.
- [Standard library wiki page](https://github.com/microsoft/junco/wiki/Standard-Library).
