/**
 * Junco YAML parsing and definition validation.
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
 *
 * YAML text is parsed as one strict YAML 1.2 document: every YAML error or warning, duplicate
 * key and non-string key is fatal; `<<` merges are supported. Failures throw `ValidationError`
 * with the JSON Pointer of the offending value and, for text, its source location.
 */
import * as graph from "dataflow-engine";
import { UNITS, unitOf } from "dataflow-profile";
import type { TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Format } from "typebox/format";
import Schema from "typebox/schema";
import { Value } from "typebox/value";
import {
  type Alias,
  type Document,
  type ErrorCode,
  isAlias,
  isCollection,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  Scalar,
  visit,
  type YAMLMap,
} from "yaml";
import { ValidationError, type ValidationLocation } from "./errors.js";
import {
  BUILTIN_TOOL_NAMES,
  type EdgeSpec,
  type GraphSpec,
  type JuncoDocument,
  JuncoDocumentSchema,
  type TriggerSpec,
} from "./schema.js";

export const edgeId = (edge: EdgeSpec): string =>
  edge.id ?? `${edge.from}${edge.kind === "message" ? "~>" : "->"}${edge.to}`;
export const inboundEdges = (spec: GraphSpec, id: string): EdgeSpec[] =>
  (spec.edges ?? []).filter((e) => e.to === id);
export const outboundEdges = (spec: GraphSpec, id: string): EdgeSpec[] =>
  (spec.edges ?? []).filter((e) => e.from === id);
export const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

const QUANTITY = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/;
/** Convert a schema-validated quantity, rejecting unknown unit symbols for its resource. */
export function quantityOf<R extends graph.ResourceKind>(
  kind: R,
  text: string,
): graph.ResourceQuantity<R> {
  const match = QUANTITY.exec(text);
  if (match === null)
    throw new graph.DataflowDefinitionError(`invalid quantity "${text}"`);
  const [, amount, symbol] = match;
  return unitOf(kind, symbol)(Number(amount));
}

export function resolveTrigger<N extends TSchema, T>(
  spec: GraphSpec,
  id: string,
  edges: ReadonlyMap<string, graph.Edge<N, T>>,
  trigger?: TriggerSpec,
): graph.TriggerRule<N, T> {
  const { TriggerRule, TriggerEntry } = graph;
  if (trigger === "always") return TriggerRule.always();
  if (trigger === "never") return TriggerRule.never();
  const entries =
    typeof trigger === "string"
      ? [trigger]
      : trigger === undefined
        ? inboundEdges(spec, id).map(edgeId)
        : "all" in trigger
          ? trigger.all
          : trigger.any;
  const on = entries.map((entry) => {
    const edge = edges.get(entry);
    if (edge === undefined)
      throw new graph.DataflowDefinitionError(
        `Node "${id}" trigger references edge "${entry}" which is not one of its inbound edges`,
      );
    return TriggerEntry.on(edge);
  });
  return typeof trigger === "object" && "any" in trigger
    ? TriggerRule.anyOf(...on)
    : TriggerRule.allOf(...on);
}
const pointer = (key: string) =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");
const list = (items: readonly string[]) =>
  items.length ? items.map((item) => `"${item}"`).join(", ") : "(none)";

/** Throw a `ValidationError` at JSON Pointer `path`; `help` says how to repair it. */
type Fail = (
  path: string,
  message: string,
  help: string,
  code: string,
  options?: { readonly cause?: unknown; readonly target?: "key" | "value" },
) => never;

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

/** `/graph`, nested `/nodes/<id>/graph` levels, then `/edges/<index>`. */
const EDGE =
  /^\/graph((?:\/nodes\/(?:[^/~]|~[01])*\/graph)*)\/edges\/(?:0|[1-9]\d*)$/;
/** Whether `at` points at an edge of a graph `value` declares, not of an unused node-union branch. */
function declaredEdge(value: unknown, at: string): boolean {
  const levels = EDGE.exec(at)?.[1];
  if (levels === undefined) return false;
  let wrapper = "/graph";
  for (const [, id] of levels.matchAll(/\/nodes\/([^/]*)\/graph/g)) {
    wrapper += `/nodes/${id}`;
    const node = Schema.Pointer.Get(value, wrapper);
    if (
      typeof node !== "object" ||
      node === null ||
      Array.isArray(node) ||
      (node as { kind?: unknown }).kind !== "graph"
    )
      return false;
    wrapper += "/graph";
  }
  return true;
}

export type ParseOptions = {
  /** Values spliced verbatim into `{{ params.<name> }}` placeholders before YAML parsing. */
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  /** The file name diagnostics show for YAML text (default `<yaml>`). */
  readonly sourceName?: string;
};
export const PARAM = /\{\{\s*params\.([A-Za-z_]\w*)\s*\}\}/g;

