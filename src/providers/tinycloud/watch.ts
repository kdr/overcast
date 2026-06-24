// Default `watch` provider: tinycloud (exec). Invariant #11 — call tinycloud
// only via its public CLI verbs; map its envelope to the loose record at THIS
// boundary (invariant #3). v1: a comprehensive describe → flat payload with
// content / transcript / detailed keys (planning/05).

import { existsSync, readFileSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../../record.js";
import {
  execCapture,
  renderCommand,
  parseFirstJson,
} from "../exec.js";
import type { ProviderDescriptor } from "../../profile.js";

const DEFAULT_RUN = "tinycloud watch {{input}} --json";

/** Pull the tinycloud envelope's payload, tolerating bare-data or {data}. */
function envelopeData(parsed: unknown): Record<string, unknown> {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (o.data && typeof o.data === "object") return o.data as Record<string, unknown>;
    return o;
  }
  return {};
}

/** Render a transcript string from tinycloud segments[], when present. */
function transcriptFromSegments(data: Record<string, unknown>): string {
  const segs = data.segments;
  if (!Array.isArray(segs)) return "";
  const lines: string[] = [];
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const t =
      (seg.transcript as string) ??
      (seg.speech as string) ??
      (seg.text as string) ??
      "";
    if (!t) continue;
    const start = seg.start_seconds ?? seg.start ?? "";
    lines.push(start !== "" ? `[${start}] ${t}` : String(t));
  }
  return lines.join("\n");
}

/** A per-segment markdown breakdown (start–end · description — summary). */
function segmentBreakdown(data: Record<string, unknown>): string {
  const segs = data.segments;
  if (!Array.isArray(segs) || segs.length === 0) return "";
  const lines: string[] = ["## Segments"];
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const a = seg.start_time ?? seg.start_seconds ?? seg.start ?? "";
    const b = seg.end_time ?? seg.end_seconds ?? seg.end ?? "";
    const span = a !== "" || b !== "" ? `[${a}–${b}] ` : "";
    const desc = (seg.description as string) ?? "";
    const sum = (seg.summary as string) ?? "";
    lines.push(`- ${span}**${desc}**${sum ? ` — ${sum}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Best-effort markdown "content" (planning/05: markdown of the describe output).
 * Prefers the on-disk describe markdown sidecar; otherwise builds a readable
 * breakdown from title + summary + per-segment descriptions.
 */
function contentMarkdown(data: Record<string, unknown>): string {
  if (typeof data.describe === "string") return data.describe;
  if (typeof data.summary_markdown === "string") return data.summary_markdown as string;

  // tinycloud's describe is an object with a markdown_path sidecar on disk.
  if (data.describe && typeof data.describe === "object") {
    const d = data.describe as Record<string, unknown>;
    const mdPath = d.markdown_path;
    if (typeof mdPath === "string" && existsSync(mdPath)) {
      try {
        const md = readFileSync(mdPath, "utf8");
        if (md.trim()) return md;
      } catch {
        /* fall through to synthesized content */
      }
    }
  }

  // Synthesize from title + summary + segments.
  const parts: string[] = [];
  if (typeof data.title === "string") parts.push(`# ${data.title}`);
  if (typeof data.summary === "string") parts.push(data.summary as string);
  const breakdown = segmentBreakdown(data);
  if (breakdown) parts.push(breakdown);
  return parts.join("\n\n");
}

export interface WatchOptions {
  /** override the run template (from the profile binding) */
  run?: string;
  /** pass-through CLI opts (e.g. speechOnly) reserved for later phases */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Run the tinycloud watch provider on `input` and map to a single record.
 * A non-zero exit or unparseable output yields an error record (state:"error").
 */
export async function runWatch(
  input: string,
  opts: WatchOptions = {},
): Promise<OvercastRecord> {
  // An empty/whitespace run template (e.g. a profile binding set to "") must
  // fall back to the default — `?? DEFAULT_RUN` alone would keep "".
  const template = opts.run && opts.run.trim() ? opts.run : DEFAULT_RUN;
  const argv = renderCommand(template, { input });
  const [cmd, ...args] = argv;

  // A template that renders to no command (all tokens dropped) would reject at
  // spawn and throw; surface it as a normal error record like other failures.
  if (!cmd) {
    return makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "", transcript: "", detailed: null },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error: `watch run template produced an empty command: ${JSON.stringify(template)}`,
      state: "error",
    });
  }

  const res = await execCapture(cmd, args, {
    // full multimodal describe is legitimately slow; allow generous headroom.
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    env: opts.env,
    signal: opts.signal,
  });

  const parsed = parseFirstJson(res.stdout);
  if (parsed === undefined) {
    return makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "", transcript: "", detailed: null },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error:
        res.code === 0
          ? "tinycloud watch produced no JSON output"
          : `tinycloud watch exited ${res.code}: ${res.stderr.trim().slice(0, 500)}`,
      state: "error",
    });
  }

  const data = envelopeData(parsed);
  const envObj =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  // A non-zero exit OR an error envelope is a failure even if JSON parsed — the
  // record's state/error is authoritative, so surface it instead of a silent
  // empty "ready" record (would otherwise mark the video as successfully watched).
  const envError =
    (typeof envObj.error === "string" && envObj.error) ||
    (typeof (data.error as string) === "string" && (data.error as string)) ||
    "";
  const errored =
    res.code !== 0 ||
    envObj.status === "error" ||
    envObj.state === "error" ||
    data.status === "error" ||
    Boolean(envError);
  if (errored) {
    return makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "", transcript: "", detailed: data },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error:
        envError ||
        `tinycloud watch failed (exit ${res.code}): ${res.stderr.trim().slice(0, 500)}`,
      state: "error",
    });
  }

  const content = contentMarkdown(data);
  const transcript =
    typeof data.transcript === "string"
      ? (data.transcript as string)
      : transcriptFromSegments(data);

  // tinycloud may return a pending job envelope (async). Check BOTH the
  // top-level envelope and the unwrapped data object (the pending marker can
  // live under either, depending on the verb path).
  const isPending = (o: Record<string, unknown>) =>
    o.state === "pending" || o.status === "pending";
  const state = isPending(envObj) || isPending(data) ? "pending" : "ready";

  const meta: Record<string, unknown> = { provider: "tinycloud", model: "cloudglue" };
  if (typeof data.title === "string") meta.title = data.title;
  if (typeof data.duration_seconds === "number") meta.duration_seconds = data.duration_seconds;

  return makeRecord({
    verb: "watch",
    format: "json",
    payload: {
      content,
      transcript,
      detailed: data,
    },
    media: { ref: input },
    meta,
    state,
  });
}

/** The default profile descriptor for `watch`. */
export function tinycloudWatchDescriptor(): ProviderDescriptor {
  return {
    type: "exec",
    run: DEFAULT_RUN,
    init: { skill: "tinycloud-init", ensure: true },
    describe: "tinycloud commands --json",
  };
}
