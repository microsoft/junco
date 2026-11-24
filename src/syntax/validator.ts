/**
 * Junco graph document validation.
 *
 * Every edge (message, value or default-kind, at every graph level) requires a `schema:` mapping:
 * a JSON Schema Draft 2020-12 object, checked against TypeBox's installed 2020-12 meta-schema
 * before any agent or resource exists. An explicit `$schema` must name that dialect. Supported
 * keywords are the 2020-12 assertions/applicators TypeBox implements plus the meta-data
 * annotations and `$comment`/`$defs`; unknown keywords and unregistered `format` names are
 * rejected. Schemas must be acyclic JSON values (shared YAML anchors are fine).
 *
 * References are self-contained: `$ref` must be a local JSON pointer (`#` or `#/...`) to a schema
 * position of the same edge schema, typically under `$defs`. External/anchor references,
 * resource keywords (`$id`, `$anchor`, `$dynamic*`, `$recursive*`, `$vocabulary`) and reference
 * cycles that never descend into the payload are rejected; recursion through `properties`,
 * `items` and other child positions is allowed. The edge factory supplies the root resource ID.
 */
import type { NodeIdType } from "dataflow-engine";
import type { TLocalizedValidationError } from "typebox/error";
import { Format } from "typebox/format";
import Schema from "typebox/schema";
import { Value } from "typebox/value";
import { type Fail, pointer, ValidationError } from "./errors.js";
import {
  AgentNodeSchema,
  declaredTrigger,
  type EdgeSpec,
  edgeId,
  type GraphSpec,
  type JuncoDocument,
  JuncoDocumentSchema,
  nodeKey,
  PLACEHOLDER,
  type TriggerSpec,
  walk,
} from "./schema.js";

const list = (items: readonly string[]) =>
  items.length ? items.map((item) => `"${item}"`).join(", ") : "(none)";

/** Reject a cyclic object graph (shared acyclic aliases are fine) before recursive checking. */
function acyclic(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  fail: Fail,
): void {
  if (typeof value !== "object" || value === null) return;
  if (ancestors.has(value))
    fail(
      path || "/",
      "cyclic value",
      "replace the self-referencing alias with a copy; recursive edge schemas use a local $ref",
      "document",
    );
  ancestors.add(value);
  for (const [key, child] of Object.entries(value))
    acyclic(child, `${path}/${pointer(key)}`, ancestors, fail);
  ancestors.delete(value);
}
/** Schema mappings are JSON: plain objects, arrays, strings, finite numbers, booleans, null. */
function json(value: unknown, path: string, fail: Fail): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    Number.isFinite(value)
  )
    return;
  const proto = typeof value === "object" && Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value))
    fail(
      path,
      "schema must be a JSON value",
      "use only mappings, lists, strings, finite numbers, booleans and null in edge schemas",
      "edge-schema",
    );
  for (const [key, child] of Object.entries(value as object))
    json(child, `${path}/${pointer(key)}`, fail);
}

