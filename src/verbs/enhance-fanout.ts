// enhance multi-output fan-out. A bound enhance provider that produces MANY
// artifacts (per-speaker tracks, per-instance masks/cutouts) still emits ONE
// record on stdout (the exec wire contract), carrying the artifacts in
// `payload.outputs[]`. The exec boundary (providers/run.ts) preserves that
// payload verbatim; here the enhance verb handler expands the single envelope
// into `[parent, ...children]` — the parent is the audit summary (crop/scan
// precedent), the children are the chainable evidence records (one per artifact,
// each with its own media.ref).
//
// Single-output providers (the shipped hf/fal/elevenlabs enhance scripts, any
// third-party binding) carry no `outputs[]` array — `hasFanOut` returns false
// and they pass through unchanged.

import { makeRecord, type OvercastRecord, type MediaRef } from "../record.js";

/** One artifact an enhance provider emitted (loose — providers add their own
 *  fields; we only rely on `kind` + `ref`). */
interface EnhanceOutput {
  kind: string; // "track" | "cutout" | "mask" | ...
  ref: string;
  [k: string]: unknown;
}

/** A well-formed multi-output envelope: a ready enhance record whose payload
 *  carries an `outputs[]` array of `{kind, ref, ...}` items. The guard is strict
 *  so a normal single-output record (no outputs array) is never mistaken for a
 *  fan-out envelope. */
export function hasFanOut(rec: OvercastRecord): boolean {
  if (rec.state && rec.state !== "ready") return false;
  if (typeof rec.payload !== "object" || rec.payload == null) return false;
  const outputs = (rec.payload as Record<string, unknown>).outputs;
  if (!Array.isArray(outputs) || outputs.length === 0) return false;
  return outputs.every(
    (o) =>
      o != null &&
      typeof o === "object" &&
      typeof (o as Record<string, unknown>).kind === "string" &&
      typeof (o as Record<string, unknown>).ref === "string" &&
      ((o as Record<string, unknown>).ref as string).length > 0,
  );
}

/** point-in-time anchor only when it matches the MediaRef contract. */
function validAt(at: unknown): number | [number, number] | undefined {
  if (typeof at === "number") return at;
  if (Array.isArray(at) && at.length === 2 && at.every((n) => typeof n === "number")) {
    return [at[0], at[1]];
  }
  return undefined;
}

function outputSummary(op: string, item: EnhanceOutput, sourceName: string): string {
  if (item.kind === "track") {
    const who = typeof item.speaker === "string" ? item.speaker : typeof item.label === "string" ? item.label : "voice";
    const secs = typeof item.speech_seconds === "number" ? ` (${item.speech_seconds.toFixed(1)}s speech)` : "";
    return `separated ${who} from ${sourceName}${secs}`;
  }
  if (item.kind === "cutout" || item.kind === "mask") {
    const label = typeof item.label === "string" && item.label ? `"${item.label}"` : "region";
    const score = typeof item.score === "number" ? ` (score ${item.score.toFixed(2)})` : "";
    const noun = item.kind === "mask" ? "mask of" : "segmented";
    return `${noun} ${label} from ${sourceName}${score}`;
  }
  return `${op} output (${item.kind}) from ${sourceName}`;
}

const CASE_UNSET = "";

/**
 * Expand a multi-output enhance envelope into `[parent, ...children]`. Each child
 * is a first-class `enhance` record: `media.ref` = the artifact, payload carries
 * a compact summary + provenance back to the parent (so it indexes as evidence
 * and chains into view/crop/listen), and `meta.provider` is inherited. The parent
 * keeps the envelope payload as the audit trail. Caller stamps case/provenance.
 */
export function fanOutEnhance(parent: OvercastRecord, opts: { caseDir?: string } = {}): OvercastRecord[] {
  if (!hasFanOut(parent)) return [parent];
  const payload = parent.payload as Record<string, unknown>;
  const op = typeof payload.op === "string" ? payload.op : "enhance";
  const outputs = payload.outputs as EnhanceOutput[];
  const sourceMedia = parent.media?.ref;
  const sourceName = sourceMedia ? sourceMedia.split("/").pop() || sourceMedia : "input";
  const provider = parent.meta?.provider;
  const caseDir = opts.caseDir ?? (typeof parent.meta?.case === "string" ? parent.meta.case : CASE_UNSET);

  const children = outputs.map((item) => {
    // everything the provider attached to the artifact rides on the child payload
    // (minus ref/at, which become media) so exact reads + crop interop work.
    const { ref, at, ...rest } = item;
    const media: MediaRef = { ref };
    const anchor = validAt(at);
    if (anchor !== undefined) media.at = anchor;
    return makeRecord({
      verb: "enhance",
      format: "json",
      payload: {
        summary: outputSummary(op, item, sourceName),
        op,
        source_record: parent.id,
        source_media: sourceMedia,
        ...rest,
      },
      media,
      meta: {
        ...(provider ? { provider } : {}),
        ...(caseDir ? { case: caseDir } : {}),
      },
      state: "ready",
    });
  });

  return [parent, ...children];
}
