// Default `listen` provider: tinycloud (exec): a SPEECH-ONLY describe
// Maps the tinycloud envelope to an `audio.analysis` record at
// the exec boundary. Swap to a local whisper via http/in-proc for offline use.
//
// Single-call default path: tinycloud ≥ 0.3.12 (the documented floor) ships the
// VERBATIM cues inline in the watch envelope again (`segments[].speech`, an
// array of cue strings per segment). The public `tinycloud caption` verb still
// backs two gaps: `--diarize` (watch has no diarize flag) and older tinyclouds
// (0.3.10/0.3.11 shipped `segments: []` for audio / short sources), where
// mapping the envelope alone would silently store the LLM summary as the
// "transcript" — never let a summary pose as the spoken words.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRecord, type OvercastRecord } from "../../record.js";
import { redactSecrets } from "../../env.js";
import { execCapture, renderCommand, parseFirstJson } from "../exec.js";
import { segmentSpeechCues, tinycloudBase } from "./envelope.js";

const DEFAULT_RUN = "tinycloud watch {{input}} --speech-only --json";

function envelopeData(parsed: unknown): Record<string, unknown> {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (o.data && typeof o.data === "object") return o.data as Record<string, unknown>;
    return o;
  }
  return {};
}

function providerErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const o = value as Record<string, unknown>;
  const code = typeof o.code === "string" ? o.code : "";
  const message = typeof o.message === "string" ? o.message : "";
  if (code && message) return `${code}: ${message}`;
  return message || code;
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

/** Build a transcript + speaker-tagged segments[] from tinycloud segments.
 *  SPEECH fields only — a segment's `summary`/`description` is scene prose,
 *  not spoken words; the caller decides (and marks) any summary fallback.
 *  Cue extraction + boundary dedupe live in the shared `segmentSpeechCues`
 *  (envelope.ts), the same seam `watch` renders through. */
