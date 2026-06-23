// monitor's seen-set, persisted to .overcast/seen.json. Keys are stable item
// identities (url, else title) so a monitor loop only acts on genuinely new
// items across runs.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
  mkdirSync(join(c.seenFile, ".."), { recursive: true });
  writeFileSync(c.seenFile, JSON.stringify({ keys: [...keys] }, null, 2) + "\n", "utf8");
}

/** Stable identity key for a scan.hit record. */
export function hitKey(rec: OvercastRecord): string {
  const p = (typeof rec.payload === "object" ? rec.payload : {}) as Record<string, unknown>;
  return (
    (p.url as string) ||
    (rec.media?.ref as string) ||
    (p.title as string) ||
    rec.id
  );
}