/** A repair hint from a TypeBox error's keyword and params. */
function repair(error: TLocalizedValidationError): string {
  switch (error.keyword) {
    case "required":
      return `add the missing field(s): ${error.params.requiredProperties.join(", ")}`;
    case "enum":
      return `use one of: ${error.params.allowedValues.map((v) => JSON.stringify(v)).join(", ")}`;
    case "const":
      return `use ${JSON.stringify(error.params.allowedValue)} or another form this position accepts`;
    case "type":
      return `change this value to type ${[error.params.type].flat().join(" or ")}`;
    default:
      return `change this value: it ${error.message}`;
  }
}
/** Fail with TypeBox's first error, naming a forbidden property rather than its parent object. */
function failTypeBox(
  errors: readonly TLocalizedValidationError[],
  base: string,
  code: string,
  fail: Fail,
): never {
  const [error] = errors;
  if (error === undefined)
    fail(base || "/", "invalid value", "correct this value", code);
  // A forbidden property surfaces as a `boolean` error at it, then as its parent's detail.
  for (const extra of errors) {
    if (extra.keyword !== "additionalProperties") continue;
    const names = extra.params.additionalProperties;
    const name =
      error.keyword === "additionalProperties"
        ? names[0]
        : error.keyword === "boolean"
          ? names.find(
              (n) =>
                `${extra.instancePath}/${pointer(n)}` === error.instancePath,
            )
          : undefined;
    if (name !== undefined)
      fail(
        `${base}${extra.instancePath}/${pointer(name)}`,
        `unknown property "${name}"`,
        `remove "${name}" or correct its spelling`,
        code,
        { target: "key" },
      );
  }
  fail(
    `${base}${error.instancePath}` || "/",
    error.message,
    repair(error),
    code,
  );
}

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const META = Schema.Meta[DIALECT];
/** Supported keywords and what their value holds: data, one subschema, a list or a map of them. */
const KEYWORDS = new Map<string, "data" | "schema" | "list" | "map">();
for (const [position, words] of [
  [
    "schema",
    "additionalProperties propertyNames contains items if then else not unevaluatedItems unevaluatedProperties",
  ],
  ["map", "$defs properties patternProperties dependentSchemas"],
  ["list", "prefixItems allOf anyOf oneOf"],
  [
    "data",
    "$schema $ref $comment type const enum multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern maxItems minItems uniqueItems maxContains minContains maxProperties minProperties required dependentRequired format title description default deprecated readOnly writeOnly examples",
  ],
] as const)
  for (const word of words.split(" ")) KEYWORDS.set(word, position);
/** Applicators that evaluate the same instance: a reference cycle through only these never progresses. */
const IN_PLACE = new Set(
  "allOf anyOf oneOf not if then else dependentSchemas".split(" "),
);
const RESOURCE = new Set(
  "$id $anchor $dynamicRef $dynamicAnchor $recursiveRef $recursiveAnchor $vocabulary".split(
    " ",
  ),
);
const LOCAL_REF = 'reference a local schema such as "#/$defs/<name>"';

