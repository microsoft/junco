import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import type { NativeMux } from "../native/index.js";
import type { ToolCollection } from "./collection.js";

/** Exact, 1-based baseline lines, without line terminators; an empty beforeLines inserts. */
export type SourceEdit = {
  readonly path: string;
  readonly startLine: number;
  readonly beforeLines: readonly string[];
  readonly afterLines: readonly string[];
} & ({ readonly kind: "replace" } | { readonly kind: "create" });

/** A POSIX path inside the repository: relative, no empty, `.`, or `..` segments. */
export function isRepoRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  )
    return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const errorCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

/** Resolve the deepest existing ancestor before any host read; dangling symlinks are not absence. */
async function sourcePath(
  root: string,
  rootReal: string,
  path: string,
): Promise<string> {
  if (!isRepoRelativePath(path))
    throw new Error(`${path} is not a repo-relative path`);
  const absolute = join(root, path);
  for (let probe = absolute; ; probe = dirname(probe)) {
    let real: string;
    try {
      real = await realpath(probe);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || probe === root) throw error;
      try {
        await lstat(probe);
      } catch (missing) {
        if (errorCode(missing) !== "ENOENT") throw missing;
        continue;
      }
      throw new Error(
        `${path}: ${probe === absolute ? "target" : "ancestor"} is a dangling symlink`,
      );
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep))
      throw new Error(`${path} resolves outside the repository`);
    if (probe !== absolute && !(await stat(real)).isDirectory())
      throw new Error(`${path}: ancestor is not a directory`);
    return absolute;
  }
}

/** Capture each path's full-byte SHA-256 (`null` when absent), refusing repository escapes. */
export async function captureBaseline(
  root: string,
  paths: Iterable<string>,
): Promise<ReadonlyMap<string, string | null>> {
  root = resolve(root);
  const rootReal = await realpath(root);
  const files = new Map<string, string | null>();
  for (const path of paths) {
    const absolute = await sourcePath(root, rootReal, path);
    try {
      files.set(path, sha256(await readFile(absolute)));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      files.set(path, null);
    }
  }
  return files;
}

/** UTF-16LE after its BOM, else UTF-8 without a leading BOM; malformed text is refused. */
function decodeSource(bytes: Uint8Array, path: string): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    throw new Error(`${path}: UTF-16BE source is unsupported`);
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${path}: malformed ${encoding} source`, { cause: error });
  }
}

/** Read current source within the repository, refusing escapes and changes to captured baselines. */
export function repositorySourceReader(
  root: string,
  baseline: ReadonlyMap<string, string | null>,
): (path: string) => Promise<string | undefined> {
  root = resolve(root);
  const rootReal = realpathSync(root);
  return async (path: string): Promise<string | undefined> => {
    const absolute = await sourcePath(root, rootReal, path);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    const expected = baseline.get(path);
    if (expected !== undefined && sha256(bytes) !== expected)
      throw new Error(`${path} changed since this batch's baseline`);
    return decodeSource(bytes, path);
  };
}

/** Require a Git working-tree root through the collection's sandboxed native bash tool. */
export async function requireWorkTreeRoot(
  collection: ToolCollection,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const bash = collection.tools.find((tool) => tool.name === "bash");
  if (bash === undefined)
    throw new Error("The native tool collection has no bash tool");
  const result = await bash.execute(
    "git-root-preflight",
    { command: "git rev-parse --is-inside-work-tree --show-prefix" },
    signal,
  );
  signal?.throwIfAborted();
  const output = contentText(result.content);
  // At the root, --show-prefix prints an empty line.
  if (
    ("isError" in result && result.isError === true) ||
    !/^true\r?\n\r?\n$/.test(output)
  ) {
    throw new Error("A Git working-tree root is required", {
      cause: new Error(`git rev-parse: ${output}`),
    });
  }
}

const DIAGNOSTIC_LIMIT = 64 * 1024;
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;
const appendDiagnostic = (kept: string, text: string): string =>
  kept.length >= DIAGNOSTIC_LIMIT
    ? kept
    : (kept + text).slice(0, DIAGNOSTIC_LIMIT);

