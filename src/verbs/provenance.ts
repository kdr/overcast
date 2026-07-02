// Source provenance: carry where a captured/sensed artifact CAME FROM onto its
// record payload, so a match/finding traces back to the originating post — the
// tweet/video URL, author, text, and date — without re-plumbing every verb
// signature. Fields are prefixed `source_*` to sit beside the loose record's own
// fields (CLAUDE.md invariant #3: the record stays loose).

import type { Case } from "../case.js";
import type { OvercastRecord } from "../record.js";

/** Lift provenance from a scan hit (a `scan` record) — the originating post. */
export function scanHitProvenance(hit: OvercastRecord | undefined): Record<string, unknown> {
  if (!hit || hit.verb !== "scan" || typeof hit.payload !== "object" || hit.payload == null) return {};
  const p = hit.payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof p.url === "string" && p.url) out.source_url = p.url;
  if (typeof p.author === "string" && p.author) out.source_author = p.author;
  // the post text is the judgment signal for triage — keep it on downstream records
  const text = [p.snippet, p.title].find((v) => typeof v === "string" && v.trim());
  if (typeof text === "string") out.source_text = text;
  if (typeof p.published === "string" && p.published) out.source_published = p.published;
  if (typeof p.views === "number") out.source_views = p.views;
  if (typeof p.source === "string" && p.source) out.source_platform = p.source;
  if (hit.id) out.source_record = hit.id;
  return out;
}

/** Merge provenance onto a record's payload without clobbering existing keys. */
export function stampProvenance(rec: OvercastRecord, prov: Record<string, unknown>): OvercastRecord {
  if (!Object.keys(prov).length || typeof rec.payload !== "object" || rec.payload == null) return rec;
  const p = rec.payload as Record<string, unknown>;
  for (const [k, v] of Object.entries(prov)) if (!(k in p)) p[k] = v;
  return rec;
}

const PROV_KEYS = ["source_url", "source_author", "source_text", "source_published", "source_views", "source_platform"] as const;

/** Provenance to inherit for a sensed artifact whose input file is a captured
 *  item: find the `capture` record that materialized `inputPath` and return the
 *  post it came from, so `image match` / `face` / `listen` on a captured video
 *  trace back to the tweet. */
export function provenanceFromCapture(c: Case, inputPath: string | undefined): Record<string, unknown> {
  if (!inputPath) return {};
  for (const rec of c.records()) {
    if (rec.verb !== "capture" || rec.state === "error") continue;
    const p = typeof rec.payload === "object" && rec.payload != null ? (rec.payload as Record<string, unknown>) : {};
    const path = typeof p.path === "string" ? p.path : rec.media?.ref;
    if (path !== inputPath) continue;
    const prov: Record<string, unknown> = {};
    for (const k of PROV_KEYS) if (p[k] != null) prov[k] = p[k];
    if (typeof p.capture_id === "string") prov.source_capture = p.capture_id;
    // fall back to the capture record itself if it carried no upstream scan
    prov.source_record = (typeof p.source_record === "string" && p.source_record) || rec.id;
    return prov;
  }
  return {};
}
