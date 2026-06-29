// `index` verb (OSINT): manage the lifecycle of tinycloud indexes — the
// remote (Cloudglue) indexes that make a target's videos searchable. One verb
// fans out to tinycloud's collection ops and keeps a local mirror
// (state/index.ts) of which indexes + members this case owns.
//
//   index create <name> --type media|entities|face [--prompt|--schema]
//   index add <video|record-id> --to <id>     (or --all to register the case's videos)
//   index list | attach <remote-id-or-name> | show <id> | delete <id> | remove <video> --from <id>
//   index entities <id> <video>               (entities indexes)
//
// Read the indexed videos with: `ask --index <id>` (media-descriptions),
// `face --match … --index <id>` (face-analysis), `index entities …`.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { makeRecord, isReady, type OvercastRecord } from "../record.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
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
  listIndexes,
  findIndex,
  resolveIndexRef,
  addIndex,
  removeIndex,
  addMember,
  removeMember,
  normalizeIndexType,
  setMembers,
} from "../state/index.js";
import { providerEnv } from "../providers/provider-env.js";
import { localIndexDir } from "../providers/local/vision.js";
import { resolveVideoArg, resolveImageArg, isRegisterableMediaRecord } from "./media-ref.js";
import { badNumber, numFlag } from "./validate.js";
import { tinycloudBaseFromRun } from "../providers/tinycloud/envelope.js";
import type { Case } from "../case.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

const VALID_ACTIONS = ["create", "attach", "add", "list", "show", "delete", "remove", "entities"];
const LOCAL_INDEX_TYPES = new Set(["deepface-local", "image-ransac"]);
const LOCAL_VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|m2ts|mts|ts|wmv|flv|3gp|3g2|ogv|mxf)$/i;

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "index", format: "json", payload: { error: message }, error: message, state: "error" });
}

function isLocalIndex(entry: { backend?: string; type: string }): boolean {
  return entry.backend === "local";
}

function indexRecord(rec: OvercastRecord): OvercastRecord {
  rec.verb = "index";
  if (rec.payload && typeof rec.payload === "object") {
    const p = rec.payload as Record<string, unknown>;
    if ("collection" in p && !("index" in p)) {
      p.index = p.collection;
      delete p.collection;
    }
    if ("collections" in p && !("indexes" in p)) {
      p.indexes = p.collections;
      delete p.collections;
    }
    if (typeof p.summary === "string") {
      p.summary = p.summary.replace(/\bcollections\b/g, "indexes").replace(/\bcollection\b/g, "index");
    }
    if (typeof p.provider_summary === "string") {
      p.provider_summary = p.provider_summary.replace(/\bcollections\b/g, "indexes").replace(/\bcollection\b/g, "index");
    }
  }
  return rec;
}

/** A non-failure outcome: the op was accepted (an async add lands as `pending`
 *  while it ingests, but the membership intent is real). */
const accepted = (rec: OvercastRecord) => rec.state === "ready" || rec.state === "pending";

/** show/delete take a POSITIONAL id; an `add`/`remove` target flag (--to/--from)
 *  with no positional is a misuse that must NOT fall through to the sole
 *  index (dangerous for delete). Returns the stray flag name, else undefined. */
function strayTargetFlag(ctx: VerbContext): string | undefined {
  if (ctx.rest[0]) return undefined;
  if (ctx.opts.to != null) return "--to";
  if (ctx.opts.from != null) return "--from";
  return undefined;
}

/** Unique AV media refs the case has captured or sensed (the media gathered while
 *  investigating the target) — what `index add --all` registers: `capture`
 *  (fetched media) plus anything sensed via `watch`/`listen`/`face`. Deliberately
 *  excludes `scan` hits: their media.ref is a page/listing URL (and isAv accepts
 *  any http(s)), so they'd pollute the index with non-video links — the
 *  actual media arrives via `capture` (scan --pull → capture record). */
function caseVideoRefs(c: Case): Array<{ ref: string; recordId: string }> {
  const out: Array<{ ref: string; recordId: string }> = [];
  const seen = new Set<string>();
  for (const r of c.records()) {
    // shared predicate (registerable verb + AV ref + not a face-search query image)
    // so --all's register list and its pending/failed accounting use one rule; here
    // we add the readiness gate (a failed/cred-gapped sense's ref would pollute).
    if (!isRegisterableMediaRecord(r) || !isReady(r)) continue;
    const ref = r.media!.ref!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, recordId: r.id });
  }
  return out;
}