type ApplyPayload = {
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string | null;
  }[];
  readonly edits: readonly SourceEdit[];
};

/**
 * Serialized into the current JS runtime's --eval: every dependency must remain local. Preflights
 * and computes every output in the managed view before writing; errors are JSON-escaped stderr.
 */
function applyWorker(): void {
  const fs = process.getBuiltinModule("node:fs");
  const pathApi = process.getBuiltinModule("node:path");
  const { createHash } = process.getBuiltinModule("node:crypto");
  type Payload = {
    files: { path: string; sha256: string | null }[];
    edits: {
      kind: "replace" | "create";
      path: string;
      startLine: number;
      beforeLines: string[];
      afterLines: string[];
    }[];
  };
  type Line = { content: Uint8Array; term: Uint8Array; text: string };
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const code = (error: unknown): unknown =>
    error instanceof Error && "code" in error ? error.code : undefined;
  try {
    const payload: Payload = JSON.parse(
      Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8"),
    );
    const cwd = process.cwd();
    const root = fs.realpathSync(cwd);
    const inside = (real: string): boolean =>
      real === root || real.startsWith(root + pathApi.sep);
    const checkAncestors = (path: string, absolute: string): void => {
      for (
        let probe = pathApi.dirname(absolute);
        ;
        probe = pathApi.dirname(probe)
      ) {
        let real: string;
        try {
          real = fs.realpathSync(probe);
        } catch (error) {
          if (code(error) !== "ENOENT" || probe === cwd) throw error;
          let dangling = false;
          try {
            fs.lstatSync(probe);
            dangling = true;
          } catch (missing) {
            if (code(missing) !== "ENOENT") throw missing;
          }
          if (dangling)
            fail(
              `${path}: ancestor ${pathApi.relative(cwd, probe)} is a dangling symlink`,
            );
          continue;
        }
        if (!inside(real)) fail(`${path} resolves outside the repository`);
        if (!fs.statSync(real).isDirectory())
          fail(
            `${path}: ancestor ${pathApi.relative(cwd, probe)} is not a directory`,
          );
        return;
      }
    };
    const files = new Map<string, string | null>();
    for (const file of payload.files) {
      if (
        file.path.length === 0 ||
        file.path.startsWith("/") ||
        file.path.includes("\\") ||
        file.path.includes("\0") ||
        !file.path
          .split("/")
          .every(
            (segment) => segment !== "" && segment !== "." && segment !== "..",
          )
      ) {
        fail(`${file.path} is not a repo-relative path`);
      }
      if (files.has(file.path)) fail(`${file.path} is listed twice`);
      files.set(file.path, file.sha256);
    }
    const edited = new Set(payload.edits.map((edit) => edit.path));
    if (
      edited.size !== files.size ||
      [...edited].some((path) => !files.has(path))
    )
      fail("the payload's files do not match its edits");
    const ranges = payload.edits.map((edit) => ({
      path: edit.path,
      kind: edit.kind,
      start: edit.startLine,
      end: edit.startLine + edit.beforeLines.length,
    }));
    for (let a = 0; a < ranges.length; a++) {
      for (let b = a + 1; b < ranges.length; b++) {
        const x = ranges[a]!;
        const y = ranges[b]!;
        if (x.path !== y.path) continue;
        const xInsert = x.start === x.end;
        const yInsert = y.start === y.end;
        const overlap =
          x.kind === "create" || y.kind === "create"
            ? true
            : xInsert && yInsert
              ? x.start === y.start
              : xInsert
                ? y.start <= x.start && x.start < y.end
                : yInsert
                  ? x.start <= y.start && y.start < x.end
                  : x.start < y.end && y.start < x.end;
        if (overlap) fail(`edits[${a}] and edits[${b}] overlap`);
      }
    }
    payload.edits.forEach((edit, index) => {
      if (edit.kind !== "replace" && edit.kind !== "create")
        fail(`edits[${index}].kind is invalid`);
      if (
        ![...edit.beforeLines, ...edit.afterLines].every(
          (line) => typeof line === "string" && !/[\r\n]/.test(line),
        )
      ) {
        fail(`edits[${index}] has a line containing a line terminator`);
      }
      if (!Number.isInteger(edit.startLine) || edit.startLine < 1)
        fail(`edits[${index}].startLine is invalid`);
    });
    const outputs: { absolute: string; bytes: Uint8Array; create: boolean }[] =
      [];
    for (const [path, expected] of files) {
      const absolute = pathApi.resolve(cwd, path);
      checkAncestors(path, absolute);
      const edits = payload.edits.filter((edit) => edit.path === path);
      if (expected === null) {
        const [edit] = edits;
        if (edits.length !== 1 || edit!.kind !== "create")
          fail(`${path}: a new file takes exactly one create edit`);
        if (
          edit!.startLine !== 1 ||
          edit!.beforeLines.length > 0 ||
          edit!.afterLines.length === 0
        ) {
          fail(
            `${path}: create needs startLine 1, empty beforeLines, and nonempty afterLines`,
          );
        }
        let exists = true;
        try {
          fs.lstatSync(absolute);
        } catch (error) {
          if (code(error) !== "ENOENT") throw error;
          exists = false;
        }
        if (exists) fail(`${path} already exists`);
        outputs.push({
          absolute,
          bytes: Buffer.from(`${edit!.afterLines.join("\n")}\n`, "utf8"),
          create: true,
        });
        continue;
      }
      if (edits.some((edit) => edit.kind !== "replace"))
        fail(`${path} exists, so only replace edits apply`);
      let info: import("node:fs").Stats;
      try {
        info = fs.lstatSync(absolute);
      } catch (error) {
        if (code(error) === "ENOENT") fail(`${path} is missing`);
        throw error;
      }
      if (!info.isFile()) fail(`${path} is not a regular file`);
      if (info.nlink !== 1) fail(`${path} has multiple hard links`);
      const bytes = fs.readFileSync(absolute);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected) fail(`${path} changed since its batch baseline`);
      if (bytes[0] === 0xfe && bytes[1] === 0xff)
        fail(`${path}: UTF-16BE source is unsupported`);
      const wide = bytes[0] === 0xff && bytes[1] === 0xfe;
      const bomLength = wide
        ? 2
        : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          ? 3
          : 0;
      const unit = wide ? 2 : 1;
      if ((bytes.length - bomLength) % unit !== 0)
        fail(`${path}: malformed UTF-16LE source`);
      const decoder = new TextDecoder(wide ? "utf-16le" : "utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      const decode = (part: Uint8Array): string => {
        try {
          return decoder.decode(part);
        } catch {
          return fail(
            `${path}: malformed ${wide ? "UTF-16LE" : "UTF-8"} source`,
          );
        }
      };
      const encode = (text: string): Uint8Array =>
        Buffer.from(text, wide ? "utf16le" : "utf8");
      decode(bytes.subarray(bomLength));
      // LF ends a line; its preceding CR belongs to the terminator.
      const lines: Line[] = [];
      let start = bomLength;
      for (let at = bomLength; at < bytes.length; at += unit) {
        if (bytes[at] !== 0x0a || (wide && bytes[at + 1] !== 0)) continue;
        const crlf =
          at - unit >= start &&
          bytes[at - unit] === 0x0d &&
          (!wide || bytes[at - 1] === 0);
        const end = crlf ? at - unit : at;
        const content = bytes.subarray(start, end);
        lines.push({
          content,
          term: bytes.subarray(end, at + unit),
          text: decode(content),
        });
        start = at + unit;
      }
      if (start < bytes.length) {
        const content = bytes.subarray(start);
        lines.push({ content, term: new Uint8Array(0), text: decode(content) });
      }
      const terminated = lines.length === 0 || lines.at(-1)!.term.length > 0;
      const separator =
        lines.find((line) => line.term.length > 0)?.term ?? encode("\n");
      for (const edit of edits) {
        const at = `${path}:L${edit.startLine}`;
        if (edit.beforeLines.length === 0 && edit.afterLines.length === 0)
          fail(`${at}: the edit changes nothing`);
        if (
          edit.startLine > lines.length + 1 ||
          edit.startLine + edit.beforeLines.length - 1 > lines.length
        ) {
          fail(`${at} is outside ${path} (${lines.length} lines)`);
        }
        edit.beforeLines.forEach((line, offset) => {
          if (lines[edit.startLine - 1 + offset]!.text !== line)
            fail(
              `${path}:L${edit.startLine + offset} does not match beforeLines[${offset}]`,
            );
        });
      }
      const result: { content: Uint8Array; term: Uint8Array }[] = lines.map(
        ({ content, term }) => ({ content, term }),
      );
      for (const edit of [...edits].sort((a, b) => b.startLine - a.startLine)) {
        result.splice(
          edit.startLine - 1,
          edit.beforeLines.length,
          ...edit.afterLines.map((line) => ({
            content: encode(line),
            term: separator,
          })),
        );
      }
      const parts: Uint8Array[] = [bytes.subarray(0, bomLength)];
      result.forEach((line, index) => {
        parts.push(line.content);
        if (index < result.length - 1 || terminated)
          parts.push(line.term.length > 0 ? line.term : separator);
      });
      outputs.push({ absolute, bytes: Buffer.concat(parts), create: false });
    }
    for (const output of outputs) {
      if (output.create) {
        fs.mkdirSync(pathApi.dirname(output.absolute), { recursive: true });
        fs.writeFileSync(output.absolute, output.bytes, { flag: "wx" });
      } else {
        // Truncation preserves the existing mode.
        fs.writeFileSync(output.absolute, output.bytes);
      }
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exit(1);
  }
}

