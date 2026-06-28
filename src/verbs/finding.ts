import { makeRecord, type MediaRef, type OvercastRecord } from "../record.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "finding", format: "json", payload: { error: message }, error: message, state: "error" });
}

function latestFindingStatus(ctx: VerbContext, id: string): string {
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

export const findingVerb: VerbSpec = {
  name: "finding",
  group: "state",
  summary: "Review automated target matches (list|accept|dismiss).",
  description:
    "Lists and reviews automated finding records emitted by setup automation. " +
    "`accept` and `dismiss` append review records that reference the original finding; dismissed findings remain auditable but are excluded from memory/brief evidence.",
  args: [
    { name: "action", summary: "list | accept | dismiss", required: true },
    { name: "id", summary: "finding id for accept/dismiss" },
  ],
  flags: [
    { name: "state", summary: "list: open | accepted | dismissed | all", type: "string" },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "finding",
  providerKey: "finding",
  run: async (ctx) => {
    const action = ctx.input;
    if (action === "list") {
      const filter = ctx.opts.state ? String(ctx.opts.state) : "open";
      const all = ctx.case.records().filter((r) => r.verb === "finding" && typeof r.payload === "object");
      const roots = all.filter((r) => !((r.payload as Record<string, unknown>).finding_id));
      const findings = roots.map((r) => ({ ...r, review_status: latestFindingStatus(ctx, r.id) }));
      const filtered = filter === "all" ? findings : findings.filter((r) => r.review_status === filter);
      return [makeRecord({ verb: "finding", format: "json", payload: { state: filter, findings: filtered }, state: "ready" })];
    }
    if (action !== "accept" && action !== "dismiss") return [err("usage: finding list|accept|dismiss [id]")];
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
