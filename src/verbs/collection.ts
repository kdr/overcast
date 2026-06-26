// `collection` verb (OSINT): manage the lifecycle of tinycloud collections — the
// remote (Cloudglue) indexes that make a target's videos searchable. One verb
// fans out to the tinycloud `library collections` ops and keeps a local mirror
// (state/collection.ts) of which collections + members this case owns.
//
//   collection create <name> --type media|entities|face [--prompt|--schema]
//   collection add <video|record-id> --to <id>     (or --all to register the case's videos)
//   collection list | show <id> | delete <id> | remove <video> --from <id>
//   collection entities <id> <video>               (entities collections)
//
// Read the indexed videos with: `ask --collection <id>` (media-descriptions),
// `face --match … --collection <id>` (face-analysis), `collection entities …`.

import { existsSync } from "node:fs";
import { makeRecord, isReady, type OvercastRecord } from "../record.js";
import {
  tcCollectionCreate,
  tcCollectionAdd,
  tcCollectionShow,
  tcCollectionList,
  tcCollectionDelete,
  tcCollectionRemove,
  tcCollectionEntities,
} from "../providers/tinycloud/collection.js";
import {
  listCollections,
  findCollection,
  resolveCollectionRef,
  addCollection,
  removeCollection,
  addMember,
  removeMember,
  normalizeCollectionType,
} from "../state/collection.js";
import { providerEnv } from "../providers/provider-env.js";
import type { Case } from "../case.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

const VALID_ACTIONS = ["create", "add", "list", "show", "delete", "remove", "entities"];

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "collection", format: "json", payload: { error: message }, error: message, state: "error" });
}

/** A non-failure outcome: the op was accepted (an async add lands as `pending`
 *  while it ingests, but the membership intent is real). */
const accepted = (rec: OvercastRecord) => rec.state === "ready" || rec.state === "pending";

/** A case record id → its media.ref; otherwise the ref as-is (path / URL). */
function resolveMediaRef(c: Case, ref: string): { ref: string; recordId?: string } {
  const rec = c.recordById(ref);
  if (rec?.media?.ref) return { ref: rec.media.ref, recordId: rec.id };
  return { ref };
}

const AV_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|flac|ogg|aac)$/i;
const isAv = (ref: string) => /^https?:\/\//i.test(ref) || AV_RE.test(ref);

/** Unique AV media refs the case has captured or sensed (the media gathered while
 *  investigating the target) — what `collection add --all` registers: `capture`
 *  (fetched media) plus anything sensed via `watch`/`listen`/`face`. Deliberately
 *  excludes `scan` hits: their media.ref is a page/listing URL (and isAv accepts
 *  any http(s)), so they'd pollute the collection with non-video links — the
 *  actual media arrives via `capture` (scan --pull → capture record). */
function caseVideoRefs(c: Case): Array<{ ref: string; recordId: string }> {
  const out: Array<{ ref: string; recordId: string }> = [];
  const seen = new Set<string>();
  for (const r of c.records()) {
    if (!["capture", "watch", "listen", "face"].includes(r.verb)) continue;
    // skip non-ready senses: a failed/credential-gapped watch can still set
    // media.ref to the input path — registering those would pollute the collection.
    if (!isReady(r)) continue;
    // a face SEARCH record's media.ref is the QUERY image, not a case video — skip.
    if (r.verb === "face" && (r.payload as Record<string, unknown> | undefined)?.op === "search") continue;
    const ref = r.media?.ref;
    if (!ref || seen.has(ref) || !isAv(ref)) continue;
    seen.add(ref);
    out.push({ ref, recordId: r.id });
  }
  return out;
}

/** Resolve the target collection id for add/show/delete: an explicit value, else
 *  the case's sole mirrored collection (optionally filtered by type). */
