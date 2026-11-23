/**
 * YAML text is parsed as one strict YAML 1.2 document: every YAML error or warning, duplicate
 * key and non-string key is fatal; `<<` merges are supported. Failures throw `ValidationError`
 * with the JSON Pointer of the offending value and, for text, its source location.
 */
import Schema from "typebox/schema";
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
import {
  type Fail,
  pointer,
  ValidationError,
  type ValidationLocation,
} from "./errors.js";
import type { JuncoDocument } from "./schema.js";
import { JuncoGraphValidator } from "./validator.js";

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
  return JuncoGraphValidator.validate(value, fail);
}
