// tinycloud `library collections` lifecycle + collection-backed ask/probe,
// mapped to loose records at the exec boundary (invariants #3/#9). The `collection`
// verb drives create/add/show/list/delete/remove/entities; `ask --collection`
// drives tcAsk. Each function returns the mapped record plus the few extracted
// ids the verb needs to update its local mirror (state/collection.ts).

import { makeRecord, type OvercastRecord } from "../../record.js";
import { runTinycloud, type RunTinycloudOpts, type TinycloudOutcome } from "./envelope.js";

const META = (op: string) => ({ provider: "tinycloud", model: "cloudglue", op });

const base = (ref: unknown): string => {
  const s = typeof ref === "string" ? ref : "";
  return s.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() || s;
};

/** Normalize a collection file's status into ready / processing / failed. */
function fileStatus(f: unknown): "ready" | "processing" | "failed" | "other" {
  const s = f && typeof f === "object" && typeof (f as Record<string, unknown>).status === "string" ? ((f as Record<string, unknown>).status as string).toLowerCase() : "";
  if (/(ready|complete|done|success|indexed)/.test(s)) return "ready";
  if (/(fail|error)/.test(s)) return "failed";
  if (/(pending|process|upload|index|queue|run|wait)/.test(s)) return "processing";
  return "other";
}

/** A one-line headline per collection op — the FIRST thing a reader (or agent)
 *  sees, so the record reads cleanly like the sense verbs do, without paging the
 *  files[]/entities[]/detailed blobs. */