function hasWatchRecord(c: Case, ref: string): boolean {
  return c.records().some((r) => {
    if (r.verb !== "watch" || r.media?.ref !== ref) return false;
    const state = String(r.state ?? "ready");
    return state !== "error" && state !== "needs_credentials";
  });
}

async function ensureLocalWatchRecord(ctx: VerbContext, ref: string): Promise<OvercastRecord | undefined> {
  if (
    ctx.opts["__skip-local-watch"] === true ||
    /^https?:\/\//i.test(ref) ||
    !LOCAL_VIDEO_RE.test(ref) ||
    !existsSync(ref) ||
    hasWatchRecord(ctx.case, ref)
  ) return undefined;
  const binding = providerBinding(ctx, "watch");
  const rec = isCustomBinding(binding)
    ? await runBoundProvider("watch", binding!, ref, {
        env: providerEnv(ctx.case.mediaDir),
        timeoutMs: 15 * 60_000,
        signal: ctx.signal,
      })
    : await runWatch(ref, { run: binding?.run, signal: ctx.signal });
  rec.meta = { ...rec.meta, case: ctx.case.dir, triggered_by: "index add" };
  return rec;
}

/** Resolve the target index id for add/show/delete: an explicit value, else
 *  the case's sole mirrored index (optionally filtered by type). A value that
 *  was PROVIDED but is blank/whitespace is a user error (like ask/face reject blank
 *  --index) — only a truly OMITTED value falls back to the sole index, so
 *  an empty-looking flag can't silently target (and delete) the wrong one. */
