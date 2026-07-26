import { makeRecord, errRecord, isReady, type MediaRef, type OvercastRecord } from "../record.js";
import { resolveMediaRef, refPathExists } from "./media-ref.js";
import { parseAtSpan } from "../media/ffmpeg.js";
import { listTargets, type TargetEntry } from "../state/target.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

const err = (message: string): OvercastRecord => errRecord("finding", message);

/** Resolve a `--target` value against the target registry, by id or exact value
 *  (case-insensitive on the value). A finding stamped with the resolved
 *  target_id renders inside that line of investigation in brief/status. */
function resolveTargetFlag(ctx: VerbContext, raw: string): { entry?: TargetEntry; error?: string } {
  const value = raw.trim();
  const targets = listTargets(ctx.case);
  const entry = targets.find((t) => t.id === value) ?? targets.find((t) => t.value.toLowerCase() === value.toLowerCase());
  if (entry) return { entry };
  return {
    error: `--target does not match a target id or value: ${value}` + (targets.length ? ` (targets: ${targets.map((t) => `${t.id}=${t.value}`).join(", ")})` : " (no targets defined — `overcast target add …` first)"),
  };
}

export function latestFindingStatus(ctx: VerbContext, id: string): string {
  const updates = ctx.case.records().filter((r) => r.verb === "finding" && typeof r.payload === "object");
  let status = "open";
  for (const rec of updates) {
    const p = rec.payload as Record<string, unknown>;
    if (rec.id === id && typeof p.status === "string") status = p.status;
    if (p.finding_id === id && typeof p.status === "string") status = p.status;
  }
  return status;
}

export function makeFinding(input: {
  text: string;
  target: string;
  sourceRecord: OvercastRecord;
  trigger: string;
  confidence?: number | string;
  /** root finding status; "suggested" = quarantined lead awaiting review */
  status?: string;
  /** stable target link (payload.target stays the value string for back-compat) */
  targetId?: string;
  /** score-trigger evidence: {kind, score, threshold, unit, at?, matched?} */
  signal?: Record<string, unknown>;
  /** best-scoring moment override for media.at (defaults to the source's anchor) */
  at?: number | [number, number];
}): OvercastRecord {
  const payload: Record<string, unknown> = {
    text: input.text,
    target: input.target,
    source_record: input.sourceRecord.id,
    source_verb: input.sourceRecord.verb,
    trigger: input.trigger,
    status: input.status ?? "open",
  };
  if (input.confidence != null) payload.confidence = input.confidence;
  if (input.targetId) payload.target_id = input.targetId;
  if (input.signal) payload.signal = input.signal;
  let media: MediaRef | undefined = input.sourceRecord.media ? { ...input.sourceRecord.media } : undefined;
  if (input.at != null && media?.ref) media = { ref: media.ref, at: input.at };
  return makeRecord({
    verb: "finding",
    format: "json",
    payload,
    media,
    // an auto-suggested lead from an archive-index match (face/image/similar/
    // audio/cluster --index archive:…) inherits the match record's bucket trace
    meta: {
      case: input.sourceRecord.meta?.case,
      provider: "automation",
      ...(typeof input.sourceRecord.meta?.archive === "string" ? { archive: input.sourceRecord.meta.archive } : {}),
    },
    state: "ready",
  });
}

function textFromArgs(ctx: VerbContext): string {
  return [ctx.rest[0], ...ctx.rest.slice(1)].filter(Boolean).join(" ").trim();
}

/** Who performed a manual finding action: the operator typing at the CLI/TUI
 *  (`human`) or the LLM invoking the agent tool on their behalf (`agent`).
 *  Stamped on meta.provider so the audit trail carries a real "who" instead of
 *  a constant — in a single-operator tool, human-typed vs agent-invoked is the
 *  attribution that matters (an injected agent can run `finding create`/`accept`;
 *  the record must say the agent did). Unknown surface = direct library use;
 *  treated as human. */
const actorOf = (ctx: VerbContext): "human" | "agent" => (ctx.surface === "agent" ? "agent" : "human");

export function isRootFindingRecord(rec: OvercastRecord): boolean {
  if (rec.verb !== "finding" || rec.state === "error" || typeof rec.payload !== "object" || rec.payload == null) return false;
  const p = rec.payload as Record<string, unknown>;
  if (typeof p.finding_id === "string") return false;
  return typeof p.status === "string" && typeof p.text === "string";
}