/** Validate one edge's JSON Schema mapping at `path` (`.../edges/<index>/schema`). */
function checkSchema(root: unknown, path: string, fail: Fail): void {
  json(root, path, fail);
  let valid = false;
  let errors: readonly TLocalizedValidationError[] = [];
  try {
    [valid, errors] = Schema.Errors(META, root);
  } catch (cause) {
    fail(
      path,
      "schema validation failed",
      "write the schema as a JSON Schema 2020-12 mapping",
      "edge-schema",
      { cause },
    );
  }
  if (!valid) failTypeBox(errors, path, "edge-schema", fail);
  // One walk over schema positions only (never const/enum/default/examples data).
  const positions = new Map<string, string[]>(); // pointer -> in-place successors
  const refs: [from: string, ref: string, next: string[]][] = [];
  const visitSchema = (schema: unknown, at: string): void => {
    const next: string[] = [];
    positions.set(at, next);
    if (typeof schema === "boolean") return;
    for (const [key, value] of Object.entries(schema as object)) {
      const here = `${at}/${pointer(key)}`;
      if (RESOURCE.has(key))
        fail(
          `${path}${here}`,
          `"${key}" is not supported in junco schemas`,
          `remove "${key}"; junco supplies the schema's resource id, so ${LOCAL_REF}`,
          "edge-schema",
          { target: "key" },
        );
      const position = KEYWORDS.get(key);
      if (position === undefined)
        fail(
          `${path}${here}`,
          `unknown schema keyword "${key}"`,
          `remove "${key}" or correct it to a supported JSON Schema 2020-12 keyword`,
          "edge-schema",
          { target: "key" },
        );
      if (key === "$schema" && value !== DIALECT)
        fail(
          `${path}${here}`,
          `only the ${DIALECT} dialect is supported`,
          `set $schema to ${DIALECT} or remove it`,
          "edge-schema",
        );
      if (key === "format" && !Format.Has(value))
        fail(
          `${path}${here}`,
          `unknown format "${value}"`,
          "remove format or use a standard format such as date-time, email, uri or uuid",
          "edge-schema",
        );
      if (key === "$ref") refs.push([at, value, next]);
      const children: [string, unknown][] =
        position === "schema"
          ? [[here, value]]
          : position === "map"
            ? Object.entries(value).map(([k, v]) => [
                `${here}/${pointer(k)}`,
                v,
              ])
            : position === "list"
              ? (value as unknown[]).map((v, i) => [`${here}/${i}`, v])
              : [];
      for (const [child, subschema] of children) {
        if (IN_PLACE.has(key)) next.push(child);
        visitSchema(subschema, child);
      }
    }
  };
  visitSchema(root, "");
  for (const [from, ref, next] of refs) {
    const at = `${path}${from}/$ref`;
    if (!ref.startsWith("#"))
      fail(
        at,
        `external reference "${ref}" is not supported`,
        `copy the referenced schema under $defs and ${LOCAL_REF}`,
        "edge-schema",
      );
    let fragment = "";
    try {
      fragment = decodeURIComponent(ref.slice(1));
    } catch (cause) {
      fail(
        at,
        `malformed reference "${ref}"`,
        "percent-encode the reference as a valid URI fragment",
        "edge-schema",
        { cause },
      );
    }
    if (fragment !== "" && !fragment.startsWith("/"))
      fail(
        at,
        `anchor reference "${ref}" is not supported`,
        `replace the anchor with a JSON pointer; ${LOCAL_REF}`,
        "edge-schema",
      );
    const target = Schema.Pointer.Indices(fragment)
      .map((key) => `/${pointer(key)}`)
      .join("");
    if (!Schema.Pointer.Has(root, target))
      fail(
        at,
        `reference "${ref}" has no target`,
        "add the referenced schema under $defs or correct the pointer",
        "edge-schema",
      );
    if (!positions.has(target))
      fail(
        at,
        `reference "${ref}" does not target a schema`,
        `point the reference at a schema position; ${LOCAL_REF}`,
        "edge-schema",
      );
    next.push(target);
  }
  // Depth-first search over in-place successors; a back edge is a non-progressing cycle.
  const done = new Set<string>();
  const active = new Set<string>();
  const progress = (at: string): void => {
    if (done.has(at)) return;
    if (active.has(at))
      fail(
        `${path}${at}`,
        "reference cycle never descends into the payload",
        "make the recursion pass through properties, items or another child schema",
        "edge-schema",
      );
    active.add(at);
    const successors = positions.get(at);
    if (successors === undefined)
      throw new Error(`junco-syntax: unknown schema position "${at}"`);
    for (const next of successors) progress(next);
    active.delete(at);
    done.add(at);
  };
  for (const at of positions.keys()) progress(at);
}

const mapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** TypeBox caps union errors; a wrapper's unused variants can hide a nested field's diagnostic. */
function checkGraphFields(spec: unknown, path: string, fail: Fail): void {
  if (!mapping(spec)) return;
  if (Array.isArray(spec.edges))
    for (const [i, edge] of spec.edges.entries()) {
      if (!mapping(edge)) continue;
      const at = `${path}/edges/${i}/schema`;
      if (!("schema" in edge))
        fail(
          at,
          "edge requires a schema mapping",
          "add schema: {} for an unconstrained payload, or a JSON Schema Draft 2020-12 mapping",
          "edge-schema",
        );
      if (!mapping(edge.schema))
        fail(
          at,
          "edge schema must be a mapping",
          "replace this value with schema: {} or a JSON Schema Draft 2020-12 mapping",
          "edge-schema",
        );
    }
  if (!mapping(spec.nodes)) return;
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (!mapping(node)) continue;
    const at = `${path}/nodes/${pointer(id)}`;
    if (node.kind === "graph") checkGraphFields(node.graph, `${at}/graph`, fail);
    else if ((node.kind === undefined || node.kind === "agent") && !Value.Check(AgentNodeSchema, node))
      failTypeBox(Value.Errors(AgentNodeSchema, node), at, "document", fail);
  }
}

