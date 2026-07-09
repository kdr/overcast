// Human-authored case observations. Notes are primary records (not read/meta
// outputs), so they flow through local memory, ask, brief, and case records like
// sensed/captured evidence. They can optionally anchor to a media ref or record.

import { makeRecord, errRecord, type MediaRef, type OvercastRecord } from "../record.js";
import { resolveMediaRef, refPathExists } from "./media-ref.js";
import { parseAtSpan } from "../media/ffmpeg.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

const err = (message: string): OvercastRecord => errRecord("note", message);

function splitTags(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  const tags = String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

function noteText(ctx: VerbContext): string {
  return [ctx.input, ...ctx.rest].filter((x): x is string => typeof x === "string" && x.length > 0).join(" ").trim();
}

export const noteVerb: VerbSpec = {
  name: "note",
  group: "state",
  summary: "Add a human observation/finding to the case, optionally anchored to evidence.",
  description:
    "Creates a primary human-authored `note` record. Notes are searchable by `ask`, included in " +
    "`brief`, visible in `case records`, and can cite media via `--ref <record-id|capture-id|path|url>` " +
    "plus `--at <seconds|start-end|timecode>`. Use `--tag` for comma-separated labels and " +
    "`--confidence` for the analyst's confidence marker.",
  args: [
    { name: "text", summary: "Observation/finding text", required: true },
  ],
  flags: [
    { name: "ref", summary: "Evidence record id, capture id, media path, or URL to anchor this note", type: "string" },
    { name: "at", summary: "Anchor time: seconds, hh:mm:ss, or start-end span", type: "string" },
    { name: "tag", summary: "Comma-separated labels (e.g. vehicle,contradiction)", type: "string" },
    { name: "confidence", summary: "Analyst confidence marker (e.g. low|medium|high)", type: "string" },
    { name: "title", summary: "Short note title", type: "string" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "note",
  providerKey: "note",
  run: async (ctx) => {
    const text = noteText(ctx);
    if (!text) return [err("note requires observation text")];

    for (const f of ["ref", "at", "tag", "confidence", "title"] as const) {
      if (ctx.opts[f] != null && !String(ctx.opts[f]).trim()) {
        return [err(`--${f} requires a value`)];
      }
    }

    let media: MediaRef | undefined;
    let relatedRecord: string | undefined;
    let evidenceRef: string | undefined;

    if (ctx.opts.ref != null) {
      const rawRef = String(ctx.opts.ref).trim();
      const rec = ctx.case.recordById(rawRef);
      if (rec) {
        relatedRecord = rec.id;
        evidenceRef = rec.media?.ref ?? rawRef;
        // Link to the same media, but do NOT inherit the source record's
        // timestamp. A human note is only time-anchored when the analyst says so
        // with --at.
        if (rec.media?.ref) media = { ref: rec.media.ref };
      } else {
        const resolved = resolveMediaRef(ctx.case, rawRef, ctx.home);
        if (resolved.error) return [err(`--ref ${resolved.error}`)];
        if (resolved.recordId == null && !resolved.archive) {
          const isUrl = /^https?:\/\//i.test(rawRef);
          // absolute path, or a case-relative path CONTAINED in the case dir (a
          // `../` escape outside the case store is rejected — no arbitrary files).
          const isExistingPath = !isUrl && refPathExists(ctx.case.dir, rawRef, ctx.home);
          if (!isUrl && !isExistingPath) {
            if (/^rec_/i.test(rawRef)) return [err(`--ref record not found in this case: ${rawRef}`)];
            if (/^cap_/i.test(rawRef)) return [err(`--ref capture id not found in this case: ${rawRef}`)];
            return [err(`--ref does not resolve to a record, capture id, existing path, or URL: ${rawRef}`)];
          }
        }
        relatedRecord = resolved.recordId;
        // keep the archive:<bucket>/<item> trace as the cited ref; media.ref
        // carries the resolved playable path.
        evidenceRef = resolved.archive ? rawRef : resolved.ref;
        media = { ref: resolved.ref };
      }
    }

    if (ctx.opts.at != null) {
      if (!ctx.opts.ref) return [err("--at requires --ref so the timestamp has evidence to anchor")];
      if (!media?.ref) return [err("--at requires --ref to resolve to media (the referenced record has no media.ref)")];
      const at = parseAtSpan(String(ctx.opts.at));
      if (at == null) return [err(`invalid --at '${ctx.opts.at}' (expected seconds, hh:mm:ss, or start-end)`)];
      media = { ref: media.ref, at };
    }

    const tags = splitTags(ctx.opts.tag);
    const payload: Record<string, unknown> = { text };
    if (ctx.opts.title) payload.title = String(ctx.opts.title);
    if (tags) payload.tags = tags;
    if (ctx.opts.confidence) payload.confidence = String(ctx.opts.confidence);
    if (evidenceRef) payload.ref = evidenceRef;
    if (relatedRecord) payload.related_record = relatedRecord;

    return [
      makeRecord({
        verb: "note",
        format: "md",
        payload,
        media,
        meta: { provider: "human", case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};
