// monitor's seen-set, persisted to .overcast/seen.json. Keys are stable item
// identities (url, else a content composite) so a monitor loop only acts on
// genuinely new items across runs.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "../fs-atomic.js";
import type { Case } from "../case.js";
import type { OvercastRecord } from "../record.js";

export interface SeenStore {
  keys: string[];
}

export function loadSeen(c: Case): Set<string> {
  if (!existsSync(c.seenFile)) return new Set();
  try {
    const s = JSON.parse(readFileSync(c.seenFile, "utf8")) as SeenStore;
    return new Set(s.keys ?? []);
  } catch {
    return new Set();
  }
}

export function saveSeen(c: Case, keys: Set<string>): void {
  writeFileAtomic(c.seenFile, JSON.stringify({ keys: [...keys] }, null, 2) + "\n");
}

// Consecutive-failure counts for EPHEMERAL monitor hits (a webcam's current
// still), persisted next to seen.json. Ephemeral hits deliberately skip `seen`
// so they re-capture every pass, but that means a permanently broken hit would
// re-run the pull pipeline forever. This counter lets monitor survive transient
// failures yet give up (mark seen) after too many consecutive ones. The map only
// holds CURRENTLY-failing hits — cleared on success or on give-up — so it stays
// small; it never accumulates like a per-poll key would.
const ephemeralFailsFile = (c: Case): string => join(c.seenFile, "..", "ephemeral-fails.json");

export function loadEphemeralFails(c: Case): Map<string, number> {
  const f = ephemeralFailsFile(c);
  if (!existsSync(f)) return new Map();
  try {
    const o = JSON.parse(readFileSync(f, "utf8")) as Record<string, number>;
    return new Map(Object.entries(o).filter(([, v]) => typeof v === "number"));
  } catch {
    return new Map();
  }
}

export function saveEphemeralFails(c: Case, fails: Map<string, number>): void {
  writeFileAtomic(ephemeralFailsFile(c), JSON.stringify(Object.fromEntries(fails), null, 2) + "\n");
}

// Field separator for composite keys: ASCII unit separator, which won't appear
// in scraped title/url/snippet text, so distinct fields can't blur together.
const SEP = "\u001f";

/**
 * Stable identity key for a scan.hit record — stable across runs and unique per
 * logical item.
 *
 * A URL (or media ref) is the strongest identity. Without one we build a
 * composite from distinguishing fields so two distinct hits that merely share a
 * title don't collide. With nothing identifying at all we hash the payload
 * (content-addressed): identical content dedups, different content does not —
 * never `rec.id`, which is random per run and would defeat dedup entirely.
 */
export function hitKey(rec: OvercastRecord): string {
  const p = (typeof rec.payload === "object" ? rec.payload : {}) as Record<string, unknown>;
  // Prefer payload.url, THEN media.ref: the url is the item's stable logical
  // identity, while media.ref can be a run-varying materialized artifact (e.g.
  // a lens match thumbnail that decodes on one pass and falls back to the page
  // url on another — keying on it would reprocess the same match). Fetch still
  // prefers media.ref (hitFetchRef); every other built-in source sets both to
  // the same value, so their dedup keys are unchanged.
  const url = (p.url as string) || (rec.media?.ref as string) || "";
  if (url) return `url:${url}`;

  const fields = [p.source_id, p.source, p.title, p.author, p.published, p.snippet];
  if (fields.some((v) => v != null && String(v) !== "")) {
    return "c:" + fields.map((v) => (v == null ? "" : String(v))).join(SEP);
  }

  return "h:" + createHash("sha1").update(JSON.stringify(p)).digest("hex");
}
