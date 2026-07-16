// PURE model-facing summarization of overcast records for the chat / LM-tool
// surface. NO vscode imports — exercised by node --test (see
// ../../test/summarize.test.ts).
//
// The @overcast participant and the overcast_* language-model tools share this:
// they run a verb through the bridge, then hand the model a compact, capped JSON
// view of the resulting records (the loose record contract) instead of a raw
// payload — which can carry face boxes / embeddings / fingerprint hashes /
// base64 media that blow the model's context. Rule: keep id/verb/state/error
// always, drop bulk/binary, cap each field and the whole JSON.
import { recordForVerb, type CliFailure } from "../lib/cliOutput.ts";
import type { CaseStatusPayload, OvercastRecord } from "../types.ts";

/** Max characters kept per payload string field. */
export const MAX_FIELD_CHARS = 400;
/** Max characters of the whole JSON string handed to the model. */
export const MAX_JSON_CHARS = 4000;
/** How many array elements a summarized array keeps before eliding the tail. */
const MAX_ARRAY = 20;
/** How deep the payload walk goes before it stops descending. */
const MAX_DEPTH = 6;

// Payload keys whose values are bulk/binary artifacts (detection boxes, vectors,
// frames, homographies, fingerprint hashes, thumbnails). They belong in the
// record for exact reads / crop, never in the model view.
const BULK_KEY_RE =
  /^(?:.*_)?(?:box|boxes|bbox|bboxes|embedding|embeddings|vector|vectors|frames|homography|homographies|descriptors?|hashes|fingerprints?|landmarks|masks|thumbnails?)$/i;

function looksBinary(s: string): boolean {
  if (/^data:[^,]*;base64,/i.test(s)) return true;
  // a long unbroken token of base64/hex-ish chars — an inlined blob, not prose.
  return s.length > 256 && !/\s/.test(s) && /^[A-Za-z0-9+/=_-]+$/.test(s);
}

function capString(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap - 1) + "…" : s;
}

