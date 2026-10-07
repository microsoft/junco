import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as E from "fp-ts/lib/Either.js";
import { graph, trigger } from "../src/index.ts";

// graph.Spawn over real Deterministic members on the real parallel policy: the star topology it
// builds, the independent queues in each direction, and members exchanging messages on their own.

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
    "LockPolicy",
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

describe("graph.Spawn", () => {
  test("one child per input, each with its own queue in each direction", async () => {
    const inputs = Object.freeze(["repeat", "repeat"]);
    const calls: string[] = [];
    const started = new Set<Member>();
    const root = idle(started);
    const children: Member[] = [];
    const g = graph.Spawn(
      graph.nodes.deterministicNode(root, {
        trigger: trigger.never(),
        policy: "LockPolicy",
      }),
      inputs,
      (input) => {
        calls.push(input);
        const child = idle(started);
        children.push(child);
        return graph.nodes.deterministicNode(child, {
          trigger: trigger.never(),
          policy: "LockPolicy",
        });
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
      g.emit(graph.NodeId("0"), graph.msg(down1.edge, 10));
      g.emit(graph.NodeId("0"), graph.msg(down1.edge, 11));
      g.emit(graph.NodeId("1"), graph.msg(up1.edge, 20));
      g.emit(graph.NodeId("2"), graph.msg(up2.edge, 30));
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
      left: graph.messageEdge("root->left"),
      right: graph.messageEdge("root->right"),
    };
    const reply: Record<Name, Edge> = {
      left: graph.messageEdge("left->root"),
      right: graph.messageEdge("right->root"),
    };
    const received: Record<Name, number[]> = { left: [], right: [] };
    const closed = { root: false, left: false, right: false };
    const rootId = graph.NodeId("root");
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
      "LockPolicy",
    );
    const g = graph.Spawn(
      graph.nodes.deterministicNode(root, {
        id: rootId,
        trigger: trigger.anyOf(trigger.on(reply.left), trigger.on(reply.right)),
        policy: "LockPolicy",
      }),
      names,
      (name) => {
        const child = new graph.nodes.Deterministic<number, string>(
          async function* () {
            try {
              let view = yield [];
              while (true) {
                view = yield graph
                  .from(view, request[name])
                  .map((value) => graph.msg(reply[name], value + 1));
              }
            } finally {
              closed[name] = true;
            }
          },
          "LockPolicy",
        );
        return graph.nodes.deterministicNode(child, {
          id: graph.NodeId(name),
          trigger: trigger.when(request[name]),
          policy: "LockPolicy",
        });
      },
    );
    try {
      const links = linksOf(g);
      assert.deepEqual([...links.keys()].sort(), [
        "left->root",
        "right->root",
        "root->left",
        "root->right",
      ]);
      g.emit(rootId, graph.msg(request.left, 10));
      g.emit(rootId, graph.msg(request.left, 11));
      g.emit(rootId, graph.msg(request.right, 20));
      g.emit(rootId, graph.msg(request.right, 21));
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
      "LockPolicy",
    );
    const g = graph.Spawn(
      graph.nodes.deterministicNode(root, {
        trigger: trigger.always(),
        policy: "LockPolicy",
      }),
      [] as readonly string[],
      (input) => {
        calls.push(input);
        return graph.nodes.deterministicNode(idle(new Set()), {
          trigger: trigger.never(),
          policy: "LockPolicy",
        });
      },
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
          graph.Spawn(
            graph.nodes.deterministicNode(root, {
              trigger: trigger.never(),
              policy: "LockPolicy",
            }),
            ["a", "b", "c"],
            (input) => {
              visited.push(input);
              if (input === "b") throw failure;
              const child = idle(started);
              created.push(child);
              return graph.nodes.deterministicNode(child, {
                trigger: trigger.never(),
                policy: "LockPolicy",
              });
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
    const rootId = graph.NodeId("root");
    const visited: string[] = [];
    const root = idle(new Set());
    const created: Member[] = [];
    try {
      assert.throws(
        () =>
          graph.Spawn(
            graph.nodes.deterministicNode(root, {
              id: rootId,
              trigger: trigger.never(),
              policy: "LockPolicy",
            }),
            ["a", "b"],
            (input) => {
              visited.push(input);
              const child = idle(new Set());
              created.push(child);
              return graph.nodes.deterministicNode(child, {
                id: rootId,
                trigger: trigger.never(),
                policy: "LockPolicy",
              });
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