function resolveTarget(c: Case, explicit?: string, type?: string): { id?: string; error?: string } {
  // a whitespace-only value is treated as missing (fall through to sole-collection
  // resolution), never shipped as a junk id.
  const ex = explicit?.trim();
  if (ex) {
    const ref = resolveCollectionRef(c, ex); // errors on an ambiguous display name
    if (ref.error) return { error: ref.error };
    return { id: ref.entry?.id ?? ex };
  }
  let cols = listCollections(c);
  if (type) cols = cols.filter((x) => x.type === type);
  if (cols.length === 1) return { id: cols[0].id };
  if (cols.length === 0) return { error: "no collections in this case — create one with `overcast collection create <name> --type <media|entities|face>`" };
  return { error: `multiple collections; specify one (ids: ${cols.map((x) => x.id).join(", ")})` };
}

export const collectionVerb: VerbSpec = {
  name: "collection",
  group: "osint",
  summary: "Manage tinycloud collections that index a target's videos (create/add/list/show/delete/remove/entities).",
  description:
    "A collection is a Cloudglue index of videos, searchable one way per TYPE: media-descriptions " +
    "(ask/probe), entities (same-schema extraction), face-analysis (detect + find a person). " +
    "`create <name> --type <media|entities|face>` (entities needs --prompt/--schema); `add <video> --to <id>` " +
    "registers a video (a path, URL, or a case record id) — `--all` registers every video the case has " +
    "captured or sensed (watch/listen/face) for the target; `list`/`show <id>` inspect; `delete <id>`/`remove <video> --from <id>` " +
    "prune; `entities <id> <video>` fetches a video's extracted entities. Then read with `ask --collection " +
    "<id>`, `face --match … --collection <id>`, or `collection entities`. Backed by tinycloud (≥ 0.3.4).",
  args: [
    { name: "action", summary: VALID_ACTIONS.join(" | "), required: true },
    { name: "arg", summary: "name (create) · video/record-id (add/remove) · collection id (show/delete) · collection id (entities)", required: false },
  ],
  flags: [
    { name: "type", summary: "create: media-descriptions | entities | face-analysis | rich-transcripts (aliases: media, face)", type: "string" },
    { name: "description", summary: "create: human description", type: "string" },
    { name: "prompt", summary: "create entities: free-text extraction prompt", type: "string" },
    { name: "schema", summary: "create entities: path to a JSON schema file", type: "string" },
    { name: "to", summary: "add: target collection id/name", type: "string" },
    { name: "from", summary: "remove: collection id/name to remove the video from", type: "string" },
    { name: "all", summary: "add: register every video the case has captured or sensed (watch/listen/face)", type: "boolean" },
    { name: "remote", summary: "list: also query tinycloud for all account collections", type: "boolean" },
    { name: "no-upload", summary: "add: don't upload (use an already-uploaded source)", type: "boolean" },
    { name: "no-download", summary: "add: don't materialize the source locally", type: "boolean" },
    { name: "limit", summary: "entities: max entities", type: "number" },
    { name: "offset", summary: "entities: entity offset", type: "number" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "collection",
  providerKey: "collection",
  run: async (ctx) => {
    const c = ctx.case;
    const action = ctx.input;
    const env = providerEnv(c.mediaDir);
    const tcOpts = { env, signal: ctx.signal };

    if (action && !VALID_ACTIONS.includes(action)) {
      return [err(`unknown collection action '${action}' (expected ${VALID_ACTIONS.join(" | ")})`)];
    }

    // ---- create ----
    if (action === "create") {
      const name = ctx.rest[0];
      if (!name) return [err("usage: collection create <name> --type <media-descriptions|entities|face-analysis>")];
      const rawType = ctx.opts.type ? String(ctx.opts.type) : "media-descriptions";
      const type = normalizeCollectionType(rawType);
      if (!type) {
        return [err(`unknown --type '${rawType}' (expected media-descriptions | entities | face-analysis | rich-transcripts)`)];
      }
      const prompt = ctx.opts.prompt ? String(ctx.opts.prompt) : undefined;
      const schema = ctx.opts.schema ? String(ctx.opts.schema) : undefined;
      if (type === "entities" && !prompt && !schema) {
        return [err("an entities collection needs --prompt <text> or --schema <file> (the schema to extract from every video)")];
      }
      if (schema && !existsSync(schema)) return [err(`--schema file not found: ${schema}`)];
      const { rec, id } = await tcCollectionCreate(name, type, {
        ...tcOpts,
        description: ctx.opts.description ? String(ctx.opts.description) : undefined,
        prompt,
        schema,
      });
      // mirror an accepted create (ready OR an async pending that still returned
      // a real id) so the create→add-by-name flow works; a cred gap / error has no id.
      if (id && accepted(rec)) addCollection(c, { id, type, name, description: ctx.opts.description ? String(ctx.opts.description) : undefined });
      rec.meta = { ...rec.meta, case: c.dir };
      return [rec];
    }

    // ---- add ----
    if (action === "add") {
      const typeHint = ctx.opts.type ? normalizeCollectionType(String(ctx.opts.type)) : undefined;
      const target = resolveTarget(c, ctx.opts.to ? String(ctx.opts.to) : undefined, typeHint);
      if (target.error) return [err(`collection add: ${target.error}`)];
      const id = target.id!;
      // Ensure the target is in the local mirror — it may have been created
      // outside this case and referenced only by id. Without this, addMember
      // no-ops (collection absent) and `add --all` re-adds the same videos every
      // run. Record the --type hint when given so face auto-resolution can find
      // it; otherwise "unknown" (face --match falls back to those candidates).
      const existing = findCollection(c, id);
      if (!existing) {
        addCollection(c, { id, type: typeHint ?? "unknown", name: id });
      } else if (typeHint && existing.type === "unknown") {
        // a later `add --type face` classifies a previously-unknown stub (addCollection upserts).
        addCollection(c, { id, type: typeHint, name: existing.name, description: existing.description });
      }
      const addOpts = {
        ...tcOpts,
        noUpload: ctx.opts["no-upload"] === true,
        noDownload: ctx.opts["no-download"] === true,
      };

      // --all: register every captured/sensed video not already a member.
      if (ctx.opts.all === true) {
        const col = findCollection(c, id);
        const members = new Set(col?.members.map((m) => m.ref) ?? []);
        const vids = caseVideoRefs(c).filter((v) => !members.has(v.ref));
        if (vids.length === 0) return [err("collection add --all: no new captured/sensed videos to register")];
        const recs: OvercastRecord[] = [];
        for (const v of vids) {
          const { rec } = await tcCollectionAdd(v.ref, id, addOpts);
          if (accepted(rec)) addMember(c, id, { ref: v.ref, recordId: v.recordId });
          rec.meta = { ...rec.meta, case: c.dir };
          recs.push(rec);
        }
        return recs;
      }

      const arg = ctx.rest[0];
      if (!arg) return [err("usage: collection add <video|record-id> --to <id> (or --all)")];
      const { ref, recordId } = resolveMediaRef(c, arg);
      if (!/^https?:\/\//i.test(ref) && !existsSync(ref)) {
        return [err(`collection add: video not found: ${ref}`)];
      }
      const { rec } = await tcCollectionAdd(ref, id, addOpts);
      if (accepted(rec)) addMember(c, id, { ref, recordId });
      rec.meta = { ...rec.meta, case: c.dir };
      return [rec];
    }

    // ---- list ----
    if (action === "list" || action === undefined) {
      const mirror = listCollections(c).map((x) => ({ id: x.id, type: x.type, name: x.name, members: x.members.length }));
      if (ctx.opts.remote === true) {
        const { rec } = await tcCollectionList(tcOpts);
        (rec.payload as Record<string, unknown>).mirror = mirror;
        rec.meta = { ...rec.meta, case: c.dir };
        return [rec];
      }
      return [makeRecord({ verb: "collection", format: "json", payload: { op: "list", collections: mirror, count: mirror.length }, meta: { case: c.dir }, state: "ready" })];
    }

    // ---- show ----
    if (action === "show") {
      const target = resolveTarget(c, ctx.rest[0]);
      if (target.error) return [err(`collection show: ${target.error}`)];
      const { rec } = await tcCollectionShow(target.id!, tcOpts);
      rec.meta = { ...rec.meta, case: c.dir };
      return [rec];
    }

    // ---- delete ----
    if (action === "delete") {
      const target = resolveTarget(c, ctx.rest[0]);
      if (target.error) return [err(`collection delete: ${target.error}`)];
      const { rec } = await tcCollectionDelete(target.id!, tcOpts);
      if (accepted(rec)) removeCollection(c, target.id!);
      rec.meta = { ...rec.meta, case: c.dir };
      return [rec];
    }

    // ---- remove ----
    if (action === "remove") {
      const arg = ctx.rest[0];
      if (!arg) return [err("usage: collection remove <video|record-id> --from <id>")];
      const from = resolveTarget(c, ctx.opts.from ? String(ctx.opts.from) : undefined);
      if (from.error) return [err(`collection remove: ${from.error}`)];
      const { ref } = resolveMediaRef(c, arg);
      const { rec } = await tcCollectionRemove(ref, from.id!, tcOpts);
      // mirror on ready OR pending (an async remove still removed the member),
      // matching how `add` tracks membership via accepted().
      if (accepted(rec)) removeMember(c, from.id!, ref);
      rec.meta = { ...rec.meta, case: c.dir };
      return [rec];
    }

    // ---- entities ----
    if (action === "entities") {
      const id = ctx.rest[0];
      const videoArg = ctx.rest[1];
      if (!id || !videoArg) return [err("usage: collection entities <collection-id> <video|record-id>")];
      // validate the numeric paging flags (matches ask) — a 0/negative/NaN value
      // must not become a bad flag on the tinycloud CLI.
      let limit: number | undefined;
      if (ctx.opts.limit != null) {
        const n = Number(ctx.opts.limit);
        if (!Number.isFinite(n) || n <= 0) return [err(`collection entities: invalid --limit '${ctx.opts.limit}' (expected a positive number)`)];
        limit = n;
      }
      let offset: number | undefined;
      if (ctx.opts.offset != null) {
        const n = Number(ctx.opts.offset);
        if (!Number.isFinite(n) || n < 0) return [err(`collection entities: invalid --offset '${ctx.opts.offset}' (expected a non-negative number)`)];
        offset = n;
      }
      // resolve the collection id, surfacing an ambiguous-name error (like ask/add)
      // and rejecting a mirrored collection whose type isn't entities (entities are
      // only readable from an entities collection), consistent with ask/face.
      const colRef = resolveCollectionRef(c, id);
      if (colRef.error) return [err(`collection entities: ${colRef.error}`)];
      const colEntry = colRef.entry;
      if (colEntry && colEntry.type !== "entities" && colEntry.type !== "unknown") {
        return [err(`collection ${colEntry.id} is type '${colEntry.type}', not entities — \`collection entities\` only reads entities collections`)];
      }
      const colId = colEntry?.id ?? id;
      const { ref } = resolveMediaRef(c, videoArg);
      // fail early on a local-path typo (matches `add`), not late at the provider.
      if (!/^https?:\/\//i.test(ref) && !existsSync(ref)) {
        return [err(`collection entities: video not found: ${ref}`)];
      }
      const { rec } = await tcCollectionEntities(colId, ref, { ...tcOpts, limit, offset });
      rec.meta = { ...rec.meta, case: c.dir };
      return [rec];
    }

    return [err(`usage: collection <${VALID_ACTIONS.join("|")}>`)];
  },
};