function segments(data: Record<string, unknown>): {
  transcript: string;
  segments: Array<Record<string, unknown>>;
} {
  const raw = Array.isArray(data.segments) ? data.segments : [];
  const out: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let prev: ReadonlySet<string> = new Set<string>();
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const { fresh, cues } = segmentSpeechCues(seg, prev);
    prev = cues;
    // tolerate numeric-string timestamps from external APIs ("12.5").
    const start = toSeconds(seg.start_time ?? seg.start_seconds ?? seg.start);
    const end = toSeconds(seg.end_time ?? seg.end_seconds ?? seg.end);
    const speaker = seg.speaker;
    for (const text of fresh) {
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
  return { transcript: lines.join("\n"), segments: out };
}

/** Fetch the verbatim transcript cues through the public `tinycloud caption`
 *  verb (local once `watch` has cached the speech enrichment). Best-effort:
 *  a provider failure returns undefined and the caller keeps the envelope
 *  mapping — but a CANCELLATION (opts.signal) rethrows, so an aborted listen
 *  never masquerades as a finished record with a summary transcript.
 *  Honors OVERCAST_TINYCLOUD_CMD like the other tinycloud-backed verbs. */
async function captionTranscript(
  input: string,
  opts: { diarize?: boolean; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ transcript: string; segments: Array<Record<string, unknown>> } | undefined> {
  const [cmd, ...lead] = tinycloudBase();
  if (!cmd) return undefined;
  // caption writes an .srt sidecar — point it at a scratch dir so nothing
  // lands next to the evidence media; the cues we need are in the envelope.
  const outDir = mkdtempSync(join(tmpdir(), "oc-caption-"));
  try {
    const args = [...lead, "caption", input, "--json", "-o", outDir];
    if (opts.diarize) args.push("--diarize");
    const res = await execCapture(cmd, args, {
      // same ceiling as the preceding watch call — the caption pass may do the
      // actual transcription work when the enrichment isn't cached yet, so a
      // shorter default here would drop verbatim cues that were still coming.
      timeoutMs: opts.timeoutMs ?? 15 * 60_000,
      env: opts.env,
      signal: opts.signal,
    });
    if (res.code !== 0) return undefined;
    const data = envelopeData(parseFirstJson(res.stdout));
    const raw = Array.isArray(data.cues) ? data.cues : [];
    // Only lift "SPEAKER: words" labels out of cues the envelope CONFIRMS are
    // diarized (`diarized: true`). Requested-but-unavailable (`false`) or a
    // missing flag both mean plain speech — a cue starting "Warning: …" must
    // never gain a phantom speaker; an unlifted real label merely stays
    // verbatim in the text, which loses nothing.
    const liftSpeakers = opts.diarize && data.diarized === true;
    const segs: Array<Record<string, unknown>> = [];
    const lines: string[] = [];
    for (const c of raw) {
      if (!c || typeof c !== "object") continue;
      const cue = c as Record<string, unknown>;
      let text = typeof cue.text === "string" ? cue.text.trim() : "";
      if (!text) continue;
      // diarized cues arrive as "SPEAKER: words" — lift the label out.
      let speaker: string | undefined;
      if (liftSpeakers) {
        const m = text.match(/^([^:\n]{1,24}):\s+([\s\S]*)$/);
        if (m) {
          speaker = m[1];
          text = m[2];
        }
      }
      const start = toSeconds(cue.start_time ?? cue.start);
      const end = toSeconds(cue.end_time ?? cue.end);
      const entry: Record<string, unknown> = speaker ? { speaker, text } : { text };
      if (start !== undefined && end !== undefined) entry.at = [start, end];
      else if (start !== undefined) entry.at = start;
      segs.push(entry);
      lines.push(speaker ? `${speaker}: ${text}` : text);
    }
    if (lines.length === 0) return undefined;
    return { transcript: lines.join("\n"), segments: segs };
  } catch (e) {
    // cancellation is not a provider failure — propagate it (matches how an
    // abort during the watch step already rejects out of runListen).
    if (opts.signal?.aborted) throw e;
    return undefined;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Full multimodal describe → surfaces tinycloud's AUDIO descriptions (sounds,
 *  music, events, ambience), not just speech. The Audio-Flamingo-style path that
 *  runs turnkey on Cloudglue (no GPU). */
const DESCRIBE_RUN = "tinycloud watch {{input}} --json";

export interface ListenOptions {
  run?: string;
  /** describe mode: full multimodal describe (audio scene description), not speech-only */
  describe?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** attribute speech to distinct speakers (--diarize) */
  diarize?: boolean;
  /** hint/force source language (--lang en) */
  lang?: string;
}

/** Build the audio-scene description from the full describe (summary + segments). */
function audioDescription(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof data.summary === "string") parts.push(data.summary as string);
  const segs = Array.isArray(data.segments) ? data.segments : [];
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const a = seg.start_time ?? seg.start_seconds ?? seg.start ?? "";
    const b = seg.end_time ?? seg.end_seconds ?? seg.end ?? "";
    const d = (seg.description as string) ?? (seg.summary as string) ?? "";
    if (d) parts.push(`[${a}–${b}] ${d}`);
  }
  return parts.join("\n");
}

/** Run the tinycloud provider and map to an audio.analysis record. Default is a
 *  speech-only transcript; `describe` mode adds audio-scene description. */
export async function runListen(
  input: string,
  opts: ListenOptions = {},
): Promise<OvercastRecord> {
  // Empty/whitespace run template falls back to the default; --describe selects
  // the full multimodal describe template. A binding pinned to the stock
  // template still counts as the default path (mirrors runWatch), which honors
  // OVERCAST_TINYCLOUD_CMD via tinycloudBase.
  const configured = opts.run?.trim();
  const isDefault = !configured || configured === DEFAULT_RUN || configured === DESCRIBE_RUN;
  const template = isDefault ? (opts.describe ? DESCRIBE_RUN : DEFAULT_RUN) : configured;
  const argv = isDefault
    ? [...tinycloudBase(), "watch", input, ...(opts.describe ? [] : ["--speech-only"]), "--json"]
    : renderCommand(template, { input });
  const [cmd, ...args] = argv;
  // A template that renders to no command would reject at spawn and throw;
  // surface it as a normal error record like other failures.
  if (!cmd) {
    return makeRecord({
      verb: "listen",
      format: "json",
      payload: { transcript: "", segments: [], language: null },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error: `listen run template produced an empty command: ${JSON.stringify(template)}`,
      state: "error",
    });
  }
  // Forward the declared listen flags to a CUSTOM provider command (the
  // wrapper's contract). The default tinycloud `watch` REJECTS both flags
  // ("Unknown flag for watch: --diarize") — on the default path --diarize
  // rides the caption pass below and --lang has no tinycloud equivalent.
  if (!isDefault) {
    if (opts.diarize) args.push("--diarize");
    if (opts.lang) args.push("--lang", opts.lang);
  }
  const res = await execCapture(cmd, args, {
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    env: opts.env,
    signal: opts.signal,
  });

  // No parseable JSON at all → surface the exit code (parse JSON first, like
  // runWatch, so a non-zero exit that still prints an error envelope keeps its
  // detail instead of being dropped here).
  const parsed = parseFirstJson(res.stdout);
  if (parsed === undefined) {
    return makeRecord({
      verb: "listen",
      format: "json",
      payload: { transcript: "", segments: [], language: null },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error:
        res.code === 0
          ? "tinycloud listen produced no JSON output"
          : res.code === 13
            ? "tinycloud listen needs credentials (exit 13 — set CLOUDGLUE_API_KEY)"
            : `tinycloud listen exited ${res.code}: ${redactSecrets(res.stderr.trim().slice(0, 500))}`,
      // exit 13 = missing creds, matching runExecProvider + the source providers
      state: res.code === 13 ? "needs_credentials" : "error",
    });
  }

  const data = envelopeData(parsed);
  const envObj =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  // An error envelope is a failure even when JSON parsed and exit was 0 — the
  // record's state/error is authoritative, so surface it instead of storing a
  // silent "ready" listen record (mirrors runWatch).
  const envError = providerErrorMessage(envObj.error) || providerErrorMessage(data.error);
  // A non-zero exit OR an error envelope is a failure even when JSON parsed —
  // apply them together (like runWatch), and treat exit 13 as a cred gap.
  if (
    res.code !== 0 ||
    envObj.status === "error" ||
    envObj.state === "error" ||
    data.status === "error" ||
    Boolean(envError)
  ) {
    // isDefault, not a bare opts.run check: a binding pinned to the stock
    // template (what `provider setup apply --choice tinycloud` materializes)
    // must get the same graceful speech-only fallback as an unbound profile.
    const visualDescribeUnavailable =
      opts.describe &&
      isDefault &&
      /(?:enable_visual_scene_description|visual scene description) is not available for audio files/i.test(envError);
    if (visualDescribeUnavailable) {
      const fallback = await runListen(input, {
        ...opts,
        describe: false,
        run: undefined,
      });
      if (fallback.state !== "ready") return fallback;
      fallback.payload = {
        ...(fallback.payload as Record<string, unknown>),
        description: "",
        warning:
          "tinycloud full describe is not available for audio-only files; used speech-only transcript instead.",
      };
      fallback.meta = {
        ...fallback.meta,
        mode: "speech_fallback",
        warning: envError,
      };
      return fallback;
    }
    return makeRecord({
      verb: "listen",
      format: "json",
      payload: { transcript: "", segments: [], language: null },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error:
        envError ||
        (res.code === 13
          ? "tinycloud listen needs credentials (exit 13 — set CLOUDGLUE_API_KEY)"
          : `tinycloud listen failed (exit ${res.code}): ${redactSecrets(res.stderr.trim().slice(0, 500))}`),
      state: res.code === 13 ? "needs_credentials" : "error",
    });
  }

  let { transcript, segments: segs } = segments(data);
  let transcriptSource: "segments" | "caption" | "transcript" | "summary" | undefined =
    segs.length > 0 ? "segments" : undefined;
  const language =
    (typeof data.language === "string" && data.language) ||
    (typeof data.lang === "string" && (data.lang as string)) ||
    null;

  // tinycloud may return a pending (async) job envelope.
  // Honor an explicit provider state in the envelope (exit 0): a needs_credentials
  // or pending marker is authoritative (matches runExecProvider + runWatch).
  const isPending = (o: Record<string, unknown>) =>
    o.state === "pending" || o.status === "pending";
  const needsCreds = (o: Record<string, unknown>) =>
    o.state === "needs_credentials" || o.status === "needs_credentials";
  const state =
    needsCreds(envObj) || needsCreds(data)
      ? "needs_credentials"
      : isPending(envObj) || isPending(data)
        ? "pending"
        : "ready";

  // Default path: tinycloud ≥ 0.3.12 (the floor) inlines the VERBATIM cues in
  // the watch envelope (`segments[].speech`), so a ready envelope with speech
  // needs no second call. The public `caption` verb still covers two gaps:
  // --diarize (watch has no diarize flag) and an older tinycloud whose
  // speech-only envelope shipped segments: [] (0.3.10/0.3.11).
  // Best-effort: a caption failure keeps the envelope mapping.
  let warning: string | undefined;
  if (isDefault && state === "ready" && (opts.diarize || !transcript)) {
    const cap = await captionTranscript(input, {
      diarize: opts.diarize,
      env: opts.env,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    if (cap) {
      transcript = cap.transcript;
      segs = cap.segments;
      transcriptSource = "caption";
    } else if (opts.diarize && transcript) {
      warning =
        "diarization was unavailable (the caption pass failed) — `transcript` is the undiarized verbatim speech from the watch envelope.";
    }
  }

  // Last-resort fallbacks for an empty transcript: a top-level transcript
  // string is real speech; the summary is NOT — keep it visible but say so.
  // READY records only: a pending async envelope hasn't run the caption pass
  // yet, so copying its summary into `transcript` now would ship the exact
  // summary-as-speech confusion this file exists to prevent.
  if (!transcript && state === "ready") {
    if (typeof data.transcript === "string" && data.transcript) {
      transcript = data.transcript;
      transcriptSource = "transcript";
    } else if (typeof data.summary === "string" && data.summary) {
      transcript = data.summary;
      transcriptSource = "summary";
      warning =
        "no verbatim speech was available from the provider — `transcript` holds the provider's SUMMARY of the audio, not the spoken words.";
    }
  }
  // READY only, like the summary fallback above: a pending/needs_credentials
  // record transcribed nothing, so "was auto-detected" would be false.
  if (isDefault && opts.lang && state === "ready") {
    warning = [
      warning,
      "the default tinycloud backend has no --lang option; the source language was auto-detected.",
    ]
      .filter(Boolean)
      .join(" ");
  }

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

  const payload: Record<string, unknown> = { transcript, segments: segs, language };
  if (warning) payload.warning = warning;
  // describe mode surfaces the audio-scene description alongside the transcript
  if (opts.describe) payload.description = audioDescription(data);

  const meta: Record<string, unknown> = {
    provider: "tinycloud",
    model: "cloudglue",
    mode: opts.describe ? "describe" : "speech",
  };
  if (transcriptSource) meta.transcript_source = transcriptSource;

  return makeRecord({
    verb: "listen",
    format: "json",
    payload,
    media: mediaAt !== undefined ? { ref: input, at: mediaAt } : { ref: input },
    meta,
    state,
  });
}
