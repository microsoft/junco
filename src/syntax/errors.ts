import { codeFrameColumns } from "@babel/code-frame";
import { DataflowDefinitionError } from "dataflow-engine";

export const pointer = (key: string) =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

/** Throw a validation error at a JSON Pointer, optionally highlighting the key rather than its value. */
export type Fail = (
  path: string,
  message: string,
  help: string,
  code: string,
  options?: { readonly cause?: unknown; readonly target?: "key" | "value" },
) => never;

/** Lines 1-based, columns 0-based (UTF-16 units), end exclusive. */
export type ValidationLocation = {
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
};

export type ValidationErrorOptions = ErrorOptions & {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly help: string;
  readonly source?: string;
  readonly sourceName?: string;
  readonly location?: ValidationLocation;
};

/** A Junco document rejected before construction, located by JSON Pointer and, for text, by source range. */
export class ValidationError extends DataflowDefinitionError {
  readonly code: string;
  readonly path: string;
  readonly help: string;
  readonly sourceName?: string;
  readonly location?: ValidationLocation;

  /** `frameLocation` narrows only the rendered frame; `.location` keeps the full logical range. */
  constructor(
    options: ValidationErrorOptions,
    frameLocation: ValidationLocation | undefined = options.location,
  ) {
    const path = options.path || "/";
    const { source, location } = options;
    const sourceName =
      source === undefined ? undefined : (options.sourceName ?? "<yaml>");
    let message = `junco-syntax: ${path}: ${options.message} [${options.code}]`;
    if (source !== undefined && location !== undefined)
      message += `\n${sourceName}:${location.start.line}:${location.start.column + 1}\n${frame(source, frameLocation ?? location)}`;
    super(
      `${message}\nhelp: ${options.help}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ValidationError";
    this.code = options.code;
    this.path = path;
    this.help = options.help;
    if (sourceName !== undefined) this.sourceName = sourceName;
    if (location !== undefined) this.location = location;
  }
}

function frame(source: string, location: ValidationLocation): string {
  // Babel also breaks lines at lone CR and U+2028/9, which YAML does not; same-length blanks keep columns.
  const text = source.replace(/\r(?!\n)|[\u2028\u2029]/g, " ");
  let { end } = location;
  // An exclusive end at column 0 of a later line excludes that line; Babel would still mark it.
  if (end.line > location.start.line && end.column === 0) {
    const previous = text.split(/\r?\n/)[end.line - 2] ?? "";
    end = { line: end.line - 1, column: previous.length };
  }
  return codeFrameColumns(
    text,
    { start: location.start, end },
    { highlightCode: false, forceColor: false, linesAbove: 2, linesBelow: 2 },
  );
}
