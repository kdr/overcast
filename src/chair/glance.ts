// Build the read-only case glance served at `GET /api/case` — standing scope
// (targets/sources), open findings, and the newest record per verb. Reuses the
// case store readers; deliberately does NOT probe memory providers the way
// `case status` does (the glance must stay cheap — it's polled from a phone).

import { basename } from "node:path";
import type { Case } from "../case.js";
import { findingStatusMap, type OvercastRecord } from "../record.js";
import { isRootFindingRecord } from "../verbs/finding.js";
import { listTargets } from "../state/target.js";
import { listSources } from "../state/source.js";
import type { CaseGlance, GlanceFinding, GlanceRecord } from "./wire.js";

const SUMMARY_KEYS = ["text", "summary", "answer", "description", "title", "content", "transcript", "query", "op"];
const SUMMARY_MAX = 160;

function clip(s: string, max = SUMMARY_MAX): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** A one-line, phone-width summary of a record payload. */
export function summarizeRecordPayload(rec: OvercastRecord): string {
  if (typeof rec.payload === "string") return clip(rec.payload);
  if (rec.payload && typeof rec.payload === "object") {
    for (const key of SUMMARY_KEYS) {
      const v = (rec.payload as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) return clip(v);
    }
    const keys = Object.keys(rec.payload);
    if (keys.length) return clip(`{${keys.slice(0, 6).join(", ")}}`);
  }
  return "(empty)";
}

function recordTime(rec: OvercastRecord): string | undefined {
  return typeof rec.meta?.time === "string" ? rec.meta.time : undefined;
}

export function buildCaseGlance(c: Case, limit = 8): CaseGlance {
  const records = c.records();
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.verb] = (counts[r.verb] ?? 0) + 1;

  // open findings: root finding records whose latest review status is "open"
  const status = findingStatusMap(records);
  const openFindings: GlanceFinding[] = records
    .filter(isRootFindingRecord)
    .filter((r) => (status.get(r.id) ?? "open") === "open")
    .map((r) => {
      const p = r.payload as Record<string, unknown>;
      const finding: GlanceFinding = {
        id: r.id,
        text: clip(String(p.text ?? "")),
        status: "open",
      };
      if (typeof p.target === "string") finding.target = p.target;
      const time = recordTime(r);
      if (time) finding.time = time;
      return finding;
    })
    .slice(-limit)
    .reverse();

  // newest record per verb, newest first
  const newestPerVerb = new Map<string, OvercastRecord>();
  for (const r of records) {
    const prev = newestPerVerb.get(r.verb);
    if (!prev || (recordTime(r) ?? "") >= (recordTime(prev) ?? "")) newestPerVerb.set(r.verb, r);
  }
  const latest: GlanceRecord[] = [...newestPerVerb.values()]
    .sort((a, b) => (recordTime(b) ?? "").localeCompare(recordTime(a) ?? ""))
    .slice(0, limit)
    .map((r) => {
      const entry: GlanceRecord = { verb: r.verb, id: r.id, summary: summarizeRecordPayload(r) };
      const time = recordTime(r);
      if (time) entry.time = time;
      return entry;
    });

  return {
    caseName: c.exists() ? c.info().name : basename(c.dir),
    dir: c.dir,
    records: records.length,
    counts,
    targets: listTargets(c).map((t) => ({ id: t.id, kind: t.kind, value: clip(t.value, 120) })),
    sources: listSources(c).map((s) => ({ id: s.id, type: s.type, ref: clip(s.ref, 120), enabled: s.enabled })),
    openFindings,
    latest,
  };
}
