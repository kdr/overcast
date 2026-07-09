// Cloud-tier memory provider (A-spec, memory class): answers `ask --deep` over a
// case-linked Cloudglue **media-descriptions** collection at cloud scale, i.e.
// true cross-modal search over the case's actual video.
//
// Two hard constraints:
//   1. OPT-IN ONLY (CLAUDE.md invariant #2 BYO spirit). Uploading/querying a
//      Cloudglue collection costs money, so this provider is registered only when
//      the operator opted in (`setup.memory.cloudglue`) AND `ask --deep` is asked
//      for. Its `query()` returns [] so a plain `ask` never touches the cloud —
//      no silent spend. `write()` is a no-op (this provider only READS an existing
//      collection; auto-adding captured media is a separate cost-policy feature).
//   2. PUBLIC tinycloud verbs only (invariant #9). Every call goes through
//      `tcAsk` (src/providers/tinycloud/collection.ts) — the same public
//      collection-ask path that powers `ask --index` — never the Cloudglue SDK.
//      The envelope is mapped to the loose record there; we map that record to
//      Passages/Answer here.

import type { Case } from "../../case.js";
import { resolveCloudglue } from "../../profile.js";
import type { OvercastRecord } from "../../record.js";
import { tcAsk } from "../tinycloud/collection.js";
import type { Answer, Citation, MemoryIndexStatus, MemoryProvider, Passage, QueryOpts } from "./types.js";

export interface CloudglueMemoryConfig {
  /** the case's local mirror index id (== the remote collection id for a
   *  media-descriptions index) — surfaced in `status()` for diagnostics. */
  indexId: string;
  /** the remote tinycloud/Cloudglue collection id (col_…) queried via `tcAsk`. */
  collectionId: string;
  /** pinned tinycloud invocation base (a profile binding), else
   *  OVERCAST_TINYCLOUD_CMD / `tinycloud` — mirrors the `ask --index` path. */
  base?: string;
  /** env for the tinycloud exec (case media dir + system ffmpeg), like `ask --index`. */
  env?: NodeJS.ProcessEnv;
  /** abort propagation for a long cloud query. */
  signal?: AbortSignal;
}

function objOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function fin(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Best-effort per-moment snippet (probe returns per-moment text; plain ask
 *  citations may carry none — the caller falls back to the overall answer). */
function momentText(m: Record<string, unknown>): string {
  for (const k of ["text", "snippet", "description", "summary", "content", "answer"]) {
    const s = str(m[k]);
    if (s) return s;
  }
  return "";
}
/** A moment's media anchor: [start,end] when both present, else the single point. */
function momentAt(m: Record<string, unknown>): number | [number, number] | undefined {
  const start = fin(m.start ?? m.start_time ?? m.startTime ?? m.timestamp ?? m.time ?? m.at ?? m.offset);
  const end = fin(m.end ?? m.end_time ?? m.endTime);
  if (start != null && end != null) return [start, end];
  if (start != null) return start;
  return undefined;
}
/** The cited collection file/video id — synthesized as the Passage `recordId`
 *  (passages require one; there is no local record for a remote moment). */
function momentRef(m: Record<string, unknown>, fallback: string): string {
  for (const k of ["file", "file_id", "fileId", "video", "video_id", "videoId", "uri", "ref", "url", "id", "source"]) {
    const s = str(m[k]);
    if (s) return s;
  }
  return fallback;
}
function momentScore(m: Record<string, unknown>): number {
  return fin(m.score ?? m.similarity ?? m.relevance ?? m.confidence) ?? 1;
}

export class CloudglueMemoryProvider implements MemoryProvider {
  readonly id = "cloudglue";
  readonly backend = "cloudglue";
  readonly aliases = ["tinycloud"];

  /** Per-instance memo of the single PAID `tcAsk` call, keyed by the args that
   *  vary it (query + limit). The provider is created fresh in `resolveMemory`
   *  for each `ask` request, so this memo is correctly REQUEST-scoped. In one
   *  `fanOutAnswer` pass `deepsearch()` and `answer()` run for the SAME query;
   *  caching the Promise coalesces them into ONE cloud call (no double billing)
   *  even though the two calls are sequential — see `run()`. */
  private readonly runs = new Map<string, Promise<OvercastRecord>>();

  constructor(private readonly case_: Case, private readonly ref: CloudglueMemoryConfig) {}

  write(_record: OvercastRecord): void {
    // no-op: uploading media to the collection is out of scope (a separate
    // cost-policy feature). This provider only READS the collection.
  }

  async status(): Promise<MemoryIndexStatus> {
    const key = resolveCloudglue().apiKey;
    const ready = Boolean(key) && Boolean(this.ref.collectionId);
    return {
      provider: this.id,
      backend: this.backend,
      state: ready ? "ready" : "missing",
      config: { collection: this.ref.collectionId, index: this.ref.indexId },
      error: ready
        ? undefined
        : "attach a media-descriptions index and set CLOUDGLUE_API_KEY (opt in with `overcast setup memory cloudglue`)",
    };
  }

  /** Plain `ask` stays local-only — the cloud tier is `ask --deep`. Returning []
   *  guarantees a default ask never spends against the collection. */
  query(_q: string, _opts?: QueryOpts): Passage[] {
    return [];
  }

  /** `ask --deep`: answer over the case's media-descriptions collection through
   *  the public tinycloud ask verb and map cited moments to passages. */
  async deepsearch(q: string, opts?: QueryOpts): Promise<Passage[]> {
    const rec = await this.run(q, opts);
    return this.toPassages(rec, opts?.limit);
  }

  /** Grounded NL answer + citations (used when deepsearch yields no passages, and
   *  the cleaner rendering when it does). Same public call, mapped to an Answer. */
  async answer(q: string, opts?: QueryOpts): Promise<Answer> {
    const rec = await this.run(q, opts);
    const text = str(objOf(rec.payload).text) ?? "";
    if (!text && rec.error) return { text: `cloudglue: ${rec.error}`, citations: [] };
    if (!text) return { text: `No cloud results for "${q}".`, citations: [] };
    const citations: Citation[] = this.toPassages(rec, opts?.limit).map((p) => ({
      recordId: p.recordId,
      at: p.at,
      verb: p.verb,
      text: p.text,
    }));
    return { text, citations };
  }

  /** The single PAID cloud call, memoized per (query, limit). Returns the cached
   *  in-flight/settled Promise when present so `deepsearch` + `answer` for the
   *  same query share ONE `tcAsk` invocation. Not `async`: it returns the SAME
   *  Promise object so sequential callers coalesce onto one call. */
  private run(q: string, opts?: QueryOpts): Promise<OvercastRecord> {
    const key = JSON.stringify([q, opts?.limit ?? null]);
    const cached = this.runs.get(key);
    if (cached) return cached;
    const pending = tcAsk(q, this.ref.collectionId, {
      limit: opts?.limit,
      base: this.ref.base,
      env: this.ref.env,
      signal: this.ref.signal,
    });
    this.runs.set(key, pending);
    return pending;
  }

  /** Map a `tcAsk` record ({ text, citations[], mode }) to Passages: one per cited
   *  moment (snippet or, if none, the overall answer), or a single passage
   *  carrying the answer when the collection returned no moments. */
  private toPassages(rec: OvercastRecord, limit?: number): Passage[] {
    const payload = objOf(rec.payload);
    const answerText = str(payload.text) ?? "";
    const verb = str(payload.mode) ?? "ask";
    const moments = Array.isArray(payload.citations) ? payload.citations : [];
    const passages: Passage[] = [];
    for (const raw of moments) {
      const m = objOf(raw);
      const text = momentText(m) || answerText;
      if (!text) continue;
      passages.push({
        recordId: momentRef(m, this.ref.collectionId),
        at: momentAt(m),
        text,
        score: momentScore(m),
        verb,
        provider: this.id,
      });
    }
    if (passages.length === 0 && answerText) {
      passages.push({ recordId: this.ref.collectionId, text: answerText, score: 1, verb, provider: this.id });
    }
    // Cap to the caller's --limit so the cloud tier matches qmd/local-grep in a deep
    // fan-out: `tcAsk` ignores `limit` for a non-probe collection ask, so without this
    // cloudglue could contribute more citations than the user asked for (Bugbot #72).
    return limit != null && limit >= 0 ? passages.slice(0, limit) : passages;
  }
}
