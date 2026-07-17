// Pure rollup for the Sources view's "Analyzed media" folder: distinct media
// refs with ≥1 analysis record, from the compact `case records` rows. No vscode
// import — testable under plain `node --test`.
import type { RecordRow } from "../types.ts";

// Client-side "this verb analyzed its media.ref" set (superset of the pulse
// funnel's SENSE_VERBS — exif/voice/verify count as analysis here).
// Keep in lockstep with SENSE_VERBS in the CLI's src/signals/pulse.ts — the
// coverage funnel's `sensed` flag and this rollup must agree on what counts
// as analyzed, or a source row and the Analyzed folder contradict each other.
const ANALYZE_VERBS = new Set([
  "watch", "listen", "see", "face", "image", "similar", "cluster",
  "audio", "voice", "crop", "enhance", "exif", "verify",
]);

/** Distinct media refs with ≥1 analysis record: ref → verbs run + newest record.
 *  Input rows are oldest-first (the CLI's order); output is newest-first. */
export function analyzedMedia(
  records: RecordRow[],
): Array<{ ref: string; verbs: string[]; recordId: string }> {
  const byRef = new Map<string, { verbs: Set<string>; recordId: string }>();
  for (const r of records) {
    if (!r.media || !ANALYZE_VERBS.has(r.verb) || r.state === "error") continue;
    const entry = byRef.get(r.media);
    if (entry) {
      entry.verbs.add(r.verb);
      entry.recordId = r.id; // rows are oldest-first — last wins = newest
    } else {
      byRef.set(r.media, { verbs: new Set([r.verb]), recordId: r.id });
    }
  }
  return [...byRef.entries()]
    .map(([ref, v]) => ({ ref, verbs: [...v.verbs].sort(), recordId: v.recordId }))
    .reverse(); // newest-analyzed first
}
