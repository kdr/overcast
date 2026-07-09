// `voice` verb: local speaker verification (voice match). `voice add` enrolls a
// clip's speaker windows into a local voice-print index (pyannote wespeaker
// embeddings, cached on disk like basic-clip embeddings); `voice match <clip>
// <sample>` ranks WHERE a reference voice speaks in a clip (windowed cosine
// scoring; `--diarize` upgrades to diarize-then-match against pipeline speaker
// centroids — HF_TOKEN gated, falls back to windowed); `voice match <sample>
// --index <id>` ranks which enrolled members contain the speaker. Deliberately
// local-only — the speaker-identity twin of `audio` (exact recording) and
// `similar` (audio content). Similarity is a 0–100 RANK score (anchored cosine),
// not a probability, and NOT liveness: cloned/synthetic voices can score high.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { errRecord, isReady, makeRecord, type OvercastRecord } from "../record.js";
import { addMember, findIndex, resolveIndexRef } from "../state/index.js";
import { localIndexDir } from "../providers/local/vision.js";
import { defaultVoicePrintConfig, runLocalVoice, writeVoicePrintConfig } from "../providers/local/audio.js";
import { resolveVideoArg } from "./media-ref.js";
import { provenanceCase, resolveIndexScope, stampArchive } from "../archive.js";
import { provenanceFromCapture, stampProvenance } from "./provenance.js";
import { badNumber, numFlag } from "./validate.js";
import type { Case } from "../case.js";
import type { VerbSpec } from "../registry/types.js";

const err = (message: string): OvercastRecord => errRecord("voice", message);

/** Resolve + validate a local voice-print index the query/add targets. */
function localVoiceIndex(ctxCase: Case, value: unknown): { id?: string; error?: string } {
  const raw = value != null ? String(value).trim() : "";
  if (!raw) return { error: "--index requires a local voice-print index id/name" };
  const r = resolveIndexRef(ctxCase, raw);
  if (r.error) return { error: r.error };
  const entry = r.entry ?? findIndex(ctxCase, raw);
  if (!entry) return { error: `unknown local voice-print index: ${raw}` };
  if (entry.type !== "voice-print") return { error: `index ${entry.id} is type '${entry.type}', not voice-print` };
  if (entry.backend !== "local") return { error: `index ${entry.id} is not local; create one with \`index create <name> --type voice-print --local\`` };
  return { id: entry.id };
}

/** Flags that only apply to specific ops — reject mismatches rather than
 *  silently ignoring them (mirrors face's FLAG_OPS table). */
const FLAG_OPS: ReadonlyArray<[flag: string, ops: string, why: string]> = [
  ["diarize", "match (pairwise)", "diarize-then-match scans one clip"],
  ["speakers", "match --diarize", "expected speaker count is a diarization hint"],
  ["start", "match (pairwise)", "members and searches score whole clips"],
  ["end", "match (pairwise)", "members and searches score whole clips"],
  ["window", "match (pairwise)", "members follow the index config set at `index create`"],
  ["offset", "match --index", "pagination only applies to an index search"],
];