function resolveTarget(c: Case, explicit?: string, type?: string): { id?: string; error?: string } {
  if (explicit !== undefined) {
    const ex = explicit.trim();
    if (!ex) return { error: "a blank index id/name was given — pass a real id/name, or omit it to use the case's sole index" };
    const ref = resolveIndexRef(c, ex); // errors on an ambiguous display name
    if (ref.error) return { error: ref.error };
    return { id: ref.entry?.id ?? ex };
  }
  let cols = listIndexes(c);
  // keep `unknown` stubs in a type-filtered fallback — `add` upgrades a stub's type
  // once a target resolves, so a sole unknown stub must still match `--type face`.
  if (type) cols = cols.filter((x) => x.type === type || x.type === "unknown");
  if (cols.length === 1) return { id: cols[0].id };
  if (cols.length === 0) return { error: "no indexes in this case — create one with `overcast index create <name> --type <media|entities|face|deepface-local|image-ransac>`" };
  return { error: `multiple indexes; specify one (ids: ${cols.map((x) => x.id).join(", ")})` };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function remoteIndexId(o: Record<string, unknown>): string | undefined {
  const nested = obj(o.collection);
  return nonEmpty(o.id) ?? nonEmpty(o.collection_id) ?? nonEmpty(o.collectionId) ?? nonEmpty(nested.id);
}

function remoteIndexName(o: Record<string, unknown>): string | undefined {
  const nested = obj(o.collection);
  return nonEmpty(o.name) ?? nonEmpty(o.display_name) ?? nonEmpty(o.title) ?? nonEmpty(nested.name);
}

function remoteIndexType(o: Record<string, unknown>): string | undefined {
  const nested = obj(o.collection);
  const raw =
    nonEmpty(o.type) ??
    nonEmpty(o.collection_type) ??
    nonEmpty(o.collectionType) ??
    nonEmpty(nested.type) ??
    nonEmpty(nested.collection_type);
  return raw ? (normalizeIndexType(raw) ?? raw) : undefined;
}

function remoteListItems(rec: OvercastRecord): Record<string, unknown>[] {
  const p = obj(rec.payload);
  const d = obj(p.detailed);
  const vals = Array.isArray(p.indexes)
    ? p.indexes
    : Array.isArray(p.collections)
      ? p.collections
      : Array.isArray(d.collections)
        ? d.collections
        : Array.isArray(d.items)
          ? d.items
          : [];
  return vals.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

function remoteFiles(rec: OvercastRecord): Record<string, unknown>[] {
  const p = obj(rec.payload);
  const d = obj(p.detailed);
  const vals = Array.isArray(p.files)
    ? p.files
    : Array.isArray(d.files)
      ? d.files
      : Array.isArray(obj(d.collection).files)
        ? obj(d.collection).files as unknown[]
        : [];
  return vals.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

function remoteFileRef(f: Record<string, unknown>): string | undefined {
  return (
    nonEmpty(f.ref) ??
    nonEmpty(f.file) ??
    nonEmpty(f.filename) ??
    nonEmpty(f.name) ??
    nonEmpty(f.path) ??
    nonEmpty(f.url) ??
    nonEmpty(f.file_id) ??
    nonEmpty(f.fileId) ??
    nonEmpty(f.id)
  );
}

export const indexVerb: VerbSpec = {
  name: "index",
  group: "osint",
  summary: "Manage tinycloud indexes that index a target's videos (create/attach/add/list/show/delete/remove/entities).",
  description:
    "An index is a Cloudglue-backed searchable corpus of videos, searched one way per TYPE: media-descriptions " +
    "(ask/probe), entities (same-schema extraction), face-analysis (detect + find a person). " +
    "`create <name> --type <media|entities|face>` (entities needs --prompt/--schema); `attach <remote-id-or-name>` " +
    "mirrors an existing remote index into this case; `add <video> --to <id>` " +
    "registers a video (a path, URL, or a case record id) — `--all` registers every video the case has " +
    "captured or sensed (watch/listen/face) for the target; `list`/`show <id>` inspect; `delete <id>`/`remove <video> --from <id>` " +
    "prune; `entities <id> <video>` fetches a video's extracted entities. Then read with `ask --index " +
    "<id>`, `face --match … --index <id>`, or `index entities`. Backed by tinycloud (≥ 0.3.4).",
  args: [
    { name: "action", summary: VALID_ACTIONS.join(" | "), required: true },
    { name: "arg", summary: "name (create) · remote id/name (attach) · video/record-id (add/remove) · index id (show/delete/entities)", required: false },
    // `entities <id> <video>` needs a SECOND positional — declared so the pi
    // AgentTool surface (which rebuilds positionals strictly from spec.args) can
    // supply it, not just the raw CLI/slash parsers. Mirrors setup's action/a/b.
    { name: "arg2", summary: "entities: the video/record-id (index entities <id> <video>)", required: false },
  ],
  flags: [
    { name: "type", summary: "create/attach: media-descriptions | entities | face-analysis | rich-transcripts | deepface-local | image-ransac", type: "string" },
    { name: "local", summary: "create a local index instead of a tinycloud-backed index", type: "boolean" },
    { name: "description", summary: "create: human description", type: "string" },
    { name: "prompt", summary: "create entities: free-text extraction prompt", type: "string" },
    { name: "schema", summary: "create entities: path to a JSON schema file", type: "string" },
    { name: "to", summary: "add: target index id/name", type: "string" },
    { name: "from", summary: "remove: index id/name to remove the video from", type: "string" },
    { name: "all", summary: "add: register every video the case has captured or sensed (watch/listen/face)", type: "boolean" },
    { name: "remote", summary: "list: also query tinycloud for all account indexes", type: "boolean" },
    { name: "no-upload", summary: "add: don't upload (use an already-uploaded source)", type: "boolean" },
    { name: "no-download", summary: "add: don't materialize the source locally", type: "boolean" },
    { name: "limit", summary: "entities: max entities", type: "number" },
    { name: "offset", summary: "entities: entity offset", type: "number" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "index",
  providerKey: "index",
  run: async (ctx) => {
    const c = ctx.case;
    const action = ctx.input;
    const env = providerEnv(c.mediaDir);
    // honor a pinned tinycloud in the profile (`setup provider index
    // "/path/to/tinycloud …"`) the same way `face` honors its binding — else
    // OVERCAST_TINYCLOUD_CMD / `tinycloud` on PATH (via tinycloudBase).
    const base = tinycloudBaseFromRun(ctx.profile.providers?.index?.run ?? ctx.profile.providers?.collection?.run);
    const tcOpts = { env, signal: ctx.signal, base };

    if (action && !VALID_ACTIONS.includes(action)) {
      return [err(`unknown index action '${action}' (expected ${VALID_ACTIONS.join(" | ")})`)];
    }

    // ---- create ----
    if (action === "create") {
      const name = ctx.rest[0]?.trim();
      if (!name) return [err("usage: index create <name> --type <media-descriptions|entities|face-analysis>")];
      // `!= null` so a provided-but-empty `--type=` flows to normalizeIndexType
      // (→ unknown-type error) instead of silently defaulting like an omitted flag.
      const rawType = ctx.opts.type != null ? String(ctx.opts.type) : "media-descriptions";
      const type = normalizeIndexType(rawType);
      if (!type) {
        return [err(`unknown --type '${rawType}' (expected media-descriptions | entities | face-analysis | rich-transcripts | deepface-local | image-ransac)`)];
      }
      const local = ctx.opts.local === true || LOCAL_INDEX_TYPES.has(type);
      if (ctx.opts.local === true && !LOCAL_INDEX_TYPES.has(type)) {
        return [err(`--local only supports deepface-local or image-ransac indexes (got ${type})`)];
      }
      // reject a provided-but-blank text/path flag (a typo) — sweep all of create's
      // value flags together, so a blank `--schema=`/`--prompt=`/`--description=`
      // gives a clear error instead of falling through (the generic "needs prompt
      // or schema", or a silently-dropped description).
      for (const f of ["prompt", "schema", "description"] as const) {
        if (ctx.opts[f] != null && !String(ctx.opts[f]).trim()) {
          return [err(`--${f} requires a ${f === "schema" ? "path to a JSON schema file" : "value"}`)];
        }
      }
      const prompt = ctx.opts.prompt != null ? String(ctx.opts.prompt) : undefined;
      const schema = ctx.opts.schema != null ? String(ctx.opts.schema) : undefined;
      const description = ctx.opts.description != null ? String(ctx.opts.description) : undefined;
      if (type === "entities" && !prompt && !schema) {
        return [err("an entities index needs --prompt <text> or --schema <file> (the schema to extract from every video)")];
      }
      if (schema && !existsSync(schema)) return [err(`--schema file not found: ${schema}`)];
      if (local) {
        const id = `local_${type.replace(/-/g, "_")}_${randomBytes(4).toString("hex")}`;
        mkdirSync(localIndexDir(c, id), { recursive: true });
        const entry = addIndex(c, { id, type, name, description, backend: "local" });
        return [makeRecord({
          verb: "index",
          format: "json",
          payload: {
            op: "create",
            summary: `created local ${type} index '${name}'`,
            index: entry.id,
            name: entry.name,
            type: entry.type,
            backend: "local",
            path: localIndexDir(c, id),
          },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        })];
      }
      const { rec, id } = await tcCollectionCreate(name, type, { ...tcOpts, description, prompt, schema });
      // mirror an accepted create (ready OR an async pending that still returned
      // a real id) so the create→add-by-name flow works; a cred gap / error has no id.
      if (id && accepted(rec)) addIndex(c, { id, type, name, description: ctx.opts.description ? String(ctx.opts.description) : undefined, backend: "tinycloud" });
      rec.meta = { ...rec.meta, case: c.dir };
      return [indexRecord(rec)];
    }

    // ---- attach ----
    if (action === "attach") {
      const requested = ctx.rest[0]?.trim();
      if (!requested) return [err("usage: index attach <remote-index-id-or-name> [--type <media|entities|face>]")];
      const typeHint = ctx.opts.type != null ? normalizeIndexType(String(ctx.opts.type)) : undefined;
      if (ctx.opts.type != null && !typeHint) {
        return [err(`unknown --type '${ctx.opts.type}' (expected media-descriptions | entities | face-analysis | rich-transcripts | deepface-local | image-ransac)`)];
      }
      if (typeHint && LOCAL_INDEX_TYPES.has(typeHint)) {
        return [err(`index attach: ${typeHint} is local-only; create it with \`index create <name> --type ${typeHint} --local\``)];
      }

      let remoteId = requested;
      let remoteName: string | undefined;
      let remoteType: string | undefined;
      const local = findIndex(c, requested);
      if (local) {
        if (isLocalIndex(local)) {
          return [err(`index attach: index '${requested}' is local; local visual indexes cannot be attached from tinycloud`)];
        }
        remoteId = local.id;
        remoteName = local.name;
        remoteType = local.type;
      } else {
        const listed = await tcCollectionList(tcOpts);
        const matches = remoteListItems(listed.rec).filter((item) => {
          const id = remoteIndexId(item);
          const name = remoteIndexName(item);
          return id === requested || name === requested;
        });
        if (matches.length > 1) {
          return [err(`remote index name '${requested}' is ambiguous; use one of: ${matches.map((m) => remoteIndexId(m)).filter(Boolean).join(", ")}`)];
        }
        if (matches.length === 1) {
          remoteId = remoteIndexId(matches[0]) ?? requested;
          remoteName = remoteIndexName(matches[0]);
          remoteType = remoteIndexType(matches[0]);
        }
      }

      const { rec: shown } = await tcCollectionShow(remoteId, tcOpts);
      if (shown.state === "error" || shown.state === "needs_credentials") {
        shown.meta = { ...shown.meta, case: c.dir };
        return [indexRecord(shown)];
      }
      const shownPayload = obj(shown.payload);
      const shownDetailed = obj(shownPayload.detailed);
      const shownCollection = obj(shownDetailed.collection);
      remoteName = remoteName ?? remoteIndexName(shownPayload) ?? remoteIndexName(shownDetailed) ?? remoteIndexName(shownCollection) ?? remoteId;
      remoteType = remoteType ?? remoteIndexType(shownPayload) ?? remoteIndexType(shownDetailed) ?? remoteIndexType(shownCollection) ?? typeHint;
      if (typeHint && remoteType && remoteType !== "unknown" && remoteType !== typeHint) {
        return [err(`index attach: --type ${typeHint} conflicts with remote index type '${remoteType}'`)];
      }
      const type = typeHint ?? remoteType ?? "unknown";
      const entry = addIndex(c, { id: remoteId, type, name: remoteName ?? remoteId });
      const files = remoteFiles(shown);
      const members = files.flatMap((f) => {
        const ref = remoteFileRef(f);
        return ref ? [{ ref, fileId: nonEmpty(f.file_id) ?? nonEmpty(f.fileId) ?? nonEmpty(f.id) }] : [];
      });
      setMembers(c, remoteId, members);
      return [makeRecord({
        verb: "index",
        format: "json",
        payload: {
          op: "attach",
          summary: `attached ${type} index '${entry.name}' (${files.length} remote file${files.length === 1 ? "" : "s"})`,
          index: entry.id,
          name: entry.name,
          type: entry.type,
          files: files.length,
          member_count: listIndexes(c).find((x) => x.id === remoteId)?.members.length ?? entry.members.length,
          detailed: shownPayload.detailed,
        },
        meta: { provider: "tinycloud", model: "cloudglue", op: "attach", case: c.dir },
        state: "ready",
      })];
    }

    // ---- add ----
    if (action === "add") {
      // `add` targets with --to; --from is `remove`'s flag. Reject it rather than
      // ignoring it and falling back to the sole index (wrong target).
      if (ctx.opts.from != null) return [err("index add targets with --to, not --from")];
      const typeHint = ctx.opts.type != null ? normalizeIndexType(String(ctx.opts.type)) : undefined;
      // a typo'd OR empty --type must error here (like `create`), not be silently
      // dropped — otherwise the stub stays "unknown" and face auto-pick/type guards
      // confuse later. `!= null` catches a provided-but-empty `--type=`.
      if (ctx.opts.type != null && !typeHint) {
        return [err(`unknown --type '${ctx.opts.type}' (expected media-descriptions | entities | face-analysis | rich-transcripts)`)];
      }
      // `!= null` (not truthy) so a provided-but-empty `--to=` reaches resolveTarget
      // as a blank value it rejects, rather than being treated as omitted (→ sole).
      const target = resolveTarget(c, ctx.opts.to != null ? String(ctx.opts.to) : undefined, typeHint);
      if (target.error) return [err(`index add: ${target.error}`)];
      const id = target.id!;
      // Ensure the target is in the local mirror — it may have been created
      // outside this case and referenced only by id. Without this, addMember
      // no-ops (index absent) and `add --all` re-adds the same videos every
      // run. Record the --type hint when given so face auto-resolution can find
      // it; otherwise "unknown" (face --match falls back to those candidates).
      const existing = findIndex(c, id);
      const hintedLocal = typeHint ? LOCAL_INDEX_TYPES.has(typeHint) : false;
      // a --type hint that CONTRADICTS the target's known type is a mistake, not a
      // silent no-op — reject it so the video isn't indexed into the wrong type.
      if (existing && typeHint && existing.type !== "unknown" && existing.type !== typeHint) {
        return [err(`index add: --type ${typeHint} conflicts with index ${id}'s type '${existing.type}' — omit --type, or target a ${typeHint} index`)];
      }
      if (existing && hintedLocal && existing.backend !== "local" && (existing.backend !== undefined || existing.members.length > 0)) {
        return [err(`index add: index ${id} is not a local visual index; create a local ${typeHint} index first, or choose an empty target`)];
      }
      if (!existing) {
        addIndex(c, { id, type: typeHint ?? "unknown", name: id, backend: hintedLocal ? "local" : undefined });
      } else if (typeHint && existing.type === "unknown") {
        // a later `add --type face` classifies a previously-unknown stub (addIndex upserts).
        addIndex(c, { id, type: typeHint, name: existing.name, description: existing.description, backend: hintedLocal ? "local" : existing.backend });
      }
      const targetEntry = findIndex(c, id);
      if (targetEntry && isLocalIndex(targetEntry)) {
        if (ctx.opts["no-upload"] === true || ctx.opts["no-download"] === true) {
          return [err("index add: --no-upload/--no-download only apply to tinycloud indexes")];
        }
        if (ctx.opts.all === true) {
          const imageTargets = c.records()
            .filter((r) => r.media?.ref && /\.(jpe?g|png|webp|bmp|tiff?|gif|avif|heic)$/i.test(r.media.ref.replace(/[?#].*$/, "")))
            .map((r) => ({ ref: r.media!.ref!, recordId: r.id }));
          const seen = new Set(targetEntry.members.map((m) => m.ref));
          const refs = imageTargets.filter((m) => !seen.has(m.ref));
          if (!refs.length) return [err("index add --all: no new image records to register in the local index")];
          for (const m of refs) addMember(c, id, m);
          mkdirSync(localIndexDir(c, id), { recursive: true });
          return [makeRecord({
            verb: "index",
            format: "json",
            payload: { op: "add", index: id, backend: "local", files: refs.map((r) => r.ref), count: refs.length },
            meta: { provider: "local", case: c.dir },
            state: "ready",
          })];
        }
        const arg = ctx.rest[0];
        if (!arg) return [err("usage: index add <image|record-id> --to <local-index>")];
        if (targetEntry.type !== "deepface-local" && targetEntry.type !== "image-ransac") {
          return [err(`index add: local index ${id} has unsupported type '${targetEntry.type}'`)];
        }
        const img = resolveImageArg(c, arg, "index add");
        if (img.error) return [err(img.error)];
        if (targetEntry.members.some((m) => m.ref === img.ref)) {
          return [makeRecord({ verb: "index", format: "json", payload: { op: "add", index: id, file: img.ref, backend: "local", already_member: true }, media: { ref: img.ref! }, meta: { case: c.dir }, state: "ready" })];
        }
        mkdirSync(localIndexDir(c, id), { recursive: true });
        addMember(c, id, { ref: img.ref!, recordId: img.recordId });
        return [makeRecord({
          verb: "index",
          format: "json",
          payload: { op: "add", index: id, file: img.ref, backend: "local", summary: `added image to local ${targetEntry.type} index` },
          media: { ref: img.ref! },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        })];
      }
      const addOpts = {
        ...tcOpts,
        noUpload: ctx.opts["no-upload"] === true,
        noDownload: ctx.opts["no-download"] === true,
      };

      // --all: register every captured/sensed video not already a member.
      if (ctx.opts.all === true) {
        // --all reads the whole case, not a positional — a stray video arg is a
        // mistake (it would be silently ignored if other videos exist).
        if (ctx.rest[0]) return [err("index add: --all registers every case video — drop the positional video, or omit --all to add just that one")];
        const col = findIndex(c, id);
        const members = new Set(col?.members.map((m) => m.ref) ?? []);
        const vids = caseVideoRefs(c).filter((v) => !members.has(v.ref));
        if (vids.length === 0) {
          // caseVideoRefs only returns READY media not already a member — so when
          // it's empty, distinguish "still processing" and "sensing failed" from a
          // genuinely empty case (same accounting predicate, so a face-search query
          // image is never miscounted as a pending/failed video).
          const unregistered = c
            .records()
            .filter((r) => isRegisterableMediaRecord(r) && !members.has(r.media!.ref!));
          const pending = unregistered.filter((r) => r.state === "pending").length;
          const failed = unregistered.filter((r) => r.state !== "pending" && !isReady(r)).length;
          return [err(
            pending > 0
              ? `index add --all: ${pending} video(s) still processing (pending) — rerun once they're ready`
              : failed > 0
                ? `index add --all: ${failed} video(s) failed to sense (state=error/needs_credentials) — re-run the sense, then --all`
                : "index add --all: no new captured/sensed videos to register",
          )];
        }
        const recs: OvercastRecord[] = [];
        for (const v of vids) {
          const watched = await ensureLocalWatchRecord(ctx, v.ref);
          const { rec } = await tcCollectionAdd(v.ref, id, addOpts);
          if (accepted(rec)) addMember(c, id, { ref: v.ref, recordId: v.recordId });
          rec.meta = { ...rec.meta, case: c.dir };
          recs.push(indexRecord(rec));
          if (watched) recs.push(watched);
        }
        return recs;
      }

      const arg = ctx.rest[0];
      if (!arg) return [err("usage: index add <video|record-id> --to <id> (or --all)")];
      const v = resolveVideoArg(c, arg, "index add");
      if (v.error) return [err(v.error)];
      const ref = v.ref!;
      // dedupe like `--all` (which filters existing members) — don't re-submit a
      // video already in the index to tinycloud.
      if (findIndex(c, id)?.members.some((m) => m.ref === ref)) {
        return [makeRecord({ verb: "index", format: "json", payload: { op: "add", index: id, file: ref, already_member: true }, meta: { case: c.dir }, state: "ready" })];
      }
      const watched = await ensureLocalWatchRecord(ctx, ref);
      const { rec } = await tcCollectionAdd(ref, id, addOpts);
      if (accepted(rec)) addMember(c, id, { ref, recordId: v.recordId });
      rec.meta = { ...rec.meta, case: c.dir };
      return watched ? [indexRecord(rec), watched] : [indexRecord(rec)];
    }

    // ---- list ----
    if (action === "list" || action === undefined) {
      const mirror = listIndexes(c).map((x) => ({ id: x.id, type: x.type, backend: x.backend ?? "tinycloud", name: x.name, members: x.members.length }));
      if (ctx.opts.remote === true) {
        const { rec } = await tcCollectionList(tcOpts);
        (rec.payload as Record<string, unknown>).mirror = mirror;
        rec.meta = { ...rec.meta, case: c.dir };
        return [indexRecord(rec)];
      }
      return [makeRecord({ verb: "index", format: "json", payload: { op: "list", indexes: mirror, count: mirror.length }, meta: { case: c.dir }, state: "ready" })];
    }

    // ---- show ----
    if (action === "show") {
      const stray = strayTargetFlag(ctx);
      if (stray) return [err(`index show takes a positional id: \`index show <id>\` (saw ${stray}, which doesn't apply here)`)];
      const target = resolveTarget(c, ctx.rest[0]);
      if (target.error) return [err(`index show: ${target.error}`)];
      const local = findIndex(c, target.id!);
      if (local && isLocalIndex(local)) {
        return [makeRecord({
          verb: "index",
          format: "json",
          payload: {
            op: "show",
            index: local.id,
            name: local.name,
            type: local.type,
            backend: local.backend ?? "local",
            path: localIndexDir(c, local.id),
            members: local.members,
            member_count: local.members.length,
          },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        })];
      }
      const { rec } = await tcCollectionShow(target.id!, tcOpts);
      rec.meta = { ...rec.meta, case: c.dir };
      return [indexRecord(rec)];
    }

    // ---- delete ----
    if (action === "delete") {
      // guard the destructive op: a misused --to/--from with no positional must not
      // silently delete the case's sole index.
      const stray = strayTargetFlag(ctx);
      if (stray) return [err(`index delete takes a positional id: \`index delete <id>\` (saw ${stray}, which doesn't apply here)`)];
      // delete requires an EXPLICIT id — unlike show, it must never fall back to the
      // case's sole index (a bare `index delete` would be silent data loss).
      if (!ctx.rest[0]) return [err("usage: index delete <id> (an explicit id is required — delete won't default to your only index)")];
      const target = resolveTarget(c, ctx.rest[0]);
      if (target.error) return [err(`index delete: ${target.error}`)];
      const local = findIndex(c, target.id!);
      if (local && isLocalIndex(local)) {
        removeIndex(c, target.id!);
        rmSync(localIndexDir(c, target.id!), { recursive: true, force: true });
        return [makeRecord({
          verb: "index",
          format: "json",
          payload: { op: "delete", index: target.id, backend: "local", deleted: true },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        })];
      }
      const { rec } = await tcCollectionDelete(target.id!, tcOpts);
      if (accepted(rec)) removeIndex(c, target.id!);
      rec.meta = { ...rec.meta, case: c.dir };
      return [indexRecord(rec)];
    }

    // ---- remove ----
    if (action === "remove") {
      // `remove` targets with --from; --to is `add`'s flag. Reject it rather than
      // ignoring it and falling back to the sole index (wrong target).
      if (ctx.opts.to != null) return [err("index remove targets with --from, not --to")];
      const arg = ctx.rest[0];
      if (!arg) return [err("usage: index remove <video|record-id> --from <id>")];
      const from = resolveTarget(c, ctx.opts.from != null ? String(ctx.opts.from) : undefined);
      if (from.error) return [err(`index remove: ${from.error}`)];
      const local = findIndex(c, from.id!);
      if (local && isLocalIndex(local)) {
        const img = resolveImageArg(c, arg, "index remove", { requireExists: false, requireReady: false });
        if (img.error) return [err(img.error)];
        const removed = removeMember(c, from.id!, img.ref!);
        return [makeRecord({
          verb: "index",
          format: "json",
          payload: { op: "remove", index: from.id, file: img.ref, backend: "local", removed },
          media: { ref: img.ref! },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        })];
      }
      // same media filters as add/entities (reject scan/face-search/non-AV refs),
      // but allow a gone local file / errored record — you should still be able to
      // un-index a video that's no longer on disk or whose sense later failed.
      const v = resolveVideoArg(c, arg, "index remove", { requireExists: false, requireReady: false });
      if (v.error) return [err(v.error)];
      const ref = v.ref!;
      const { rec } = await tcCollectionRemove(ref, from.id!, tcOpts);
      // mirror on ready OR pending (an async remove still removed the member),
      // matching how `add` tracks membership via accepted().
      if (accepted(rec)) removeMember(c, from.id!, ref);
      rec.meta = { ...rec.meta, case: c.dir };
      return [indexRecord(rec)];
    }

    // ---- entities ----
    if (action === "entities") {
      // entities takes a POSITIONAL index id; --to/--from are add/remove flags
      // and don't apply — reject them rather than silently using the positional
      // (consistent with add/remove/show/delete).
      if (ctx.opts.to != null || ctx.opts.from != null) {
        return [err("index entities takes a positional id: `index entities <id> <video>` (--to/--from don't apply here)")];
      }
      const id = ctx.rest[0]?.trim(); // trim so a blank/padded id doesn't bypass mirror lookup
      const videoArg = ctx.rest[1];
      if (!id || !videoArg) return [err("usage: index entities <index-id> <video|record-id>")];
      // validate the numeric paging flags via the SHARED validator (matches face/ask)
      // — it also rejects a blank `--offset=`, which the old inline `n < 0` check let
      // through as 0 (Number("") === 0).
      const numErr =
        badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number") ??
        badNumber(ctx.opts, "offset", (n) => n >= 0, "a non-negative number");
      if (numErr) return [err(`index entities: ${numErr}`)];
      const limit = numFlag(ctx.opts, "limit");
      const offset = numFlag(ctx.opts, "offset");
      // resolve the index id, surfacing an ambiguous-name error (like ask/add)
      // and rejecting a mirrored index whose type isn't entities (entities are
      // only readable from an entities index), consistent with ask/face.
      const colRef = resolveIndexRef(c, id);
      if (colRef.error) return [err(`index entities: ${colRef.error}`)];
      const colEntry = colRef.entry;
      if (colEntry && colEntry.type !== "entities" && colEntry.type !== "unknown") {
        return [err(`index ${colEntry.id} is type '${colEntry.type}', not entities — \`index entities\` only reads entities indexes`)];
      }
      const colId = colEntry?.id ?? id;
      // same media filters as `add` (reject scan/face-search/non-AV refs), but
      // requireExists:false — entities reads PRE-EXTRACTED data for a video already
      // indexed remotely, so its local file may be gone (matches `remove`).
      const v = resolveVideoArg(c, videoArg, "index entities", { requireExists: false, requireReady: false });
      if (v.error) return [err(v.error)];
      const { rec } = await tcCollectionEntities(colId, v.ref!, { ...tcOpts, limit, offset });
      rec.meta = { ...rec.meta, case: c.dir };
      return [indexRecord(rec)];
    }

    return [err(`usage: index <${VALID_ACTIONS.join("|")}>`)];
  },
};