type ApplyFrame =
  | {
      readonly kind: "worker_failed" | "release_failed";
      readonly exitCode: number;
    }
  | { readonly kind: "edits_ready" };
function applyFrame(line: string): ApplyFrame | undefined {
  if (!line.startsWith('{"kind":')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("kind" in value))
    return undefined;
  if (value.kind === "edits_ready") return { kind: "edits_ready" };
  if (
    (value.kind === "worker_failed" || value.kind === "release_failed") &&
    "exitCode" in value &&
    typeof value.exitCode === "number"
  ) {
    return { kind: value.kind, exitCode: value.exitCode };
  }
  return undefined;
}

/**
 * Apply exact baseline edits and release exactly their sorted unique paths in one managed command.
 * The borrowed mux must use sandbox "always": handled failures abort and discard its private view.
 * An unexpected shell crash may already have published effects, which the error explicitly reports.
 * `baseline` contains full-byte SHA-256 hashes, or null for absent files. The operation's `label` is
 * diagnostic text; `principal` orders commands and does not change the mux's policy owner.
 */
export async function applySourceEdits(
  root: string,
  mux: NativeMux,
  edits: readonly SourceEdit[],
  baseline: ReadonlyMap<string, string | null>,
  options: {
    readonly label: string;
    readonly principal: string;
    readonly signal?: AbortSignal;
  },
): Promise<readonly string[]> {
  const { label, principal, signal } = options;
  signal?.throwIfAborted();
  if (mux.sandbox !== "always")
    throw new Error(`Applying ${label} requires sandbox "always"`);
  const paths = [...new Set(edits.map((edit) => edit.path))].sort();
  if (paths.length === 0)
    throw new Error(`Operation ${label} has no edits to apply`);
  const files = paths.map((path) => {
    if (!isRepoRelativePath(path))
      throw new Error(
        `Operation ${label}: ${path} is not a repo-relative path`,
      );
    const hash = baseline.get(path);
    if (edits.some((edit) => edit.path === path && edit.kind === "create")) {
      if (hash != null)
        throw new Error(
          `Operation ${label}: ${path} existed at its batch baseline and cannot be created`,
        );
      return { path, sha256: null };
    }
    if (typeof hash !== "string")
      throw new Error(`Operation ${label}: ${path} has no batch baseline hash`);
    return { path, sha256: hash };
  });
  const payload: ApplyPayload = { files, edits };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64",
  );
  const command = [
    `printf '%s' ${shellQuote(encoded)} | ${shellQuote(process.execPath)} --eval ${shellQuote(`(${applyWorker.toString()})()`)}`,
    "worker_status=$?",
    'if [ "$worker_status" -ne 0 ]; then',
    `  printf '{"kind":"worker_failed","exitCode":%s}\\n' "$worker_status"`,
    "  while :; do sleep 3600; done",
    "fi",
    "release_status=0",
    ...paths.map(
      (path) =>
        `[ "$release_status" -ne 0 ] || { release -- ${shellQuote(path)}; release_status=$?; }`,
    ),
    'if [ "$release_status" -ne 0 ]; then',
    `  printf '{"kind":"release_failed","exitCode":%s}\\n' "$release_status"`,
    "  while :; do sleep 3600; done",
    "fi",
    `printf '{"kind":"edits_ready"}\\n'`,
  ].join("\n");
  // Callbacks only buffer and notify: every mux call happens on this function's own turn.
  const decoder = new TextDecoder();
  let pending = "";
  let diagnostics = "";
  let ready = false;
  let failure: ApplyFrame | undefined;
  let streamError: unknown;
  let notify!: () => void;
  const failed = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const take = (line: string) => {
    const frame = applyFrame(line);
    if (frame === undefined)
      diagnostics = appendDiagnostic(diagnostics, `${line}\n`);
    else if (frame.kind === "edits_ready") ready = true;
    else {
      failure ??= frame;
      notify();
    }
  };
  const onData = (error: Error | null, data: Buffer) => {
    if (error !== null) {
      streamError ??= error;
      notify();
      return;
    }
    pending += decoder.decode(data, { stream: true });
    for (
      let newline = pending.indexOf("\n");
      newline >= 0;
      newline = pending.indexOf("\n")
    ) {
      take(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (pending.length > DIAGNOSTIC_LIMIT) {
      diagnostics = appendDiagnostic(diagnostics, pending);
      pending = "";
    }
  };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const run = mux.start({ command, cwd: root, principal, env }, onData);
  const outcome = run.wait().then(
    (result) => ({ result }) as const,
    (error: unknown) => ({ error }) as const,
  );
  let joined = false;
  const onAbort = () => run.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) run.abort();
    const first = await Promise.race([outcome, failed.then(() => undefined)]);
    if (first === undefined) {
      run.abort();
      const final = await outcome;
      joined = true;
      const reason =
        failure === undefined
          ? `its output stream failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`
          : `${failure.kind === "worker_failed" ? "the apply worker" : "release"} exited ${failure.kind === "edits_ready" ? 0 : failure.exitCode}`;
      const discarded =
        "error" in final
          ? ""
          : final.result.cancelled
            ? "; its changes were discarded"
            : "";
      const message = `Applying ${label} failed: ${reason}${discarded}${diagnostics === "" ? "" : `\n${diagnostics.trimEnd()}`}`;
      if ("error" in final)
        throw new AggregateError([new Error(message), final.error], message);
      throw new Error(message);
    }
    joined = true;
    if ("error" in first) throw first.error;
    signal?.throwIfAborted();
    const { result } = first;
    if (result.cancelled)
      throw new Error(
        `Applying ${label} was cancelled; its changes were discarded`,
      );
    if (
      streamError !== undefined ||
      failure !== undefined ||
      !ready ||
      result.exitCode !== 0 ||
      result.timedOut
    ) {
      const status = result.timedOut
        ? "timed out"
        : `exited ${result.exitCode ?? "without a status"}`;
      throw new Error(
        `Applying ${label} ended unexpectedly (${status}${ready ? "" : ", no edits_ready frame"}); its effects may already have been published` +
          (diagnostics === "" ? "" : `\n${diagnostics.trimEnd()}`),
      );
    }
    return paths;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!joined) {
      run.abort();
      await outcome;
    }
  }
}
