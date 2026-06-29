import { makeRecord, type MediaRef, type OvercastRecord } from "../record.js";
import { resolveMediaRef } from "./media-ref.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "finding", format: "json", payload: { error: message }, error: message, state: "error" });
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
}): OvercastRecord {
  const payload: Record<string, unknown> = {
    text: input.text,
    target: input.target,
    source_record: input.sourceRecord.id,
    source_verb: input.sourceRecord.verb,
    trigger: input.trigger,
    status: "open",
  };
  if (input.confidence != null) payload.confidence = input.confidence;
  const media: MediaRef | undefined = input.sourceRecord.media ? { ...input.sourceRecord.media } : undefined;
  return makeRecord({
    verb: "finding",
    format: "json",
    payload,
    media,
    meta: { case: input.sourceRecord.meta?.case, provider: "automation" },
    state: "ready",
  });
}

function textFromArgs(ctx: VerbContext): string {
  return [ctx.rest[0], ...ctx.rest.slice(1)].filter(Boolean).join(" ").trim();
}

function parseStamp(s: string): number | undefined {
  const raw = s.trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+(?:\.\d+)?$/.test(p))) return undefined;
  const nums = parts.map(Number);
  return nums.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2];
}

function parseAt(s: string): number | [number, number] | undefined {
  const span = s.trim().match(/^(.+)-(.+)$/);
  if (span) {
    const start = parseStamp(span[1]);
    const end = parseStamp(span[2]);
    if (start == null || end == null || end < start) return undefined;
    return [start, end];
  }
  return parseStamp(s);
}

function isRootFindingRecord(rec: OvercastRecord): boolean {
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
    "Creates manual findings and lists/reviews automated finding records emitted by setup automation. " +
    "`accept` and `dismiss` append review records that reference the original finding; dismissed findings remain auditable but are excluded from memory/brief evidence.",
  args: [
    { name: "action", summary: "create | list | accept | dismiss (default: list)" },
    { name: "id", summary: "finding id for accept/dismiss, or text for create" },
  ],
  flags: [
    { name: "state", summary: "list: open | accepted | dismissed | all", type: "string" },
    { name: "target", summary: "create: target/scope this finding supports", type: "string" },
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
      if (ctx.opts.ref != null) {
        const rawRef = String(ctx.opts.ref).trim();
        const rec = ctx.case.recordById(rawRef);
        if (rec) {
          sourceRecord = rec.id;
          sourceVerb = rec.verb;
          evidenceRef = rec.media?.ref ?? rec.id;
          if (rec.media?.ref) media = { ...rec.media };
        } else {
          const resolved = resolveMediaRef(ctx.case, rawRef);
          sourceRecord = resolved.recordId;
          evidenceRef = resolved.ref;
          media = { ref: resolved.ref };
        }
      }
      if (ctx.opts.at != null) {
        if (!media?.ref) return [err("--at requires --ref to resolve to media")];
        const at = parseAt(String(ctx.opts.at));
        if (at == null) return [err(`invalid --at '${ctx.opts.at}' (expected seconds, hh:mm:ss, or start-end)`)];
        media = { ref: media.ref, at };
      }
      const payload: Record<string, unknown> = {
        text,
        target: ctx.opts.target ? String(ctx.opts.target) : "",
        source_record: sourceRecord ?? "manual",
        source_verb: sourceVerb,
        trigger: "human",
        status: "open",
      };
      if (ctx.opts.confidence) payload.confidence = String(ctx.opts.confidence);
      if (evidenceRef) payload.ref = evidenceRef;
      return [makeRecord({ verb: "finding", format: "json", payload, media, meta: { case: ctx.case.dir, provider: "human" }, state: "ready" })];
    }
    if (action === "list") {
      const filter = ctx.opts.state ? String(ctx.opts.state) : "open";
      const roots = ctx.case.records().filter(isRootFindingRecord);
      const findings = roots.map((r) => ({ ...r, review_status: latestFindingStatus(ctx, r.id) }));
      const filtered = filter === "all" ? findings : findings.filter((r) => r.review_status === filter);
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
    return [
      makeRecord({
        verb: "finding",
        format: "json",
        payload: { finding_id: id, status, reviewed_at: new Date().toISOString() },
        media: original.media,
        meta: { case: ctx.case.dir, provider: "human-review" },
        state: "ready",
      }),
    ];
  },
};