// Recursively compact a payload value: cap strings, drop binary blobs, drop
// number arrays (vectors/curves) and bulk-keyed fields, bound array length and
// object depth. `undefined` = drop (JSON.stringify omits it in objects; arrays
// filter it explicitly).
function compact(value: unknown, depth: number, cap: number): unknown {
  if (typeof value === "string") return looksBinary(value) ? undefined : capString(value, cap);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((x) => typeof x === "number")) return undefined;
    if (depth >= MAX_DEPTH) return undefined;
    const out = value
      .slice(0, MAX_ARRAY)
      .map((x) => compact(x, depth + 1, cap))
      .filter((x) => x !== undefined);
    if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY} more)`);
    return out;
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (BULK_KEY_RE.test(k)) continue;
      const c = compact(v, depth + 1, cap);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

export interface SummarizeOptions {
  /** per-field character cap (default MAX_FIELD_CHARS). `ask` raises it so the
   *  answer text isn't chopped at 400 while the total JSON stays capped. */
  fieldCap?: number;
}

/** Compact, model-facing view of a single record — id/verb/state (+error/media)
 *  always kept, payload compacted. */
export function summarizeRecord(
  rec: OvercastRecord,
  opts: SummarizeOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: rec.id, verb: rec.verb, state: rec.state ?? "ready" };
  if (rec.error) out.error = rec.error;
  if (rec.media?.ref) {
    out.media = rec.media.at !== undefined ? { ref: rec.media.ref, at: rec.media.at } : { ref: rec.media.ref };
  }
  const payload = compact(rec.payload, 0, opts.fieldCap ?? MAX_FIELD_CHARS);
  if (payload !== undefined) out.payload = payload;
  return out;
}

/** JSON string for the model, capped to MAX_JSON_CHARS (last-resort safety net —
 *  per-field caps + bulk drops should keep records well under the budget). */
export function toModelJson(value: unknown): string {
  const s = JSON.stringify(value, null, 2);
  return s.length > MAX_JSON_CHARS ? s.slice(0, MAX_JSON_CHARS) + "\n…(truncated)" : s;
}

/** Summarize a verb's primary record (verb-matched, else the first) as capped JSON. */
export function summarizeVerbResult(
  records: OvercastRecord[],
  verb: string,
  opts?: SummarizeOptions,
): string {
  const rec = recordForVerb(records, verb) ?? records[0];
  if (!rec) return toModelJson({ verb, records: 0, note: "no record was produced" });
  return toModelJson(summarizeRecord(rec, opts));
}

export interface ScanHitSummary {
  id?: string;
  title?: string;
  url?: string;
  snippet?: string;
  source?: string;
}

/** Pure scan.hit extractor for the model/chat surface (skips pull-progress +
 *  error rows). Mirrors searchSource.hitsFromRecords but yields the model shape
 *  (id/title/url/snippet/source) the tool + participant hand back. */
export function scanHits(records: OvercastRecord[]): ScanHitSummary[] {
  const hits: ScanHitSummary[] = [];
  for (const r of records) {
    if (r.verb !== "scan" || r.state === "error") continue;
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (p.op === "pull_progress") continue;
    const str = (k: string): string | undefined =>
      typeof p[k] === "string" && (p[k] as string).length > 0
        ? capString(p[k] as string, MAX_FIELD_CHARS)
        : undefined;
    hits.push({ id: r.id, title: str("title"), url: str("url"), snippet: str("snippet"), source: str("source") });
  }
  return hits;
}

/** Humanize an age in seconds → "3h ago" / "just now" / "never". */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "never";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export interface CaseSummary {
  case: string;
  records: number;
  headline?: string;
  threads: { line: string; status: string; stage: string; evidence: number; findings: number }[];
  suggestedLeads: number;
  sources: { source: string; type: string; enabled: boolean; lastScan: string; hits: number; gap?: boolean }[];
}

/** Compact, model-facing case summary from `case status --json`. */
export function caseSummary(status: CaseStatusPayload): CaseSummary {
  const threads = (status.threads ?? []).map((t) => ({
    line: t.question || t.value,
    status: t.status,
    stage: t.stage,
    evidence: Object.values(t.evidence ?? {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0),
    findings: t.findingIds?.length ?? 0,
  }));
  const sources = (status.coverage ?? []).map((c) => ({
    source: c.spec,
    type: c.type,
    enabled: c.enabled,
    lastScan: formatAge(c.lastScanAgeSeconds),
    hits: c.hits,
    ...(c.gap ? { gap: true } : {}),
  }));
  return {
    case: status.info?.name || status.dir || "(unnamed)",
    records: status.store?.records ?? 0,
    ...(status.mission?.headline ? { headline: status.mission.headline } : {}),
    threads,
    suggestedLeads: (status.triage ?? []).length,
    sources,
  };
}

const TEXT_FIELDS = ["text", "summary", "content", "answer", "report", "transcript", "caption", "ocr"];

/** A record's primary human-readable text ("" when none) — the answer for `ask`,
 *  the observation for `note`, etc. Local mirror of the root primaryText so the
 *  extension stays a thin client (no runtime import from the overcast lib). */
export function answerText(rec: OvercastRecord): string {
  if (typeof rec.payload === "string") return rec.payload;
  const p = rec.payload as Record<string, unknown>;
  for (const k of TEXT_FIELDS) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/** A short one-line blurb for a produced record (capture/sense/note) — its text
 *  if any, else its media ref, else its payload keys. */
export function recordBlurb(rec: OvercastRecord, max = 500): string {
  const t = answerText(rec).replace(/\s+/g, " ").trim();
  if (t) return t.length > max ? t.slice(0, max - 1) + "…" : t;
  if (rec.media?.ref) return `media: ${rec.media.ref}`;
  if (rec.payload && typeof rec.payload === "object") {
    const keys = Object.keys(rec.payload as Record<string, unknown>);
    return keys.length ? `payload: ${keys.slice(0, 12).join(", ")}` : "(empty)";
  }
  return "(no summary)";
}

/** Record ids cited by an `ask` answer (payload.citations[].recordId). */
export function citedRecordIds(rec: OvercastRecord): string[] {
  const ids = new Set<string>();
  const citations =
    rec.payload && typeof rec.payload === "object"
      ? (rec.payload as Record<string, unknown>).citations
      : undefined;
  if (Array.isArray(citations)) {
    for (const c of citations) {
      const id = c && typeof c === "object" ? (c as Record<string, unknown>).recordId : undefined;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return [...ids];
}

/** Model/user-facing failure line. needs_credentials keeps the CLI's message
 *  verbatim so the model can relay exactly what to configure. */
export function failureMessage(failure: CliFailure): string {
  if (failure.kind === "needs_credentials") {
    return `This overcast operation needs credentials or setup. ${failure.message} — run \`overcast setup\` (or \`overcast doctor --sources\`) to configure it.`;
  }
  if (failure.kind === "usage") return `overcast rejected the request (usage): ${failure.message}`;
  return `overcast failed: ${failure.message}`;
}