const reject: Fail = (path, message, help, code, { cause } = {}) => {
  throw new ValidationError({ path, message, help, code, cause });
};

/** Return the same document if valid; the parser supplies a reporter for YAML source locations. */
function validate(value: unknown, fail: Fail = reject): JuncoDocument {
  acyclic(value, "", new Set(), fail);
  if (!Value.Check(JuncoDocumentSchema, value)) {
    if (mapping(value)) checkGraphFields(value.graph, "/graph", fail);
    failTypeBox(Value.Errors(JuncoDocumentSchema, value), "", "document", fail);
  }
  const doc = value as JuncoDocument;
  /** Identifiers may hold any text except none: reject empty and whitespace-only names. */
  const identifier = (
    name: string,
    at: string,
    target: "key" | "value" = "value",
  ) => {
    if (name.trim() === "")
      fail(
        at,
        `identifier ${JSON.stringify(name)} is blank`,
        "use a name with at least one non-whitespace character",
        "identifier",
        { target },
      );
  };
  /** Reject a list that names one identifier twice, at the second occurrence. */
  const unique = (names: readonly string[], at: string, what: string) => {
    const seen = new Map<string, string>();
    for (const [index, name] of names.entries()) {
      const here = `${at}/${index}`;
      identifier(name, here);
      const first = seen.get(name);
      if (first !== undefined)
        fail(
          here,
          `${what} lists "${name}" twice`,
          `remove the repeated entry; "${name}" is first listed at ${first}`,
          "duplicate",
        );
      seen.set(name, here);
    }
  };
  for (const name of Object.keys(doc.skills ?? {}))
    identifier(name, `/skills/${pointer(name)}`, "key");
  function checkGraph(
    spec: GraphSpec,
    path: string,
    label: string,
    parentInbound?: readonly EdgeSpec[],
  ): void {
    const edges = spec.edges ?? [];
    const declared = new Map<string, string>(); // edge id -> declaring path
    for (const id of Object.keys(spec.nodes)) {
      identifier(id, `${path}/nodes/${pointer(id)}`, "key");
      if (id === "$source" || id === "$sink")
        fail(
          `${path}/nodes/${pointer(id)}`,
          `node id "${id}" is reserved`,
          `rename the node; "$source" and "$sink" name the graph's implicit ports`,
          "node",
          { target: "key" },
        );
    }
    for (const [index, edge] of edges.entries()) {
      const at = `${path}/edges/${index}`;
      if (edge.id !== undefined) identifier(edge.id, `${at}/id`);
      identifier(edge.from, `${at}/from`);
      identifier(edge.to, `${at}/to`);
      checkSchema(edge.schema, `${at}/schema`, fail);
      if (edge.probe === true) {
        // Only an explicit top-level numeric `type` qualifies; no schema inference.
        const { type } = edge.schema as { readonly type?: unknown };
        if (type !== "number" && type !== "integer")
          fail(
            `${at}/probe`,
            'probe requires schema.type to be "number" or "integer"',
            'set schema.type to "number" or "integer", or remove probe',
            "document",
          );
      }
      const id = edgeId(edge);
      if (
        edge.to === "$source" &&
        (edge.from === "$source" || edge.kind !== "message" || edge.on === "return")
      )
        fail(
          `${at}/to`,
          "Graph source credits must be ordinary messages from another node",
          "use an ordinary message edge from a declared node and name it in source.trigger",
          "port",
        );
      if (edge.from === "$sink")
        fail(
          `${at}/from`,
          "Graph sink cannot have outbound edges",
          "start the edge at $source or a declared node",
          "port",
        );
      if (edge.from === "$source" && edge.kind !== "message")
        fail(
          edge.kind === undefined ? at : `${at}/kind`,
          "Graph source cannot produce value edges",
          "set kind: message on edges from $source",
          "port",
        );
      for (const [end, port] of [
        ["from", "$source"],
        ["to", "$sink"],
      ] as const) {
        const node = edge[end];
        if (node !== port && node !== "$source" && !Object.hasOwn(spec.nodes, node))
          fail(
            `${at}/${end}`,
            `edge "${id}" references unknown node "${node}"`,
            `declare "${node}" under ${path}/nodes, or use ${port} or one of: ${list(Object.keys(spec.nodes))}`,
            "reference",
          );
      }
      if (edge.on === "return") {
        if (edge.kind !== "message")
          fail(
            `${at}/on`,
            "on: return requires kind: message",
            "set kind: message or remove on: return",
            "document",
          );
        const producer = spec.nodes[edge.from];
        if (
          edge.from === "$source" ||
          producer?.kind === "emit" ||
          (producer?.kind === "graph" && producer.graph.sink?.stream === true)
        )
          fail(
            `${at}/on`,
            `Node "${edge.from}" does not return a value`,
            "remove on: return to receive explicit messages",
            "port",
          );
      }
      const first = declared.get(id);
      if (first !== undefined)
        fail(
          edge.id === undefined ? at : `${at}/id`,
          `edge "${id}" declared twice`,
          `give this edge a distinct id; "${id}" is first declared at ${first}`,
          "duplicate",
        );
      declared.set(id, at);
    }
    // Declared nodes and $sink, plus $source only when wired; both maps keep that order.
    const wired = edges.some((e) => e.from === "$source" || e.to === "$source");
    const ids = [
      ...(wired ? ["$source"] : []),
      ...Object.keys(spec.nodes),
      "$sink",
    ];
    const incoming = new Map(ids.map((id): [string, EdgeSpec[]] => [id, []]));
    const outgoing = new Map(ids.map((id): [string, EdgeSpec[]] => [id, []]));
    for (const edge of edges) {
      incoming.get(edge.to)?.push(edge);
      outgoing.get(edge.from)?.push(edge);
    }
    const canStart = new Set<string>();
    const pendingInputs = new Map<string, number>();
    const watched = new Set<string>();
    function checkTrigger(id: string, at: string, trigger?: TriggerSpec): void {
      const inbound = (incoming.get(id) ?? []).map(edgeId);
      const rule = declaredTrigger(trigger ?? { all: inbound });
      const all = "all" in rule;
      const entries = all ? rule.all : rule.any;
      const base =
        typeof trigger === "object" ? `${at}/${all ? "all" : "any"}` : at;
      if (typeof trigger === "object")
        unique(entries, base, `Node "${id}" trigger`);
      else if (typeof trigger === "string" && entries[0] !== undefined)
        identifier(entries[0], base);
      for (const [index, e] of entries.entries())
        if (trigger !== undefined && !inbound.includes(e))
          fail(
            typeof trigger === "object" ? `${base}/${index}` : base,
            `Node "${id}" trigger references edge "${e}" which is not one of its inbound edges`,
            inbound.length
              ? `use one of its inbound edges: ${list(inbound)}`
              : `add an edge with id "${e}" into "${id}", or remove the trigger`,
            "trigger",
          );
      if (id === "$source")
        for (const e of inbound)
          if (!entries.includes(e))
            fail(
              declared.get(e)!,
              `Source credit "${e}" is not named in source.trigger`,
              "add the credit to source.trigger or remove the edge",
              "trigger",
            );
      if (all && entries.length === 0) canStart.add(id);
      else if (entries.length > 0) {
        pendingInputs.set(id, all ? entries.length : 1);
        for (const e of entries) watched.add(e);
      }
    }
    if (wired || spec.source?.trigger !== undefined)
      checkTrigger("$source", `${path}/source/trigger`, spec.source?.trigger ?? "always");
    const predecessors = [
      ...new Set((incoming.get("$sink") ?? []).map((e) => e.from)),
    ];
    if (predecessors.length === 0)
      fail(
        path,
        "$sink needs at least one inbound edge",
        "add an edge to $sink from the node whose result this graph returns",
        "sink-result",
      );
    const returns = spec.sink?.returns;
    if (spec.sink?.stream === true) {
      // A streaming sink forwards messages and never returns, so no result is inferred.
      if (returns !== undefined)
        fail(
          `${path}/sink/returns`,
          "Streaming sink must not declare sink.returns",
          "remove sink.returns; a streaming sink forwards messages and never returns",
          "sink-result",
        );
      for (const [index, edge] of edges.entries())
        if (edge.to === "$sink" && edge.kind !== "message")
          fail(
            edge.kind === undefined
              ? `${path}/edges/${index}`
              : `${path}/edges/${index}/kind`,
            "Streaming sink accepts only message edges",
            "set kind: message on every edge into a streaming $sink",
            "sink-result",
          );
    } else {
      if (returns !== undefined) {
        identifier(returns, `${path}/sink/returns`);
        if (!predecessors.includes(returns))
          fail(
            `${path}/sink/returns`,
            `sink.returns "${returns}" has no edge to $sink`,
            `add an edge from "${returns}" to $sink, or return one of: ${list(predecessors)}`,
            "sink-result",
          );
      } else if (predecessors.length > 1)
        fail(
          spec.sink === undefined ? path : `${path}/sink`,
          `sink.returns is required: $sink has inbound edges from ${predecessors.join(", ")}`,
          `set sink.returns to the node whose result the graph returns: ${list(predecessors)}`,
          "sink-result",
        );
      // Neither source deliveries nor one-shot emit publications produce a result.
      const result = returns ?? predecessors[0] ?? "";
      if (result === "$source" || spec.nodes[result]?.kind === "emit")
        fail(
          returns === undefined
            ? `${path}/edges/${edges.findIndex((e) => e.to === "$sink")}`
            : `${path}/sink/returns`,
          `$sink would return "${result}", which never produces a result`,
          "return an agent, code or nested-graph predecessor of $sink instead",
          "sink-result",
        );
    }
    checkTrigger("$sink", `${path}/sink/trigger`, spec.sink?.trigger);
    for (const [id, node] of Object.entries(spec.nodes)) {
      const nodePath = `${path}/nodes/${pointer(id)}`;
      const inbound = incoming.get(id) ?? [];
      const outbound = outgoing.get(id) ?? [];
      checkTrigger(id, `${nodePath}/trigger`, node.trigger);
      if (node.kind === "graph" && node.graph.sink?.stream === true)
        for (const [index, edge] of edges.entries())
          if ((edge.to === id || edge.from === id) && edge.kind !== "message")
            fail(
              edge.kind === undefined
                ? `${path}/edges/${index}`
                : `${path}/edges/${index}/kind`,
              "Streaming graph nodes require message edges",
              `set kind: message on edges into and out of "${id}"; a streaming graph never returns`,
              "port",
            );
      if (node.kind === "emit") {
        const values = outbound.filter((e) => e.kind !== "message");
        if (inbound.length || !outbound.length || values.length)
          fail(
            nodePath,
            `Node "${id}" (emit) must have no inbound edges and only message outbound edges (at least one)`,
            inbound.length
              ? `remove the edges into "${id}" (${list(inbound.map(edgeId))}); emit nodes start work`
              : outbound.length
                ? `set kind: message on ${list(values.map(edgeId))}`
                : `add a message edge from "${id}" to the node it seeds`,
            "node",
          );
      } else if (node.kind !== "code" && node.kind !== "graph") {
        const inboundIds = inbound.map(edgeId);
        const known = inboundIds.length
          ? `reference one of its inbound edges: ${list(inboundIds)}`
          : `add an edge into "${id}" first`;
        for (const [, e] of node.prompt?.matchAll(PLACEHOLDER) ?? [])
          if (!inboundIds.includes(e ?? ""))
            fail(
              `${nodePath}/prompt`,
              `Node "${id}" prompt references edge "${e}" which is not one of its inbound edges`,
              known,
              "reference",
            );
        unique(node.skills ?? [], `${nodePath}/skills`, `Node "${id}" skills`);
        for (const [index, name] of (node.skills ?? []).entries())
          if (!Object.hasOwn(doc.skills ?? {}, name))
            fail(
              `${nodePath}/skills/${index}`,
              `Node "${id}" references unknown skill "${name}"`,
              `declare "${name}" in the top-level skills registry, or use one of: ${list(Object.keys(doc.skills ?? {}))}`,
              "reference",
            );
        unique(node.tool_block ?? [], `${nodePath}/tool_block`, `Node "${id}" tool_block`);
      }
    }
    const sourceEdges = (outgoing.get("$source") ?? []).map(edgeId);
    const routes = spec.source?.routes ?? {};
    for (const [key, targets] of Object.entries(routes)) {
      const at = `${path}/source/routes/${pointer(key)}`;
      identifier(key, at, "key");
      if (parentInbound && !parentInbound.some((e) => edgeId(e) === key))
        fail(
          at,
          `Graph "${label}" routes unknown parent edge "${key}"`,
          parentInbound.length
            ? `route one of the wrapper's inbound edges: ${list(parentInbound.map(edgeId))}`
            : `add an edge with id "${key}" into the wrapper node`,
          "reference",
          { target: "key" },
        );
      unique(targets, at, `Graph "${label}" route "${key}"`);
      for (const [index, target] of targets.entries())
        if (!sourceEdges.includes(target))
          fail(
            `${at}/${index}`,
            `Graph "${label}" route target "${target}" is not an edge from $source`,
            sourceEdges.length
              ? `route to one of: ${list(sourceEdges)}`
              : `add a message edge from $source with id "${target}"`,
            "reference",
          );
    }
    const routed = new Set(Object.values(routes).flat());
    for (const [index, edge] of edges.entries())
      if (edge.from === "$source" && !routed.has(edgeId(edge)))
        fail(
          `${path}/edges/${index}`,
          `$source edge "${edgeId(edge)}" is not a target of any source route`,
          `add "${edgeId(edge)}" to a source.routes list, or remove the edge`,
          "source-route",
        );
    for (const edge of parentInbound ?? [])
      if (!Object.hasOwn(routes, edgeId(edge)))
        fail(
          `${path}/source/routes`,
          `Graph "${label}" has no source route for parent edge "${edgeId(edge)}"`,
          `add source.routes."${edgeId(edge)}" listing the $source edges it feeds, or [] to discard it`,
          "source-route",
        );
    // Topology: one active entry, one exit ($sink), every node on an entry-to-sink walk.
    const entries = ids.filter((id) => incoming.get(id)?.length === 0);
    const [entry] = entries;
    if (entry === undefined || entries.length > 1)
      fail(
        `${path}/nodes`,
        `Graph must have exactly one entry node; found ${entries.length}: ${list(entries)}`,
        entry === undefined
          ? "connect an entry node to the cycle, e.g. a code node with trigger: always and an edge into it"
          : `add one shared entry node that fans out to ${list(entries)}, or connect all but one of them from the rest of the graph`,
        "entry-count",
      );
    // Locate a node set (which may include a virtual port) at its first declared node.
    const nodeAt = (set: readonly string[]) => {
      const id = set.find((id) => Object.hasOwn(spec.nodes, id));
      return id === undefined
        ? `${path}/nodes`
        : `${path}/nodes/${pointer(id)}`;
    };
    const leaves = ids.filter(
      (id) => id !== "$sink" && outgoing.get(id)?.length === 0,
    );
    if (leaves.length)
      fail(
        nodeAt(leaves),
        `Graph must have exactly one exit node, $sink; ${list(leaves)} also ${leaves.length === 1 ? "has" : "have"} no outbound edges`,
        `wire each terminal branch (${list(leaves)}) to $sink, and set sink.returns when several nodes reach $sink`,
        "exit-count",
        { target: "key" },
      );
    // Set iteration visits members added during the loop: an O(V+E) traversal.
    const reach = (start: string, forward: boolean) => {
      const seen = new Set([start]);
      for (const id of seen)
        for (const e of (forward ? outgoing : incoming).get(id) ?? [])
          seen.add(forward ? e.to : e.from);
      return seen;
    };
    const forward = reach(entry, true);
    const unreachable = ids.filter((id) => !forward.has(id));
    if (unreachable.length)
      fail(
        nodeAt(unreachable),
        `${list(unreachable)} ${unreachable.length === 1 ? "is" : "are"} unreachable from entry "${entry}"`,
        `connect ${list(unreachable)} from "${entry}" or a node it reaches, or remove ${unreachable.length === 1 ? "it" : "them"}`,
        "unreachable",
        { target: "key" },
      );
    const backward = reach("$sink", false);
    const trapped = ids.filter((id) => !backward.has(id));
    if (trapped.length)
      fail(
        nodeAt(trapped),
        `${list(trapped)} ${trapped.length === 1 ? "has" : "have"} no path to $sink`,
        `add an edge from ${list(trapped)} toward $sink, or remove ${trapped.length === 1 ? "it" : "them"}`,
        "no-sink-path",
        { target: "key" },
      );
    // Set iteration is the worklist: each possible producer releases its watched edges once.
    for (const producer of canStart) {
      for (const e of outgoing.get(producer) ?? []) {
        const needed = pendingInputs.get(e.to);
        if (needed === undefined || !watched.has(edgeId(e))) continue;
        if (needed === 1) {
          pendingInputs.delete(e.to);
          canStart.add(e.to);
        } else pendingInputs.set(e.to, needed - 1);
      }
    }
    const blocked = ids.filter((id) => pendingInputs.has(id));
    const [first] = blocked;
    if (first !== undefined) {
      const sink = first === "$sink";
      const at = first === "$source" ? `${path}/source`
        : sink ? (spec.sink ? `${path}/sink` : path) : nodeAt(blocked);
      const trigger = first === "$source" ? spec.source?.trigger
        : sink ? spec.sink?.trigger : spec.nodes[first]?.trigger;
      fail(
        trigger === undefined ? at : `${at}/trigger`,
        `Cannot start under the declared triggers: ${list(blocked)}`,
        "give a blocked node a trigger that can fire without feedback, e.g. { any: [seed, feedback] } with a reachable seed edge",
        "unstartable-trigger",
        { target: !sink && trigger === undefined ? "key" : "value" },
      );
    }
    for (const [id, node] of Object.entries(spec.nodes))
      if (node.kind === "graph")
        checkGraph(
          node.graph,
          `${path}/nodes/${pointer(id)}/graph`,
          node.graph.name ?? id,
          incoming.get(id),
        );
  }
  checkGraph(doc.graph, "/graph", doc.graph.name ?? "graph");
  return doc;
}