function summarizeCollection(op: string, extra: Record<string, unknown>, state: string | undefined): string | undefined {
  const pending = state === "pending";
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  switch (op) {
    case "create":
      return `${pending ? "provisioning" : "created"} ${extra.type ?? ""} collection${extra.name ? ` '${extra.name}'` : ""}`.replace(/\s+/g, " ").trim();
    case "add":
      return `${pending ? "queued" : "added"} ${base(extra.file)} for indexing${pending ? " — processing server-side, ask once ready" : ""}`;
    case "remove":
      return `removed ${base(extra.file)} from the collection`;
    case "delete":
      return pending ? "collection deletion queued" : "collection deleted";
    case "list": {
      const c = num(extra.count);
      return `${c} collection${c === 1 ? "" : "s"} in this account`;
    }
    case "entities": {
      const c = num(extra.count);
      return c === 0 ? `no entities extracted from ${base(extra.file)}` : `${c} entit${c === 1 ? "y" : "ies"} extracted from ${base(extra.file)}`;
    }
    case "show": {
      const files = Array.isArray(extra.files) ? extra.files : [];
      const by = { ready: 0, processing: 0, failed: 0, other: 0 };
      for (const f of files) by[fileStatus(f)]++;
      const parts: string[] = [];
      if (by.ready) parts.push(`${by.ready} ready`);
      if (by.processing) parts.push(`${by.processing} processing`);
      if (by.failed) parts.push(`${by.failed} failed`);
      if (by.other) parts.push(`${by.other} other`);
      return `${files.length} video${files.length === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", ")}` : ""}`;
    }
  }
  return undefined;
}

/** Build a `collection` record from a tinycloud outcome, always keeping the raw
 *  data under `detailed` so nothing is lost when our field guesses miss. Leads with
 *  a synthesized `summary` headline (consistent with the sense verbs); tinycloud's
 *  own terse line, if any, is kept as `provider_summary`. */
function collectionRecord(
  op: string,
  out: TinycloudOutcome,
  extra: Record<string, unknown>,
  media?: { ref: string },
): OvercastRecord {
  const payload: Record<string, unknown> = { op };
  const summary = summarizeCollection(op, extra, out.state);
  if (summary) payload.summary = summary;
  if (typeof out.env.summary === "string" && out.env.summary.trim()) payload.provider_summary = out.env.summary;
  Object.assign(payload, extra);
  payload.detailed = out.data;
  return makeRecord({
    verb: "collection",
    format: "json",
    payload,
    media,
    meta: META(op),
    error: out.error,
    state: out.state,
  });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Best-effort tinycloud collection id from a create/show envelope. */
export function pickCollectionId(out: TinycloudOutcome): string | undefined {
  const d = out.data;
  const nested = d.collection && typeof d.collection === "object" ? (d.collection as Record<string, unknown>) : {};
  return (
    str(d.collection_id) ??
    str(d.collectionId) ??
    str(d.id) ??
    str(nested.id) ??
    str(out.env.result_id) ??
    str(out.env.source_id)
  );
}

export interface CollectionRunOpts extends RunTinycloudOpts {}

/** `library collections create <name> --type <type> [--description] [--prompt|--schema]`. */
export async function tcCollectionCreate(
  name: string,
  type: string,
  o: CollectionRunOpts & { description?: string; prompt?: string; schema?: string } = {},
): Promise<{ rec: OvercastRecord; id?: string }> {
  const args = ["library", "collections", "create", name, "--type", type];
  if (o.description) args.push("--description", o.description);
  if (o.prompt) args.push("--prompt", o.prompt);
  if (o.schema) args.push("--schema", o.schema);
  args.push("--json");
  const out = await runTinycloud(args, o);
  const id = pickCollectionId(out);
  const rec = collectionRecord("create", out, { id: id ?? null, name, type });
  return { rec, id };
}

/** `library collections add <video> --to <id> [--no-upload] [--no-download]`. */
export async function tcCollectionAdd(
  video: string,
  collectionId: string,
  o: CollectionRunOpts & { noUpload?: boolean; noDownload?: boolean } = {},
): Promise<{ rec: OvercastRecord; fileId?: string }> {
  const args = ["library", "collections", "add", video, "--to", collectionId];
  if (o.noUpload) args.push("--no-upload");
  if (o.noDownload) args.push("--no-download");
  args.push("--json");
  const out = await runTinycloud(args, o);
  const fileId = str(out.data.file_id) ?? str(out.data.fileId) ?? str(out.data.id);
  const rec = collectionRecord("add", out, { collection: collectionId, file: video, file_id: fileId ?? null }, { ref: video });
  return { rec, fileId };
}

/** `library collections show <id>` — live metadata + files[].status. */
export async function tcCollectionShow(collectionId: string, o: CollectionRunOpts = {}): Promise<{ rec: OvercastRecord }> {
  const out = await runTinycloud(["library", "collections", "show", collectionId, "--json"], o);
  const files = Array.isArray(out.data.files) ? (out.data.files as unknown[]) : [];
  const rec = collectionRecord("show", out, { collection: collectionId, files, file_count: files.length });
  return { rec };
}

/** `library collections list` — all collections for the account. */
export async function tcCollectionList(o: CollectionRunOpts = {}): Promise<{ rec: OvercastRecord }> {
  const out = await runTinycloud(["library", "collections", "list", "--json"], o);
  const cols = Array.isArray(out.data.collections)
    ? (out.data.collections as unknown[])
    : Array.isArray(out.data.items)
      ? (out.data.items as unknown[])
      : [];
  const rec = collectionRecord("list", out, { collections: cols, count: cols.length });
  return { rec };
}

// An accepted op (ready OR an async pending) is reflected as done in the payload,
// matching the verb's mirror update (which prunes on ready||pending) — so the
// payload boolean can't contradict `.overcast/collections.json`.
const accepted = (s: string | undefined) => s === "ready" || s === "pending";

/** `library collections delete <id>`. */
export async function tcCollectionDelete(collectionId: string, o: CollectionRunOpts = {}): Promise<{ rec: OvercastRecord }> {
  const out = await runTinycloud(["library", "collections", "delete", collectionId, "--json"], o);
  const rec = collectionRecord("delete", out, { collection: collectionId, deleted: accepted(out.state) });
  return { rec };
}

/** `library collections remove <video> --from <id>`. */
export async function tcCollectionRemove(
  video: string,
  collectionId: string,
  o: CollectionRunOpts = {},
): Promise<{ rec: OvercastRecord }> {
  const out = await runTinycloud(["library", "collections", "remove", video, "--from", collectionId, "--json"], o);
  const rec = collectionRecord("remove", out, { collection: collectionId, file: video, removed: accepted(out.state) }, { ref: video });
  return { rec };
}

/** `library collections entities <id> <video>` — extracted entities for a video. */
export async function tcCollectionEntities(
  collectionId: string,
  video: string,
  o: CollectionRunOpts & { limit?: number; offset?: number } = {},
): Promise<{ rec: OvercastRecord }> {
  const args = ["library", "collections", "entities", collectionId, video];
  if (o.limit != null) args.push("--limit", String(o.limit));
  if (o.offset != null) args.push("--offset", String(o.offset));
  args.push("--json");
  const out = await runTinycloud(args, o);
  const entities = Array.isArray(out.data.entities)
    ? (out.data.entities as unknown[])
    : Array.isArray(out.data.results)
      ? (out.data.results as unknown[])
      : [];
  const rec = collectionRecord("entities", out, { collection: collectionId, file: video, entities, count: entities.length }, { ref: video });
  return { rec };
}

/**
 * Collection-backed `ask`/`probe`: `tinycloud ask "<q>" --in collection:<id>`
 * (or `probe` for semantic moment search). Emits an `answer` record matching the
 * local-memory ask shape ({ text, citations, question }) + `collection`.
 */
export async function tcAsk(
  question: string,
  collectionId: string,
  o: CollectionRunOpts & { probe?: boolean; scope?: string; limit?: number } = {},
): Promise<OvercastRecord> {
  const verb = o.probe ? "probe" : "ask";
  const args = [verb, question, "--in", `collection:${collectionId}`];
  if (o.probe && o.scope) args.push("--scope", o.scope);
  if (o.limit != null) args.push("--limit", String(o.limit));
  args.push("--json");
  const out = await runTinycloud(args, o);

  if (out.state === "error" || out.state === "needs_credentials") {
    return makeRecord({
      verb: "ask",
      format: "json",
      payload: { text: "", citations: [], question, collection: collectionId, mode: verb },
      meta: { provider: "cloudglue", model: "cloudglue", op: verb, collection: collectionId },
      error: out.error,
      state: out.state,
    });
  }

  const text =
    str(out.data.answer) ??
    str(out.data.text) ??
    str(out.data.summary) ??
    str(out.env.summary) ??
    "";
  const citations = Array.isArray(out.data.citations)
    ? (out.data.citations as unknown[])
    : Array.isArray(out.data.moments)
      ? (out.data.moments as unknown[])
      : Array.isArray(out.data.results)
        ? (out.data.results as unknown[])
        : [];

  return makeRecord({
    verb: "ask",
    format: "md",
    payload: { text, citations, question, collection: collectionId, mode: verb, detailed: out.data },
    meta: { provider: "cloudglue", model: "cloudglue", op: verb, collection: collectionId },
    state: out.state,
  });
}