/** A plain `<<` key: a merge, never a duplicate of another merge or a document field. */
const mergeKey = (node: unknown) =>
  isScalar(node) &&
  node.value === "<<" &&
  (!node.type || node.type === Scalar.PLAIN);
const YAML_OPTIONS = {
  version: "1.2",
  prettyErrors: false,
  strict: true,
  stringKeys: true,
  // `true` would also reject repeated `<<` merge keys, which `stringKeys` makes plain strings.
  uniqueKeys: (a: unknown, b: unknown) =>
    a === b ||
    (isScalar(a) &&
      isScalar(b) &&
      a.value === b.value &&
      !mergeKey(a) &&
      !mergeKey(b)),
  merge: true,
} as const;
const YAML_HELP: Partial<Record<ErrorCode, string>> = {
  DUPLICATE_KEY:
    "remove or rename the repeated key; a mapping cannot repeat a key",
  NON_STRING_KEY:
    "use a plain string key; complex, alias and non-string-tagged keys are not supported",
  BAD_DIRECTIVE: "declare %YAML 1.2 or remove the directive",
  TAG_RESOLVE_FAILED: "remove the tag; junco YAML uses only core schema tags",
  BAD_ALIAS: "rename the anchor and alias so they do not end in ':'",
};

type Range = readonly [start: number, end: number];
/** Half-open UTF-16 offsets as 1-based lines and 0-based columns. */
function located(
  lines: LineCounter,
  text: string,
  [start, end]: Range,
): ValidationLocation {
  const at = (offset: number) => {
    const { line, col } = lines.linePos(
      Math.min(Math.max(offset, 0), text.length),
    );
    return { line, column: col - 1 };
  };
  return { start: at(start), end: at(Math.max(start, end)) };
}
type SourceSpan = { readonly range: Range; readonly frameRange?: Range };
/** A node's full source range; collections display only their first line. */
function span(node: unknown, text: string): SourceSpan | undefined {
  if (!isNode(node) || !node.range) return undefined;
  const range: Range = [node.range[0], node.range[1]];
  if (!isCollection(node)) return { range };
  const [start, end] = range;
  const newline = text.indexOf("\n", start);
  const eol =
    newline === -1
      ? text.length
      : text[newline - 1] === "\r"
        ? newline - 1
        : newline;
  return { range, frameRange: [start, Math.min(end, Math.max(start, eol))] };
}
const hasKey = (map: YAMLMap, key: string) =>
  map.items.some(
    (p) => isScalar(p.key) && !mergeKey(p.key) && p.key.value === key,
  );
/** The `<<` value or alias whose merged mapping supplies `key`, if resolvable. */
function mergedFrom(
  document: Document.Parsed,
  map: YAMLMap,
  key: string,
  seen = new Set<unknown>(),
): unknown {
  seen.add(map);
  for (const pair of map.items) {
    if (!mergeKey(pair.key)) continue;
    for (const item of isSeq(pair.value) ? pair.value.items : [pair.value]) {
      const source = isAlias(item) ? item.resolve(document) : item;
      if (
        isMap(source) &&
        !seen.has(source) &&
        (hasKey(source, key) ||
          mergedFrom(document, source, key, seen) !== undefined)
      )
        return item;
    }
  }
  return undefined;
}
/** The source span of the YAML node at JSON Pointer `path` of converted `value`, resolved only on failure. */
function locate(
  document: Document.Parsed,
  text: string,
  value: unknown,
  path: string,
  target: "key" | "value",
): SourceSpan | undefined {
  let node: unknown = document.contents;
  let key: unknown;
  let consumed = "";
  const segments =
    path === "/"
      ? []
      : path
          .split("/")
          .slice(1)
          .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
  for (const segment of segments) {
    // A path through an alias highlights the concrete `*anchor` use.
    if (isAlias(node)) return span(node, text);
    if (isMap(node)) {
      const pair = node.items.find(
        (p) => isScalar(p.key) && !mergeKey(p.key) && p.key.value === segment,
      );
      if (pair === undefined) {
        if (node.items.some((p) => mergeKey(p.key))) {
          const origin = mergedFrom(document, node, segment);
          if (origin !== undefined) return span(origin, text);
          // Merged in without traceable provenance: no trustworthy caret.
          if (Schema.Pointer.Has(value, `${consumed}/${pointer(segment)}`))
            return undefined;
        }
        return span(node, text); // a genuinely missing field: its container
      }
      key = pair.key;
      node = pair.value;
    } else if (isSeq(node)) {
      const item = /^(0|[1-9]\d*)$/.test(segment)
        ? node.items[Number(segment)]
        : undefined;
      if (item === undefined) return span(node, text);
      key = undefined;
      node = item;
    } else break;
    consumed += `/${pointer(segment)}`;
  }
  if (target === "key" && key !== undefined) return span(key, text);
  return span(node, text) ?? span(key, text);
}