export const findingVerb: VerbSpec = {
  name: "finding",
  group: "state",
  summary: "Create and review findings (create|list|accept|dismiss).",
  description:
    "Creates manual findings and lists/reviews automated findings. Score/text triggers emit `suggested` findings (leads) that stay OUT of memory/brief evidence until reviewed — " +
    "`finding list --state triage` queues them newest-first, `accept` promotes a lead into evidence, `dismiss` rejects it (a dismissed suggestion never re-fires for the same match). " +
    "Review records reference the original finding; dismissed findings remain auditable. " +
    "NOTE the asymmetry: only AUTOMATED leads are quarantined. `finding create` is the operator's own promotion act — it writes an `open` finding that is evidence " +
    "immediately, with no review step. The guarantee is deliberate + attributed + reversible, not reviewed: meta.provider records who ran it (`human` at the CLI/TUI, " +
    "`agent` via the agent tool), `--note` on accept/dismiss records why, and `dismiss` retracts a created finding from evidence.",
  args: [
    { name: "action", summary: "create | list | accept | dismiss (default: list)", choices: ["create", "list", "accept", "dismiss"] },
    { name: "id", summary: "finding id for accept/dismiss, or text for create" },
  ],
  flags: [
    { name: "state", summary: "list: open | suggested | accepted | dismissed | all | triage (open+suggested), or a comma-list", type: "string" },
    { name: "target", summary: "create/accept/dismiss: the target line this finding supports (id or value; stamps target_id so it renders in that line of investigation)", type: "string" },
    { name: "note", summary: "accept/dismiss: why — the review rationale, recorded on the review record for the audit trail", type: "string" },
    { name: "ref", summary: "create: source record id, capture id, media path, or URL", type: "string" },
    { name: "at", summary: "create: evidence timestamp seconds, hh:mm:ss, or start-end", type: "string" },
    { name: "confidence", summary: "create: confidence marker or score", type: "string" },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "finding",
  providerKey: "finding",
  run: async (ctx) => {
    const action = ctx.input ?? "list";
    if (action === "create") {
      const text = textFromArgs(ctx);
      if (!text) return [err("finding create requires finding text")];
      for (const f of ["target", "ref", "at", "confidence"] as const) {
        if (ctx.opts[f] != null && !String(ctx.opts[f]).trim()) return [err(`--${f} requires a value`)];
      }
      let media: MediaRef | undefined;
      let sourceRecord: string | undefined;
      let sourceVerb = "manual";
      let evidenceRef: string | undefined;
      // a finding anchored to archived evidence traces to the bucket (like note
      // + the derived sense records)
      let archiveBucket: string | undefined;
      if (ctx.opts.ref != null) {
        const rawRef = String(ctx.opts.ref).trim();
        const rec = ctx.case.recordById(rawRef);
        if (rec) {
          sourceRecord = rec.id;
          sourceVerb = rec.verb;
          evidenceRef = rec.media?.ref ?? rec.id;
          if (typeof rec.meta?.archive === "string") archiveBucket = rec.meta.archive;
          if (rec.media?.ref) media = { ...rec.media };
        } else {
          const resolved = resolveMediaRef(ctx.case, rawRef, ctx.home);
          if (resolved.error) return [err(`--ref ${resolved.error}`)];
          // a finding is evidence — don't cite a partial in-flight bucket file
          // (parity with note/senses/capture/forensics readiness gating)
          if (resolved.record && !isReady(resolved.record)) return [err(`--ref record ${resolved.record.id} isn't ready (state=${resolved.record.state ?? "?"})`)];
          archiveBucket = resolved.archive;
          // Reject a --ref that resolves to nothing real (mirrors `note`): a
          // finding is evidence, so it must not cite a path/id that never existed.
          if (resolved.recordId == null && !resolved.archive) {
            const isUrl = /^https?:\/\//i.test(rawRef);
            // absolute path, or a case-relative path CONTAINED in the case dir (a
            // `../` escape outside the case store is rejected — no arbitrary files).
            const isExistingPath = !isUrl && refPathExists(ctx.case.dir, rawRef, ctx.home);
            if (!isUrl && !isExistingPath) {
              if (/^rec_/i.test(rawRef)) return [err(`--ref record not found in this case: ${rawRef}`)];
              if (/^cap_/i.test(rawRef)) return [err(`--ref capture id not found in this case: ${rawRef}`)];
              return [err(`--ref does not resolve to a record, capture id, existing path, or URL: ${rawRef}`)];
            }
          }
          sourceRecord = resolved.recordId;
          // keep the archive:<bucket>/<item> trace as the cited ref; media.ref
          // carries the resolved playable path.
          evidenceRef = resolved.archive ? rawRef : resolved.ref;
          media = { ref: resolved.ref };
        }
      }
      if (ctx.opts.at != null) {
        if (!media?.ref) return [err("--at requires --ref to resolve to media")];
        const at = parseAtSpan(String(ctx.opts.at));
        if (at == null) return [err(`invalid --at '${ctx.opts.at}' (expected seconds, hh:mm:ss, or start-end)`)];
        media = { ref: media.ref, at };
      }
      // --target resolves softly on create: a registry match stamps target_id
      // (the finding renders inside that line of investigation); a free-form
      // scope string is kept as-is in payload.target (back-compat).
      const rawTarget = ctx.opts.target ? String(ctx.opts.target) : "";
      const resolvedTarget = rawTarget ? resolveTargetFlag(ctx, rawTarget).entry : undefined;
      const payload: Record<string, unknown> = {
        text,
        target: resolvedTarget?.value ?? rawTarget,
        source_record: sourceRecord ?? "manual",
        source_verb: sourceVerb,
        trigger: "human",
        status: "open",
      };
      if (resolvedTarget) payload.target_id = resolvedTarget.id;
      if (ctx.opts.confidence) payload.confidence = String(ctx.opts.confidence);
      if (evidenceRef) payload.ref = evidenceRef;
      return [makeRecord({ verb: "finding", format: "json", payload, media, meta: { case: ctx.case.dir, provider: actorOf(ctx), ...(archiveBucket ? { archive: archiveBucket } : {}) }, state: "ready" })];
    }
    if (action === "list") {
      const filter = (ctx.opts.state ? String(ctx.opts.state) : "open").trim().toLowerCase();
      const wanted = new Set(
        filter === "triage" ? ["open", "suggested"] : filter.split(",").map((s) => s.trim()).filter(Boolean),
      );
      const roots = ctx.case.records().filter(isRootFindingRecord);
      const byId = new Map(ctx.case.records().map((r) => [r.id, r]));
      const findings = roots.map((r) => {
        const row: Record<string, unknown> = { ...r, review_status: latestFindingStatus(ctx, r.id) };
        // triage context: the cited record's provenance, so a lead is judgeable
        // from the queue without a second lookup.
        const p = r.payload as Record<string, unknown>;
        const src = typeof p.source_record === "string" ? byId.get(p.source_record) : undefined;
        const sp = src?.payload && typeof src.payload === "object" ? (src.payload as Record<string, unknown>) : undefined;
        if (typeof sp?.source_url === "string") row.source_url = sp.source_url;
        else if (typeof sp?.url === "string") row.source_url = sp.url;
        if (typeof sp?.source_text === "string") row.source_excerpt = String(sp.source_text).slice(0, 200);
        return row;
      });
      // newest first so fresh suggestions triage from the top
      findings.sort((a, b) => String((b as { meta?: { time?: string } }).meta?.time ?? "").localeCompare(String((a as { meta?: { time?: string } }).meta?.time ?? "")));
      const filtered = filter === "all" ? findings : findings.filter((r) => wanted.has(String(r.review_status)));
      return [makeRecord({ verb: "finding", format: "json", payload: { state: filter, findings: filtered }, meta: { transient: true }, state: "ready" })];
    }
    if (action !== "accept" && action !== "dismiss") return [err("usage: finding create|list|accept|dismiss [id]")];
    const id = ctx.rest[0];
    if (!id) return [err(`finding ${action} requires a finding id`)];
    const original = ctx.case.recordById(id);
    if (!original || original.verb !== "finding") return [err(`finding not found: ${id}`)];
    if (original.payload && typeof original.payload === "object" && typeof (original.payload as Record<string, unknown>).finding_id === "string") {
      return [err(`finding ${action} requires a root finding id, not a review record id`)];
    }
    const status = action === "accept" ? "accepted" : "dismissed";
    // --target at review time stamps the finding onto a line of investigation
    // (strict: attribution is the point here, so an unresolvable value errors).
    // On DISMISS the stamp is audit metadata only — findingTargetMap ignores
    // dismiss-row stamps, so it can't become live linkage after a later accept.
    let reviewTargetId: string | undefined;
    if (ctx.opts.target != null) {
      const resolved = resolveTargetFlag(ctx, String(ctx.opts.target));
      if (!resolved.entry) return [err(resolved.error!)];
      reviewTargetId = resolved.entry.id;
    }
    // --note = the WHY of the review, persisted on the review record so the
    // audit trail explains the judgment, not just its outcome (parity with
    // `target close --note`).
    let reviewNote: string | undefined;
    if (ctx.opts.note != null) {
      reviewNote = String(ctx.opts.note).trim();
      if (!reviewNote) return [err("--note requires a value")];
    }
    return [
      makeRecord({
        verb: "finding",
        format: "json",
        payload: {
          finding_id: id,
          status,
          reviewed_at: new Date().toISOString(),
          ...(reviewNote ? { note: reviewNote } : {}),
          ...(reviewTargetId ? { target_id: reviewTargetId } : {}),
        },
        media: original.media,
        // "<who>-review": human-review = the operator at the CLI/TUI,
        // agent-review = the LLM ran accept/dismiss through the agent tool.
        meta: { case: ctx.case.dir, provider: `${actorOf(ctx)}-review` },
        state: "ready",
      }),
    ];
  },
};
