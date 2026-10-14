import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { DummyTracer } from "dataflow-engine";
import * as E from "fp-ts/lib/Either.js";
import { LockPolicy } from "junco-tools";
import { graph, trigger } from "../src/index.ts";

// graph.Spawn over real Deterministic members on the real parallel policy: the star topology it
// builds, the independent queues in each direction, and members exchanging messages on their own.

const quiet = new DummyTracer();

type Edge = graph.Edge<number, string>;
type Member = graph.nodes.Deterministic<number, string>;

/** A dependent member that only records whether its body ever ran. */
function idle(started: Set<Member>): Member {
  const state: Member = new graph.nodes.Deterministic<number, string>(
    async function* () {
      started.add(state);
      yield [];
      return "idle";
    },
    LockPolicy,
  );
  return state;
}

type Link = { readonly edge: Edge; readonly queue: number[] };

/** Every link of `g`, keyed `${from}->${to}`. */
function linksOf(g: graph.JuncoGraph<number, string>): Map<string, Link> {
  const links = new Map<string, Link>();
  g.forEachLink((from, to, edge) => {
    assert.ok(E.isLeft(edge.transport), `${from}->${to} is a message edge`);
    links.set(`${from}->${to}`, { edge, queue: edge.transport.left });
  });
  return links;
}

/** The link keyed `name`; fails the test if absent. */
function linkOf(links: Map<string, Link>, name: string): Link {
  const link = links.get(name);
  assert.ok(link, `link ${name} exists`);
  return link;
}

