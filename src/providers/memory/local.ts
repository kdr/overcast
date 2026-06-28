// Local memory provider (default, always-on, B-first). Backs memory with the
// .overcast/records/*.jsonl store + a lightweight keyword index over each
// record's payload text. No external deps; per-case.

import type { Case } from "../../case.js";
import { isMetaRecord, type OvercastRecord } from "../../record.js";
import type { MemoryProvider, Passage, QueryOpts, Answer } from "./types.js";
import { indexableDocument } from "./fields.js";

/** Flatten a record's payload into searchable text. */
export function recordText(rec: OvercastRecord): string {
  const doc = indexableDocument(rec);
  const parts: string[] = [rec.verb, doc?.text ?? ""];
  if (rec.media?.ref) parts.push(rec.media.ref);
  return parts.join(" \n");
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_@#]+/i)
    .filter((t) => t.length > 1);
}

/** TF-style keyword score of a query against a document's tokens. */
function score(queryTokens: string[], docTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of docTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let s = 0;
  for (const qt of queryTokens) {
    const c = counts.get(qt) ?? 0;
    if (c > 0) s += 1 + Math.log(c); // diminishing returns per term
  }
  return s;
}

/** A short snippet of `text` around the first matching query token. */
function snippet(text: string, queryTokens: string[], width = 200): string {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const qt of queryTokens) {
    const i = lower.indexOf(qt);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return text.slice(0, width).replace(/\s+/g, " ").trim();
  const start = Math.max(0, idx - width / 4);
  return text.slice(start, start + width).replace(/\s+/g, " ").trim();
}

export class LocalMemoryProvider implements MemoryProvider {
  readonly id = "local-grep";
  readonly backend = "local-grep";
  readonly aliases = ["local"];
  constructor(private readonly case_: Case) {}

  // records are already persisted by the case store; write is a no-op for the
  // local provider (the JSONL store IS the index source). Kept for the interface.
  write(): void {
    /* records persisted by Case.writeRecord; nothing extra to index yet */
  }

  query(q: string, opts: QueryOpts = {}): Passage[] {
    const qTokens = tokenize(q);
    let records = this.case_.records();
    if (opts.verbs && opts.verbs.length) {
      const set = new Set(opts.verbs);
      records = records.filter((r) => set.has(r.verb));
    } else {
      // Don't retrieve read/meta outputs (ask/brief/case) as evidence — they
      // restate or duplicate primary records. Opt in explicitly via --verb.
      records = records.filter((r) => !isMetaRecord(r));
    }
    if (opts.since) {
      const cutoff = parseSince(opts.since);
      // an unparseable cutoff must not silently disable the time filter
      if (cutoff == null) {
        throw new Error(`invalid since value: ${opts.since}`);
      }
      records = records.filter((r) => {
        const t = r.meta?.time ? Date.parse(String(r.meta.time)) : NaN;
        return Number.isNaN(t) || t >= cutoff;
      });
    }
    const scored: Passage[] = [];
    for (const rec of records) {
      const doc = indexableDocument(rec);
      if (!doc) continue;
      for (const field of doc.fields) {
        const text = `${rec.verb} ${field.path}\n${field.text}\n${rec.media?.ref ?? ""}`;
        const s = score(qTokens, tokenize(text));
        if (s <= 0) continue;
        scored.push({
          recordId: rec.id,
          at: rec.media?.at,
          text: snippet(text, qTokens),
          score: s,
          verb: rec.verb,
          field: field.path,
          provider: this.id,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const deduped: Passage[] = [];
    const seen = new Set<string>();
    for (const p of scored) {
      const key = `${p.recordId}:${p.field ?? ""}:${p.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(p);
      if (deduped.length >= (opts.limit ?? 8)) break;
    }
    return deduped;
  }

  /** Extractive grounded answer: synthesize from the top passages + cite them. */
  answer(q: string, opts: QueryOpts = {}): Answer {
    const passages = this.query(q, opts);
    if (passages.length === 0) {
      return { text: `No records in this case match "${q}".`, citations: [] };
    }
    const lines = [`Found ${passages.length} relevant record(s) for "${q}":`, ""];
    for (const p of passages) {
      const at = p.at != null ? ` @${Array.isArray(p.at) ? p.at.join("-") : p.at}s` : "";
      lines.push(`- [${p.recordId}${at}] (${p.verb}) ${p.text}`);
    }
    return {
      text: lines.join("\n"),
      citations: passages.map((p) => ({ recordId: p.recordId, at: p.at, verb: p.verb })),
    };
  }

  status() {
    const records = this.case_.records().filter((r) => !isMetaRecord(r));
    const docs = records.map(indexableDocument).filter(Boolean).length;
    return {
      provider: this.id,
      backend: this.backend,
      state: "ready",
      records: records.length,
      documents: docs,
      path: this.case_.recordsDir,
      updated: new Date().toISOString(),
    };
  }

  rebuild() {
    return this.status();
  }
}

/** Parse a relative ("30m", "24h", "7d", "2w") or absolute date into an epoch ms
 *  cutoff. Units match monitor's --every: m=minutes, h=hours, d=days, w=weeks. */
export function parseSince(since: string): number | null {
  const rel = since.match(/^(\d+)([mhdw])$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === "m" ? 60e3 : unit === "h" ? 3600e3 : unit === "d" ? 86400e3 : 7 * 86400e3;
    // anchor on a fixed reference would break determinism; use process clock.
    return Date.parse(new Date().toISOString()) - n * ms;
  }
  const abs = Date.parse(since);
  return Number.isNaN(abs) ? null : abs;
}
