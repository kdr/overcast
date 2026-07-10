// reconstruct multi-output fan-out — the reconstruct sibling of enhance-fanout
// (same wire contract: a bound provider emits ONE record whose payload.outputs[]
// carries the artifacts; the verb expands it into [parent, ...children]). Kept
// separate from fanOutEnhance because the semantics differ in two load-bearing
// ways: the child summaries speak camera language (azimuth/elevation/zoom, mesh,
// depth), and EVERY record — parent and child — must carry the speculative
// caveat. reconstruct outputs are synthesized pixels, not recovered ones; the
// caveat is stamped here (not left to provider goodwill) so no reconstruction
// record can exist without it.

import { makeRecord, type OvercastRecord, type MediaRef } from "../record.js";

/** The non-negotiable forensic banner every reconstruct record carries. A
 *  provider may override with more specific wording, never remove. */
export const RECONSTRUCT_CAVEAT =
  "generative reconstruction — synthesized by a model, speculative, NOT photographic evidence";

/** One artifact a reconstruct provider emitted (loose — providers add their own
 *  fields; we rely on `kind` + `ref` only). */
interface ReconstructOutput {
  kind: string; // "view" | "mesh" | "depth" | ...
  ref: string;
  [k: string]: unknown;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** point-in-time anchor only when it matches the MediaRef contract. */
function validAt(at: unknown): number | [number, number] | undefined {
  if (typeof at === "number") return at;
  if (Array.isArray(at) && at.length === 2 && at.every((n) => typeof n === "number")) {
    return [at[0], at[1]];
  }
  return undefined;
}

function outputSummary(op: string, item: ReconstructOutput, sourceName: string): string {
  if (item.kind === "view") {
    const az = num(item.rotate) ?? num(item.azimuth);
    const el = num(item.elevate);
    const zm = num(item.zoom);
    const cam = [
      az !== undefined ? `az ${az}°` : "",
      el !== undefined ? `el ${el}°` : "",
      zm !== undefined ? `zoom ${zm}` : "",
    ].filter(Boolean).join(", ");
    return `speculative camera view of ${sourceName}${cam ? ` (${cam})` : ""} — synthesized, not evidence`;
  }
  if (item.kind === "mesh") {
    const fmt = typeof item.format === "string" ? item.format : "glb";
    return `speculative 3D reconstruction (${fmt}) of ${sourceName} — synthesized, not evidence`;
  }
  if (item.kind === "depth") {
    return `estimated depth map of ${sourceName} — model-estimated, not measured`;
  }
  if (item.kind === "sheet") {
    return `sweep contact sheet of ${sourceName} (every synthesized camera stop) — synthesized, not evidence`;
  }
  if (item.kind === "turntable") {
    const frames = num(item.frames);
    return `turntable sweep of ${sourceName}${frames ? ` (${frames} synthesized stops)` : ""} — synthesized, not evidence`;
  }
  return `${op} output (${item.kind}) from ${sourceName} — synthesized, not evidence`;
}

/** A well-formed multi-output envelope: a ready reconstruct record whose payload
 *  carries an `outputs[]` array of `{kind, ref, ...}` items (strict, so a plain
 *  record is never mistaken for a fan-out envelope — enhance-fanout precedent). */
export function hasReconstructFanOut(rec: OvercastRecord): boolean {
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

const CASE_UNSET = "";

/**
 * Expand a multi-output reconstruct envelope into `[parent, ...children]`. Each
 * child is a first-class `reconstruct` record: `media.ref` = the artifact,
 * payload carries a compact summary + provenance back to the parent, and
 * `meta.provider` is inherited (enhance-fanout precedent). Additionally stamps
 * `payload.caveat` on the parent AND every child when the provider didn't —
 * reconstruction records are quarantined from evidence (OPERATIONAL_VERBS), but
 * the caveat travels with the record wherever it's read or exported.
 */
export function fanOutReconstruct(parent: OvercastRecord, opts: { caseDir?: string } = {}): OvercastRecord[] {
  // stamp the caveat on any object-payload parent (even a non-fanout single
  // record) so the forensic banner never depends on the provider.
  if (typeof parent.payload === "object" && parent.payload != null) {
    const pp = parent.payload as Record<string, unknown>;
    if (typeof pp.caveat !== "string" || !pp.caveat) pp.caveat = RECONSTRUCT_CAVEAT;
  }
  if (!hasReconstructFanOut(parent)) return [parent];
  const payload = parent.payload as Record<string, unknown>;
  const op = typeof payload.op === "string" ? payload.op : "reconstruct";
  const outputs = payload.outputs as ReconstructOutput[];
  const caveat = typeof payload.caveat === "string" ? payload.caveat : RECONSTRUCT_CAVEAT;
  const sourceMedia = parent.media?.ref;
  const sourceName = sourceMedia ? sourceMedia.split("/").pop() || sourceMedia : "input";
  const provider = parent.meta?.provider;
  const caseDir = opts.caseDir ?? (typeof parent.meta?.case === "string" ? parent.meta.case : CASE_UNSET);

  const children = outputs.map((item) => {
    const { ref, at, ...rest } = item;
    const media: MediaRef = { ref };
    const anchor = validAt(at);
    if (anchor !== undefined) media.at = anchor;
    return makeRecord({
      verb: "reconstruct",
      format: "json",
      payload: {
        summary: outputSummary(op, item, sourceName),
        op,
        source_record: parent.id,
        source_media: sourceMedia,
        ...rest,
        caveat: typeof rest.caveat === "string" && rest.caveat ? rest.caveat : caveat,
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