type NodeMaps = Readonly<Record<string, { readonly map: ReadonlyMap<NodeIdType, unknown>; readonly complete?: boolean }>>;

/** Validate config keys against runtime nodes, including both ports at every level. */
function validateNodeMaps(document: JuncoDocument, maps: NodeMaps): void {
  const ids = new Set([nodeKey("", "$source"), nodeKey("", "$sink")]);
  for (const { key, node } of walk(document.graph)) {
    ids.add(key);
    if (node.kind === "graph") {
      ids.add(nodeKey(key, "$source"));
      ids.add(nodeKey(key, "$sink"));
    }
  }
  for (const [name, { map, complete }] of Object.entries(maps)) {
    const path = `/options/${pointer(name)}`;
    if (typeof map?.keys !== "function" || typeof map.has !== "function" || typeof map.get !== "function")
      reject(path, "Expected a node-indexed map", "pass a Map keyed by qualified node ID", "node-map");
    const unknown = [...map.keys()].filter((id) => !ids.has(id));
    const missing = complete === true ? [...ids].filter((id) => !map.has(id)) : [];
    if (unknown.length || missing.length)
      reject(path, [unknown.length && `unknown IDs: ${list(unknown)}`, missing.length && `missing IDs: ${list(missing)}`].filter(Boolean).join("; "),
        "use qualified node IDs relative to the root graph", "node-map");
  }
}

/** Validates a decoded Junco document, including nested graphs, before construction. */
export const JuncoGraphValidator = { validate, validateNodeMaps };
