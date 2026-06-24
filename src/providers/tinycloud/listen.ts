// Default `listen` provider: tinycloud (exec), v1 = a SPEECH-ONLY describe
// (planning/05). Maps the tinycloud envelope to an `audio.analysis` record at
// the exec boundary. Swap to a local whisper via http/in-proc for offline use.

import { makeRecord, type OvercastRecord } from "../../record.js";
import { execCapture, renderCommand, parseFirstJson } from "../exec.js";

const DEFAULT_RUN = "tinycloud watch {{input}} --speech-only --json";

function envelopeData(parsed: unknown): Record<string, unknown> {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (o.data && typeof o.data === "object") return o.data as Record<string, unknown>;
    return o;
  }
  return {};
}

/** Coerce a timestamp to seconds, tolerating numeric strings ("12.5"). */
function toSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Build a transcript + speaker-tagged segments[] from tinycloud segments. */
function segments(data: Record<string, unknown>): {
  transcript: string;
  segments: Array<Record<string, unknown>>;
} {
  const raw = Array.isArray(data.segments) ? data.segments : [];
  const out: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const text =
      (seg.transcript as string) ??
      (seg.speech as string) ??
      (seg.text as string) ??
      (seg.summary as string) ??
      "";
    // tolerate numeric-string timestamps from external APIs ("12.5").
    const start = toSeconds(seg.start_time ?? seg.start_seconds ?? seg.start);
    const end = toSeconds(seg.end_time ?? seg.end_seconds ?? seg.end);
    const speaker = seg.speaker;
    if (text) {
      const entry: Record<string, unknown> = { speaker, text };
      // only attach a numeric [start,end] anchor when both endpoints are real
      // numbers — never emit [null,null] / [undefined,undefined].
      if (start !== undefined && end !== undefined) {
        entry.at = [start, end];
      } else if (start !== undefined) {
        entry.at = start;
      }
      out.push(entry);
      lines.push(speaker ? `${String(speaker)}: ${text}` : String(text));
    }
  }
  // fall back to a top-level summary/transcript when no per-segment speech
  let transcript = lines.join("\n");
  if (!transcript) {
    transcript =
      (typeof data.transcript === "string" && data.transcript) ||
      (typeof data.summary === "string" && (data.summary as string)) ||
      "";
  }
  return { transcript, segments: out };
}

export interface ListenOptions {
  run?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** attribute speech to distinct speakers (--diarize) */
  diarize?: boolean;
  /** hint/force source language (--lang en) */
  lang?: string;
}

/** Run the tinycloud speech-only provider and map to an audio.analysis record. */
export async function runListen(
  input: string,
  opts: ListenOptions = {},
): Promise<OvercastRecord> {
  const argv = renderCommand(opts.run ?? DEFAULT_RUN, { input });
  const [cmd, ...args] = argv;
  // Forward the declared listen flags to the provider command.
  if (opts.diarize) args.push("--diarize");
  if (opts.lang) args.push("--lang", opts.lang);
  const res = await execCapture(cmd, args, {
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    env: opts.env,
    signal: opts.signal,
  });

  const parsed = parseFirstJson(res.stdout);
  if (parsed === undefined || res.code !== 0) {
    return makeRecord({
      verb: "listen",
      format: "json",
      payload: { transcript: "", segments: [], language: null },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error:
        res.code === 0
          ? "tinycloud listen produced no JSON output"
          : `tinycloud listen exited ${res.code}: ${res.stderr.trim().slice(0, 500)}`,
      state: "error",
    });
  }

  const data = envelopeData(parsed);
  const envObj =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  // An error envelope is a failure even when JSON parsed and exit was 0 — the
  // record's state/error is authoritative, so surface it instead of storing a
  // silent "ready" listen record (mirrors runWatch).
  const envError =
    (typeof envObj.error === "string" && envObj.error) ||
    (typeof (data.error as string) === "string" && (data.error as string)) ||
    "";
  if (
    envObj.status === "error" ||
    envObj.state === "error" ||
    data.status === "error" ||
    Boolean(envError)
  ) {
    return makeRecord({
      verb: "listen",
      format: "json",
      payload: { transcript: "", segments: [], language: null },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error: envError || "tinycloud listen reported an error envelope",
      state: "error",
    });
  }

  const { transcript, segments: segs } = segments(data);
  const language =
    (typeof data.language === "string" && data.language) ||
    (typeof data.lang === "string" && (data.lang as string)) ||
    null;

  // tinycloud may return a pending (async) job envelope.
  const isPending = (o: Record<string, unknown>) =>
    o.state === "pending" || o.status === "pending";
  const state = isPending(envObj) || isPending(data) ? "pending" : "ready";

  // Record-level seek anchor (the per-segment anchors live in payload.segments):
  // the first segment's start, so `view <listen-rec>` has a seek hint.
  let mediaAt: number | undefined;
  for (const s of segs) {
    const a = s.at;
    if (typeof a === "number") {
      mediaAt = a;
      break;
    }
    if (Array.isArray(a) && typeof a[0] === "number") {
      mediaAt = a[0];
      break;
    }
  }

  return makeRecord({
    verb: "listen",
    format: "json",
    payload: { transcript, segments: segs, language },
    media: mediaAt !== undefined ? { ref: input, at: mediaAt } : { ref: input },
    meta: { provider: "tinycloud", model: "cloudglue" },
    state,
  });
}
