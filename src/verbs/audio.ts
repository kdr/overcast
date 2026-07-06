// `audio` verb: local Shazam-style (Wang 2003) audio fingerprint matching. `audio
// add` fingerprints a recording into a local audio-fp index (constellation-map
// hashes, cached on disk like basic-clip embeddings); `audio match` finds which
// indexed recording contains a query AND where (offset-histogram alignment), or
// compares two clips directly (`audio match <query> <reference>`). Deliberately
// local-only — the audio twin of the `image` (RANSAC) verb. Robust to
// transcode/noise/clipping; NOT robust to pitch/speed change (classic Wang).

import { existsSync, mkdirSync } from "node:fs";
import { makeRecord, isReady, type OvercastRecord } from "../record.js";
import { addMember, findIndex, resolveIndexRef } from "../state/index.js";
import { localIndexDir } from "../providers/local/vision.js";
import { runLocalAudio } from "../providers/local/audio.js";
import { resolveVideoArg } from "./media-ref.js";
import { provenanceFromCapture, stampProvenance } from "./provenance.js";
import { badNumber } from "./validate.js";
import type { Case } from "../case.js";
import type { VerbSpec } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "audio", format: "json", payload: { error: message }, error: message, state: "error" });
}

/** Resolve + validate a local audio-fp index the query/add targets. */
function localAudioIndex(ctxCase: Case, value: unknown): { id?: string; error?: string } {
  const raw = value != null ? String(value).trim() : "";
  if (!raw) return { error: "--index requires a local audio-fp index id/name" };
  const r = resolveIndexRef(ctxCase, raw);
  if (r.error) return { error: r.error };
  const entry = r.entry ?? findIndex(ctxCase, raw);
  if (!entry) return { error: `unknown local audio-fp index: ${raw}` };
  if (entry.type !== "audio-fp") return { error: `index ${entry.id} is type '${entry.type}', not audio-fp` };
  if (entry.backend !== "local") return { error: `index ${entry.id} is not local; create one with \`index create <name> --type audio-fp --local\`` };
  return { id: entry.id };
}