export function parse(
  source: string | unknown,
  options: ParseOptions = {},
): JuncoDocument {
  const params = options.params ?? {};
  const name = options.sourceName ?? "<yaml>";
  let value: unknown = source;
  let yaml:
    | {
        readonly text: string;
        readonly sourceName: string;
        readonly lines: LineCounter;
        readonly document: Document.Parsed;
      }
    | undefined;
  const raise = (
    path: string,
    message: string,
    help: string,
    code: string,
    cause: unknown,
    range: Range | undefined,
    frameRange?: Range,
  ): never => {
    throw new ValidationError(
      {
        code,
        path,
        message,
        help,
        ...(cause !== undefined && { cause }),
        ...(yaml && { source: yaml.text, sourceName: yaml.sourceName }),
        ...(yaml &&
          range && { location: located(yaml.lines, yaml.text, range) }),
      },
      yaml && frameRange && located(yaml.lines, yaml.text, frameRange),
    );
  };
  const fail: Fail = (path, message, help, code, { cause, target } = {}) => {
    const at =
      yaml && locate(yaml.document, yaml.text, value, path, target ?? "value");
    return raise(path, message, help, code, cause, at?.range, at?.frameRange);
  };
  if (typeof source === "string") {
    let expanded = false;
    const text = source.replace(
      PARAM,
      (placeholder: string, key: string, offset: number) => {
        if (!Object.hasOwn(params, key)) {
          const lines = new LineCounter();
          lines.addNewLine(0);
          for (
            let i = source.indexOf("\n");
            i !== -1;
            i = source.indexOf("\n", i + 1)
          )
            lines.addNewLine(i + 1);
          throw new ValidationError({
            code: "param",
            path: "/",
            message: `missing param "${key}"`,
            help: `supply params.${key} when parsing this YAML`,
            source,
            sourceName: name,
            location: located(lines, source, [
              offset,
              offset + placeholder.length,
            ]),
          });
        }
        expanded = true;
        return String(params[key]);
      },
    );
    const lines = new LineCounter();
    const document = parseDocument(text, {
      ...YAML_OPTIONS,
      lineCounter: lines,
    });
    yaml = {
      text,
      lines,
      document,
      sourceName: expanded ? `${name} (expanded)` : name,
    };
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem)
      raise(
        "/",
        problem.message,
        YAML_HELP[problem.code] ?? "correct the YAML at the marked location",
        "yaml",
        problem,
        problem.pos,
      );
    try {
      value = document.toJS({ maxAliasCount: 100 });
    } catch (cause) {
      let unresolved = undefined as Alias | undefined;
      visit(document, {
        Alias(_, alias) {
          if (alias.resolve(document) !== undefined) return;
          unresolved = alias;
          return visit.BREAK;
        },
      });
      raise(
        "/",
        `YAML conversion failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        unresolved
          ? `define the anchor &${unresolved.source} before this alias`
          : "reduce alias expansion: aliases of aliases may expand at most 100 times",
        "yaml",
        cause,
        unresolved && span(unresolved, text)?.range,
      );
    }
  } else if (options.params !== undefined) {
    fail(
      "/",
      "params apply to YAML text, not to parsed objects",
      "substitute the values into the object yourself, or pass YAML text",
      "param",
    );
  }
  acyclic(value, "", new Set(), fail);
  if (!Value.Check(JuncoDocumentSchema, value)) {
    const errors = Value.Errors(JuncoDocumentSchema, value);
    for (const error of errors) {
      const at = error.instancePath;
      if (
        error.keyword === "required" &&
        error.params.requiredProperties.includes("schema") &&
        declaredEdge(value, at)
      )
        fail(
          `${at}/schema`,
          "edge requires a schema mapping",
          "add schema: {} for an unconstrained payload, or a JSON Schema Draft 2020-12 mapping",
          "edge-schema",
        );
      if (
        error.keyword === "type" &&
        [error.params.type].flat().includes("object") &&
        at.endsWith("/schema") &&
        declaredEdge(value, at.slice(0, -"/schema".length))
      )
        fail(
          at,
          "edge schema must be a mapping",
          "replace this value with schema: {} or a JSON Schema Draft 2020-12 mapping",
          "edge-schema",
        );
    }
    failTypeBox(errors, "", "document", fail);
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
  for (const field of ["mcp", "skills"] as const)
    for (const name of Object.keys(doc[field] ?? {}))
      identifier(name, `/${field}/${pointer(name)}`, "key");
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
      if (edge.to === "$source")
        fail(
          `${at}/to`,
          "Graph source cannot have inbound edges",
          "send the edge to a declared node or $sink",
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
        if (node !== port && !Object.hasOwn(spec.nodes, node))
          fail(
            `${at}/${end}`,
            `edge "${id}" references unknown node "${node}"`,
            `declare "${node}" under ${path}/nodes, or use ${port} or one of: ${list(Object.keys(spec.nodes))}`,
            "reference",
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
    const wired = edges.some((e) => e.from === "$source");
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
    function checkTrigger(id: string, at: string, trigger?: TriggerSpec): void {
      const inbound = (incoming.get(id) ?? []).map(edgeId);
      const [entries, base]: [readonly string[], string] =
        typeof trigger === "object"
          ? "all" in trigger
            ? [trigger.all, `${at}/all`]
            : [trigger.any, `${at}/any`]
          : trigger === undefined || trigger === "always" || trigger === "never"
            ? [[], at]
            : [[trigger], at];
      if (typeof trigger === "object")
        unique(entries, base, `Node "${id}" trigger`);
      else if (entries[0] !== undefined) identifier(entries[0], base);
      for (const [index, e] of entries.entries())
        if (!inbound.includes(e))
          fail(
            typeof trigger === "object" ? `${base}/${index}` : base,
            `Node "${id}" trigger references edge "${e}" which is not one of its inbound edges`,
            inbound.length
              ? `use one of its inbound edges: ${list(inbound)}`
              : `add an edge with id "${e}" into "${id}", or remove the trigger`,
            "trigger",
          );
    }
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
    // $source and emit nodes never complete, so they can never supply the graph's result.
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
    checkTrigger("$sink", `${path}/sink/trigger`, spec.sink?.trigger);
    for (const [id, node] of Object.entries(spec.nodes)) {
      const nodePath = `${path}/nodes/${pointer(id)}`;
      for (const [kind, text] of Object.entries(node.profiles ?? {})) {
        try {
          quantityOf(kind as graph.ResourceKind, text);
        } catch (cause) {
          fail(
            `${nodePath}/profiles/${kind}`,
            (cause as Error).message,
            `write a number and one of the ${kind} units: ${Object.keys(UNITS[kind as graph.ResourceKind]).join(", ")}`,
            "profile",
            { cause },
          );
        }
      }
      const inbound = incoming.get(id) ?? [];
      const outbound = outgoing.get(id) ?? [];
      checkTrigger(id, `${nodePath}/trigger`, node.trigger);
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
        for (const [, e] of (node.prompt ?? "").matchAll(PLACEHOLDER))
          if (!inboundIds.includes(e ?? ""))
            fail(
              `${nodePath}/prompt`,
              `Node "${id}" prompt references edge "${e}" which is not one of its inbound edges`,
              known,
              "reference",
            );
        for (const [field, registry, noun] of [
          ["mcp", doc.mcp, "mcp"],
          ["skills", doc.skills, "skill"],
        ] as const) {
          unique(
            node[field] ?? [],
            `${nodePath}/${field}`,
            `Node "${id}" ${field}`,
          );
          for (const [index, name] of (node[field] ?? []).entries())
            if (!Object.hasOwn(registry ?? {}, name))
              fail(
                `${nodePath}/${field}/${index}`,
                `Node "${id}" references unknown ${noun} "${name}"`,
                `declare "${name}" in the top-level ${field} registry, or use one of: ${list(Object.keys(registry ?? {}))}`,
                "reference",
              );
        }
        const additions = node.tools ?? [];
        const block = node.tool_block ?? [];
        unique(additions, `${nodePath}/tools`, `Node "${id}" tools`);
        unique(block, `${nodePath}/tool_block`, `Node "${id}" tool_block`);
        const added = new Set(additions);
        for (const [index, name] of block.entries())
          if (added.has(name))
            fail(
              `${nodePath}/tool_block/${index}`,
              `Node "${id}": tools and tool_block both list "${name}"`,
              `remove "${name}" from either tools or tool_block; a tool cannot be both added and blocked`,
              "node",
            );
        for (const [index, name] of additions.entries())
          if ((BUILTIN_TOOL_NAMES as readonly string[]).includes(name))
            fail(
              `${nodePath}/tools/${index}`,
              `Node "${id}": tool "${name}" is builtin and enabled by default`,
              `remove "${name}" from tools; use tool_block to disable it`,
              "node",
            );
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