describe("graph.JuncoGraph.spawn", () => {
  test("one child per input, each with its own queue in each direction", async () => {
    const inputs = Object.freeze(["repeat", "repeat"]);
    const calls: string[] = [];
    const started = new Set<Member>();
    const root = idle(started);
    const children: Member[] = [];
    const g = graph.JuncoGraph.spawn(
      {
        trigger: trigger.TriggerRule.never(),
        state: root,
      },
      inputs,
      (input) => {
        calls.push(input);
        const child = idle(started);
        children.push(child);
        return {
          trigger: trigger.TriggerRule.never(),
          state: child,
        };
      },
    );
    try {
      assert.deepEqual(calls, inputs);
      const nodes: [string, Member][] = [];
      g.forEachNode((id, node) => nodes.push([id, node.state as Member]));
      assert.deepEqual(nodes, [
        ["0", root],
        ["1", children[0]],
        ["2", children[1]],
      ]);
      assert.notEqual(children[0], children[1]);

      const links = linksOf(g);
      assert.deepEqual([...links.keys()].sort(), [
        "0->1",
        "0->2",
        "1->0",
        "2->0",
      ]);
      const all = [...links.values()];
      assert.equal(new Set(all.map(({ edge }) => edge)).size, 4);
      assert.equal(new Set(all.map(({ queue }) => queue)).size, 4);
      for (const [name, { edge }] of links) assert.equal(edge.id, name);

      const down1 = linkOf(links, "0->1");
      const up1 = linkOf(links, "1->0");
      const down2 = linkOf(links, "0->2");
      const up2 = linkOf(links, "2->0");
      g.emit(graph.NodeId.create("0"), graph.Message.create(down1.edge, 10));
      g.emit(graph.NodeId.create("0"), graph.Message.create(down1.edge, 11));
      g.emit(graph.NodeId.create("1"), graph.Message.create(up1.edge, 20));
      g.emit(graph.NodeId.create("2"), graph.Message.create(up2.edge, 30));
      assert.deepEqual([...down1.queue], [10, 11]);
      assert.deepEqual([...up1.queue], [20]);
      assert.deepEqual([...down2.queue], []);
      assert.deepEqual([...up2.queue], [30]);
      assert.equal(started.size, 0);
    } finally {
      await g.close();
    }
    for (const state of [root, ...children]) assert.ok(state.signal.aborted);
  });

  test("members exchange caller-defined messages over the spawned queues", async () => {
    const names = Object.freeze(["left", "right"] as const);
    type Name = (typeof names)[number];
    const request: Record<Name, Edge> = {
      left: graph.Edge.message("root->left"),
      right: graph.Edge.message("root->right"),
    };
    const reply: Record<Name, Edge> = {
      left: graph.Edge.message("left->root"),
      right: graph.Edge.message("right->root"),
    };
    const received: Record<Name, number[]> = { left: [], right: [] };
    const closed = { root: false, left: false, right: false };
    const rootId = graph.NodeId.create("root");
    const root = new graph.nodes.Deterministic<number, string>(
      async function* () {
        try {
          let view = yield [];
          while (true) {
            for (const name of names)
              received[name].push(...graph.from(view, reply[name]));
            if (received.left.length === 2 && received.right.length === 2)
              return "root-done";
            view = yield [];
          }
        } finally {
          closed.root = true;
        }
      },
      LockPolicy,
    );
    const g = graph.JuncoGraph.spawn(
      {
        id: rootId,
        trigger: trigger.TriggerRule.anyOf(
          trigger.TriggerEntry.on(reply.left),
          trigger.TriggerEntry.on(reply.right),
        ),
        state: root,
      },
      names,
      (name) => {
        const child = new graph.nodes.Deterministic<number, string>(
          async function* () {
            try {
              let view = yield [];
              while (true) {
                view = yield graph
                  .from(view, request[name])
                  .map((value) => graph.Message.create(reply[name], value + 1));
              }
            } finally {
              closed[name] = true;
            }
          },
          LockPolicy,
        );
        return {
          id: graph.NodeId.create(name),
          trigger: trigger.TriggerRule.when(request[name]),
          state: child,
        };
      },
      quiet,
    );
    try {
      const links = linksOf(g);
      assert.deepEqual([...links.keys()].sort(), [
        "left->root",
        "right->root",
        "root->left",
        "root->right",
      ]);
      g.emit(rootId, graph.Message.create(request.left, 10));
      g.emit(rootId, graph.Message.create(request.left, 11));
      g.emit(rootId, graph.Message.create(request.right, 20));
      g.emit(rootId, graph.Message.create(request.right, 21));
      const results = await g.run({ signal: AbortSignal.timeout(5000) });
      assert.equal(results.get(rootId), "root-done");
      assert.deepEqual(received, { left: [11, 12], right: [21, 22] });
      for (const { queue } of links.values()) assert.deepEqual([...queue], []);
    } finally {
      await g.close();
    }
    assert.deepEqual(closed, { root: true, left: true, right: true });
  });

  test("no inputs leaves the root alone", async () => {
    const calls: string[] = [];
    const root = new graph.nodes.Deterministic<number, string>(
      async function* () {
        yield [];
        return "solo";
      },
      LockPolicy,
    );
    const g = graph.JuncoGraph.spawn(
      {
        trigger: trigger.TriggerRule.always(),
        state: root,
      },
      [] as readonly string[],
      (input) => {
        calls.push(input);
        return {
          trigger: trigger.TriggerRule.never(),
          state: idle(new Set()),
        };
      },
      quiet,
    );
    try {
      const nodes: string[] = [];
      g.forEachNode((id) => nodes.push(id));
      assert.equal(nodes.length, 1);
      assert.equal(linksOf(g).size, 0);
      const results = await g.run({ signal: AbortSignal.timeout(5000) });
      assert.deepEqual([...results], [[nodes[0], "solo"]]);
      assert.deepEqual(calls, []);
    } finally {
      await g.close();
    }
  });

  test("a factory error escapes as-is and stops construction", async () => {
    const failure = new Error("spawn failed");
    const visited: string[] = [];
    const started = new Set<Member>();
    const root = idle(started);
    const created: Member[] = [];
    try {
      assert.throws(
        () =>
          graph.JuncoGraph.spawn(
            {
              trigger: trigger.TriggerRule.never(),
              state: root,
            },
            ["a", "b", "c"],
            (input) => {
              visited.push(input);
              if (input === "b") throw failure;
              const child = idle(started);
              created.push(child);
              return {
                trigger: trigger.TriggerRule.never(),
                state: child,
              };
            },
          ),
        (error) => error === failure,
      );
      assert.deepEqual(visited, ["a", "b"]);
      assert.equal(created.length, 1);
      for (const state of [root, ...created]) assert.ok(!state.signal.aborted);
      assert.equal(started.size, 0);
    } finally {
      for (const state of [root, ...created]) await state.close();
    }
  });

  test("a child reusing the root's explicit id is a definition error", async () => {
    const rootId = graph.NodeId.create("root");
    const visited: string[] = [];
    const root = idle(new Set());
    const created: Member[] = [];
    try {
      assert.throws(
        () =>
          graph.JuncoGraph.spawn(
            {
              id: rootId,
              trigger: trigger.TriggerRule.never(),
              state: root,
            },
            ["a", "b"],
            (input) => {
              visited.push(input);
              const child = idle(new Set());
              created.push(child);
              return {
                id: rootId,
                trigger: trigger.TriggerRule.never(),
                state: child,
              };
            },
          ),
        graph.DataflowDefinitionError,
      );
      assert.deepEqual(visited, ["a"]);
    } finally {
      for (const state of [root, ...created]) await state.close();
    }
  });
});