export const voiceVerb: VerbSpec = {
  name: "voice",
  group: "sense",
  summary: "Speaker verification: enroll voices into a local voice-print index, or find/rank a reference voice inside a clip or across members.",
  description:
    "`voice add <audio|video|record-id> --index <local-voice-print-index>` embeds a clip's voiced windows " +
    "(pyannote wespeaker speaker embeddings, run locally) and caches them in a local voice-print index. " +
    "`voice match <clip> <sample>` ranks where the sample's SPEAKER talks in the clip (windowed cosine scan; " +
    "`--diarize` upgrades to diarize-then-match against per-speaker centroids — needs HF_TOKEN + the accepted " +
    "pyannote license like `enhance --ops separate`, and falls back to windowed without it). " +
    "`voice match <sample> --index <id>` ranks which enrolled members contain the speaker. " +
    "Videos are accepted — their audio track is extracted. `similarity` is a 0–100 rank score " +
    "(anchored cosine; 50 ≈ the accept floor, 90 ≈ strong same-speaker), not a probability, and NOT liveness — " +
    "a cloned/synthetic voice can score high; cross-language or degraded speech scores lower. " +
    "To list a clip's speakers without a reference, use `enhance --ops separate`.",
  args: [
    { name: "action", summary: "add | match", required: true, choices: ["add", "match"] },
    { name: "input", summary: "audio/video path or record id (add: the clip to enroll; match: the clip to scan, or the sample when searching --index)", required: false },
    // declared so the pi AgentTool reconstructs it as a positional (see the
    // `audio` verb's reference note) — the sample for pairwise clip-vs-sample match.
    { name: "sample", summary: "match: the reference voice sample for pairwise `voice match <clip> <sample>` (instead of --index)", required: false },
  ],
  flags: [
    { name: "index", summary: "local voice-print index id/name", type: "string" },
    { name: "to", summary: "alias for --index when adding", type: "string" },
    { name: "min-similarity", summary: "score floor 0–100 (default 50 ≈ the accept threshold; suggested findings fire at 80)", type: "number" },
    { name: "min-margin", summary: "minimum score-point gap between the best match and the runner-up speaker (diarized) or the clip's median window (windowed/search) — a cheap calibration gate", type: "number" },
    { name: "diarize", summary: "pairwise match: diarize-then-match (overlap-aware; needs HF_TOKEN + accepted pyannote license, else falls back to windowed)", type: "boolean" },
    { name: "speakers", summary: "match --diarize: expected speaker count hint", type: "number" },
    { name: "start", summary: "pairwise match: scan window start (seconds or HH:MM:SS)", type: "string" },
    { name: "end", summary: "pairwise match: scan window end (seconds or HH:MM:SS)", type: "string" },
    { name: "window", summary: "pairwise match: seconds per embedding window (default 3; members follow the index config)", type: "number" },
    { name: "limit", summary: "match: max results", type: "number" },
    { name: "offset", summary: "match --index: result offset", type: "number" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "voice.match",
  providerKey: "voice",
  run: async (ctx) => {
    const action = ctx.input;
    if (action !== "add" && action !== "match") {
      return [err("usage: voice <add|match> <clip> --index <local-voice-print-index>  (or: voice match <clip> <sample>)")];
    }
    const input = ctx.rest[0];
    const sample = ctx.rest[1];
    if (!input) return [err(`voice ${action} requires an audio/video input`)];

    const numErr =
      badNumber(ctx.opts, "min-similarity", (n) => n >= 0 && n <= 100, "0–100") ??
      badNumber(ctx.opts, "min-margin", (n) => n >= 0, "a non-negative number") ??
      badNumber(ctx.opts, "speakers", (n) => n >= 1 && Number.isInteger(n), "an integer of at least 1") ??
      badNumber(ctx.opts, "window", (n) => n > 0, "a positive number of seconds") ??
      badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "offset", (n) => n >= 0, "a non-negative number");
    if (numErr) return [err(`voice ${action}: ${numErr}`)];
    // a provided-but-blank timestamp is a typo, not "unset" (mirrors face)
    for (const f of ["start", "end"] as const) {
      if (ctx.opts[f] != null && !String(ctx.opts[f]).trim()) {
        return [err(`voice ${action}: --${f} requires a timestamp (seconds or HH:MM:SS)`)];
      }
    }
    if (action === "match" && ctx.opts.speakers != null && ctx.opts.diarize !== true) {
      return [err("voice match: --speakers is a diarization hint — add --diarize")];
    }

    const indexValue = ctx.opts.index ?? ctx.opts.to;
    // `--index archive:<bucket>/<index>` targets a BUCKET's voice-print DB (like
    // audio/similar): the mirror + cached embeddings live in the bucket, the
    // match evidence persists to the active case stamped meta.archive.
    const scoped = resolveIndexScope(ctx.case, indexValue != null ? String(indexValue) : "", ctx.home);
    if (scoped.error) return [err(`voice ${action}: ${scoped.error}`)];
    const scope = scoped.scope;
    const scopedIndexValue = indexValue == null ? indexValue : scoped.value;
    const minSimilarity = numFlag(ctx.opts, "min-similarity");
    const minMargin = numFlag(ctx.opts, "min-margin");
    const limit = numFlag(ctx.opts, "limit");

    // ---- add: enroll a member's voice windows into an index ----
    if (action === "add") {
      if (sample) return [err("voice add takes one input; a second positional is only for `voice match <clip> <sample>`")];
      const bad = FLAG_OPS.find(([flag]) => flag !== "offset" && ctx.opts[flag] != null);
      if (bad) return [err(`voice add: --${bad[0]} only applies to ${bad[1]} (${bad[2]})`)];
      if (ctx.opts.offset != null || minSimilarity != null || minMargin != null || limit != null) {
        return [err("voice add enrolls a member — match flags (--min-similarity/--min-margin/--limit/--offset) don't apply")];
      }
      const idx = localVoiceIndex(scope, scopedIndexValue);
      if (idx.error) return [err(`voice add: ${idx.error}`)];
      const q = resolveVideoArg(ctx.case, input, "voice add", { home: ctx.home });
      if (q.error) return [err(q.error)];
      const entry = findIndex(scope, idx.id!);
      if (entry?.members.some((m) => m.ref === q.ref)) {
        return [stampArchive(makeRecord({ verb: "voice", format: "json", payload: { op: "add", index: idx.id, file: q.ref, already_member: true }, media: { ref: q.ref! }, meta: { case: ctx.case.dir }, state: "ready" }), scoped.bucket, ctx.case.dir)];
      }
      const dir = localIndexDir(scope, idx.id!);
      mkdirSync(dir, { recursive: true });
      // defensive: pin the model/window config on first enroll if create didn't
      // (the provider's model guard + cache hash key off this file)
      if (!existsSync(join(dir, "config.json"))) writeVoicePrintConfig(dir, defaultVoicePrintConfig());
      const rec = await runLocalVoice(scope, q.ref!, { op: "add", indexId: idx.id!, signal: ctx.signal });
      // register the member only after the embed SUCCEEDED (mirrors audio add) —
      // a failed embed must not leave a cacheless member that search would skip.
      if (isReady(rec) && !entry?.members.some((m) => m.ref === q.ref)) {
        addMember(scope, idx.id!, { ref: q.ref!, recordId: q.recordId });
      }
      return [stampArchive(rec, scoped.bucket, ctx.case.dir)];
    }

    // ---- match: exactly one of pairwise sample XOR --index ----
    if (sample && indexValue) return [err("voice match: pass either a sample (clip-vs-sample) OR --index, not both")];
    if (!sample && !indexValue) return [err("voice match: pass --index <voice-print-index> or a reference sample to find in the clip")];

    const q = resolveVideoArg(ctx.case, input, "voice match", { home: ctx.home });
    if (q.error) return [err(q.error)];
    if (!/^https?:\/\//i.test(q.ref!) && !existsSync(q.ref!)) return [err(`voice match: input not found: ${q.ref}`)];

    let rec: OvercastRecord;
    if (sample) {
      const ref = resolveVideoArg(ctx.case, sample, "voice match", { home: ctx.home });
      if (ref.error) return [err(ref.error)];
      if (!/^https?:\/\//i.test(ref.ref!) && !existsSync(ref.ref!)) return [err(`voice match: sample not found: ${ref.ref}`)];
      if (ctx.opts.offset != null) return [err("voice match: --offset only applies to an index search (`voice match <sample> --index <id>`)")];
      rec = await runLocalVoice(ctx.case, q.ref!, {
        op: "match",
        match: ref.ref!,
        diarize: ctx.opts.diarize === true,
        speakers: numFlag(ctx.opts, "speakers"),
        start: ctx.opts.start != null ? String(ctx.opts.start) : undefined,
        end: ctx.opts.end != null ? String(ctx.opts.end) : undefined,
        window: numFlag(ctx.opts, "window"),
        minSimilarity,
        minMargin,
        limit,
        signal: ctx.signal,
      });
    } else {
      const bad = FLAG_OPS.find(([flag]) => flag !== "offset" && ctx.opts[flag] != null);
      if (bad) return [err(`voice match --index: --${bad[0]} only applies to ${bad[1]} (${bad[2]})`)];
      const idx = localVoiceIndex(scope, scopedIndexValue);
      if (idx.error) return [err(`voice match: ${idx.error}`)];
      rec = await runLocalVoice(scope, q.ref!, {
        op: "search",
        indexId: idx.id!,
        minSimilarity,
        minMargin,
        limit,
        offset: numFlag(ctx.opts, "offset"),
        signal: ctx.signal,
      });
    }
    // if the clip was captured from a post, trace the match back to it (the
    // bucket case when the query is an archive ref — parity with audio/similar)
    stampProvenance(rec, provenanceFromCapture(provenanceCase(ctx.case, q.archive, ctx.home), q.ref));
    return [stampArchive(rec, scoped.bucket, ctx.case.dir)];
  },
};
