// Pure helpers for parsing overcast CLI output. NO vscode imports — this
// module is exercised directly by `node --test` (see ../../test).
//
// Contract (verified against src/cli.ts): with --json the CLI prints each
// result record as JSON.stringify(rec, null, 2), one after another — i.e.
// stdout is a stream of concatenated pretty-printed JSON documents, not a
// single array. Exit codes: 0 ready/pending, 1 hard error (record
// state:"error" or thrown handler), 2 CLI usage, 3 needs_credentials.
import type { OvercastRecord } from "../types.ts";

/** Parse a stream of concatenated JSON objects (tolerates stray non-JSON). */
export function parseRecords(stdout: string): OvercastRecord[] {
  const out: OvercastRecord[] = [];
  const s = stdout;
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "{") {
      i++;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (esc) {
        esc = false;
        continue;
      }
      if (inStr) {
        if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    const chunk = s.slice(i, j);
    try {
      const v = JSON.parse(chunk);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as OvercastRecord);
      i = j;
    } catch {
      // not a JSON object after all — skip past this brace and keep scanning
      i++;
    }
  }
  return out;
}

export type CliFailureKind = "error" | "usage" | "needs_credentials" | "unknown";

export interface CliFailure {
  kind: CliFailureKind;
  message: string;
}

export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** Map a finished CLI run to a user-presentable failure (undefined = success). */
export function failureFor(
  code: number,
  records: OvercastRecord[],
  stderr: string,
): CliFailure | undefined {
  if (code === 0) return undefined;
  const errRec = records.find((r) => r.state === "error" || r.error);
  const payloadErr =
    errRec && typeof errRec.payload === "object" && errRec.payload !== null
      ? (errRec.payload as { error?: unknown }).error
      : undefined;
  const message =
    (typeof errRec?.error === "string" && errRec.error) ||
    (typeof payloadErr === "string" && payloadErr) ||
    firstLine(stderr) ||
    `overcast exited with code ${code}`;
  if (code === 3) return { kind: "needs_credentials", message };
  if (code === 2) return { kind: "usage", message };
  if (code === 1) return { kind: "error", message };
  return { kind: "unknown", message };
}

/** First record whose verb matches (records can include appended suggested findings). */
export function recordForVerb(
  records: OvercastRecord[],
  verb: string,
): OvercastRecord | undefined {
  return records.find((r) => r.verb === verb);
}

/** Collect every .html path mentioned in a record payload (artifact routing). */
export function htmlPathsInPayload(payload: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (/\.html?$/i.test(v) && !/^https?:/i.test(v)) found.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(payload);
  return [...new Set(found)];
}