export const audioVerb: VerbSpec = {
  name: "audio",
  group: "sense",
  summary: "Shazam-style exact audio matching: fingerprint clips into a local audio-fp index, or match clip-to-clip with time-offset alignment.",
  description:
    "`audio add <audio|video|record-id> --index <local-audio-fp-index>` fingerprints a recording " +
    "(Wang 2003 constellation hashes) and caches it in a local audio-fp index. " +
    "`audio match <query> --index <id>` finds which indexed recording contains the query and WHERE " +
    "(offset-histogram alignment: 'query audio appears at 01:23 in recording Y'). " +
    "`audio match <query> <reference>` compares two clips directly, no index needed. " +
    "Videos are accepted — their audio track is extracted. Robust to transcode/noise/clipping; " +
    "NOT robust to pitch/speed change.",
  args: [
    { name: "action", summary: "add | match", required: true, choices: ["add", "match"] },
    { name: "input", summary: "audio/video path, URL, or record id (the query for match)", required: false },
    // declared so the pi AgentTool reconstructs it as a positional (see the
    // `index` verb's arg2 note) — the second clip for direct clip-to-clip match.
    { name: "reference", summary: "match: a second clip for direct clip-to-clip comparison (instead of --index)", required: false },
  ],
  flags: [
    { name: "index", summary: "local audio-fp index id/name", type: "string" },
    { name: "to", summary: "alias for --index when adding", type: "string" },
    { name: "min-votes", summary: "minimum time-aligned hash votes to confirm a match", type: "number", default: 6 },
    { name: "min-ratio", summary: "minimum aligned-votes / query-hashes ratio (0–1)", type: "number" },
    { name: "min-margin", summary: "minimum ratio of best-offset votes over the next-best offset (≥1); a true exact match scores 100s–1000s×, a pitch/speed-shifted copy ~1.2–1.7× — raise this (e.g. 2) to reject sped-up re-uploads", type: "number" },
    { name: "draw", summary: "match: render an SVG alignment visualization per match (hash-pair scatter + offset histogram) — embeds in briefs like image --draw", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "audio.match",
  providerKey: "audio",
  run: async (ctx) => {
    const action = ctx.input;
    if (action !== "add" && action !== "match") {
      return [err("usage: audio <add|match> <query> --index <local-audio-fp-index>  (or: audio match <query> <reference>)")];
    }
    const input = ctx.rest[0];
    const reference = ctx.rest[1];
    if (!input) return [err(`audio ${action} requires an audio/video input`)];

    const numErr =
      badNumber(ctx.opts, "min-votes", (n) => n >= 1, "at least 1") ??
      badNumber(ctx.opts, "min-ratio", (n) => n >= 0 && n <= 1, "0–1") ??
      badNumber(ctx.opts, "min-margin", (n) => n >= 1, "at least 1");
    if (numErr) return [err(`audio ${action}: ${numErr}`)];

    const indexValue = ctx.opts.index ?? ctx.opts.to;
    const minVotes = ctx.opts["min-votes"] != null ? Number(ctx.opts["min-votes"]) : undefined;
    const minRatio = ctx.opts["min-ratio"] != null ? Number(ctx.opts["min-ratio"]) : undefined;
    const minMargin = ctx.opts["min-margin"] != null ? Number(ctx.opts["min-margin"]) : undefined;

    // ---- add: fingerprint a member into an index (no pairwise) ----
    if (action === "add") {
      if (reference) return [err("audio add takes one input; a second positional is only for `audio match <query> <reference>`")];
      const idx = localAudioIndex(ctx.case, indexValue);
      if (idx.error) return [err(`audio add: ${idx.error}`)];
      const q = resolveVideoArg(ctx.case, input, "audio add");
      if (q.error) return [err(q.error)];
      const entry = findIndex(ctx.case, idx.id!);
      if (entry?.members.some((m) => m.ref === q.ref)) {
        return [makeRecord({ verb: "audio", format: "json", payload: { op: "add", index: idx.id, file: q.ref, already_member: true }, media: { ref: q.ref! }, meta: { case: ctx.case.dir }, state: "ready" })];
      }
      mkdirSync(localIndexDir(ctx.case, idx.id!), { recursive: true });
      const rec = await runLocalAudio(ctx.case, q.ref!, { op: "add", indexId: idx.id!, signal: ctx.signal });
      // register the member only after the fingerprint SUCCEEDED (mirrors similar
      // add) — a failed fingerprint must not leave a cacheless member that match
      // would silently skip.
      if (isReady(rec) && !entry?.members.some((m) => m.ref === q.ref)) {
        addMember(ctx.case, idx.id!, { ref: q.ref!, recordId: q.recordId });
      }
      return [rec];
    }

    // ---- match: exactly one of pairwise reference XOR --index ----
    if (reference && indexValue) return [err("audio match: pass either a second clip (clip-to-clip) OR --index, not both")];
    if (!reference && !indexValue) return [err("audio match: pass --index <audio-fp-index> or a second clip to compare against")];

    const q = resolveVideoArg(ctx.case, input, "audio match");
    if (q.error) return [err(q.error)];
    if (!/^https?:\/\//i.test(q.ref!) && !existsSync(q.ref!)) return [err(`audio match: input not found: ${q.ref}`)];

    let rec: OvercastRecord;
    if (reference) {
      const ref = resolveVideoArg(ctx.case, reference, "audio match");
      if (ref.error) return [err(ref.error)];
      if (!/^https?:\/\//i.test(ref.ref!) && !existsSync(ref.ref!)) return [err(`audio match: reference not found: ${ref.ref}`)];
      rec = await runLocalAudio(ctx.case, q.ref!, { op: "match", against: ref.ref!, minVotes, minRatio, minMargin, draw: ctx.opts.draw === true, signal: ctx.signal });
    } else {
      const idx = localAudioIndex(ctx.case, indexValue);
      if (idx.error) return [err(`audio match: ${idx.error}`)];
      rec = await runLocalAudio(ctx.case, q.ref!, { op: "match", indexId: idx.id!, minVotes, minRatio, minMargin, draw: ctx.opts.draw === true, signal: ctx.signal });
    }
    // if the query was captured from a post, trace the match back to it
    stampProvenance(rec, provenanceFromCapture(ctx.case, q.ref));
    return [rec];
  },
};
