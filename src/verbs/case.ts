// `case` verb — inspect/manage the current case (the .overcast/ store). Case is
// a folder (invariant #4); this is the read/seed surface over it + the bound
// memory providers. Subcommands: init | info | records | memory.

import { makeRecord, type OvercastRecord, type JsonMap } from "../record.js";
import { openCase } from "../case.js";
import { resolveMemory } from "../providers/memory/index.js";
import { parseSince } from "../providers/memory/local.js";
import { payloadFields } from "../render.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "case", format: "json", payload: { error: message }, error: message, state: "error" });
}

export const caseVerb: VerbSpec = {
  name: "case",
  group: "state",
  summary: "Inspect/manage the current case: init | info | records | memory.",
  description:
    "A case is the cwd folder + its .overcast/ store. `case init [dir] --name` stands it up; " +
    "`case info` shows state; `case records [--verb] [--since]` lists records; " +
    "`case memory <list|get|search> [q]` routes to the bound memory providers. " +
    "`case memory get <id>` returns a field manifest (sizes); add `--field <name> [--offset N] " +
    "[--limit M]` to page a large field (e.g. a watch `content`) in full — never head/tail the raw jsonl.",
  args: [
    { name: "action", summary: "init | info | records | memory", required: true },
    { name: "arg", summary: "dir (init), record id (memory get), or query (memory search)" },
  ],
  flags: [
    { name: "name", summary: "Case name (init)", type: "string" },
    { name: "verb", summary: "Filter records by kind", type: "string" },
    { name: "since", summary: "Time filter (e.g. 24h, 2026-06-01)", type: "string" },
    { name: "field", summary: "Payload field to read in full (memory get)", type: "string" },
    { name: "offset", summary: "Start char offset when paging a field (memory get)", type: "number" },
    { name: "limit", summary: "Max records/passages, or max chars when paging a field", type: "number" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "case",
  providerKey: "case",
  run: async (ctx) => {
    const action = ctx.input;

    if (action === "init") {
      const dir = ctx.rest[0] ?? ctx.case.dir;
      const c = openCase(dir);
      const info = c.ensure();
      if (ctx.opts.name) {
        // persist the chosen name
        const cur = c.info();
        cur.name = String(ctx.opts.name);
        const { writeFileSync } = await import("node:fs");
        writeFileSync(c.caseFile, JSON.stringify(cur, null, 2) + "\n", "utf8");
        info.name = cur.name;
      }
      // Tag the record with the case it belongs to. When `case init <dir>`
      // targets a DIFFERENT case than the active one, persist it there and tag
      // it so the framework skips writing it into the active case's timeline
      // (see the meta.case guard in cli.ts / to-agent-tool.ts).
      const rec = makeRecord({
        verb: "case",
        format: "json",
        payload: { ...info, dir: c.dir },
        meta: { case: c.dir },
        state: "ready",
      });
      if (c.dir !== ctx.case.dir) c.writeRecord(rec);
      return [rec];
    }

    if (action === "info") {
      const c = ctx.case;
      const exists = c.exists();
      const recs = c.records();
      const counts: Record<string, number> = {};
      for (const r of recs) counts[r.verb] = (counts[r.verb] ?? 0) + 1;
      return [
        makeRecord({
          verb: "case",
          format: "json",
          payload: { dir: c.dir, initialized: exists, info: exists ? c.info() : null, records: recs.length, counts },
          state: "ready",
        }),
      ];
    }

    if (action === "records") {
      let recs = ctx.case.records();
      if (ctx.opts.verb) recs = recs.filter((r) => r.verb === String(ctx.opts.verb));
      if (ctx.opts.since) {
        const cutoff = parseSince(String(ctx.opts.since));
        // an unparseable --since is a user error, not a silent "no time bound"
        if (cutoff == null) {
          return [err(`invalid --since: ${ctx.opts.since} (try 24h, 7d, or 2026-06-01)`)];
        }
        recs = recs.filter((r) => {
          const t = r.meta?.time ? Date.parse(String(r.meta.time)) : NaN;
          return Number.isNaN(t) || t >= cutoff;
        });
      }
      // a non-finite/negative --limit must not silently empty or trim the list
      let limit = 50;
      if (ctx.opts.limit != null) {
        const n = Number(ctx.opts.limit);
        if (!Number.isFinite(n) || n <= 0) {
          return [err(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`)];
        }
        limit = n;
      }
      const view = recs.slice(0, limit).map((r) => ({
        id: r.id, verb: r.verb, state: r.state ?? "ready", media: r.media?.ref ?? null,
      }));
      return [makeRecord({ verb: "case", format: "json", payload: { count: recs.length, records: view }, state: "ready" })];
    }

    if (action === "memory") {
      const sub = ctx.rest[0];
      const providers = resolveMemory(ctx.case, ctx.profile);
      if (sub === "list") {
        return [makeRecord({ verb: "case", format: "json", payload: { providers: providers.map((p) => p.id) }, state: "ready" })];
      }
      if (sub === "get") {
        const id = ctx.rest[1];
        if (!id) return [err("usage: case memory get <record-id> [--field <name>] [--offset N] [--limit M]")];
        const rec = ctx.case.recordById(id);
        if (!rec) {
          return [makeRecord({ verb: "case", format: "json", payload: { record: id, found: false }, state: "error", error: `no record ${id}` })];
        }

        const field = ctx.opts.field != null ? String(ctx.opts.field) : undefined;
        const isString = typeof rec.payload === "string";

        // No --field (object payload): return a manifest of how to read it — each
        // field's name/type/size + a short preview — so the agent knows which
        // field to page instead of guessing or dumping the whole record.
        if (field == null && !isString) {
          const fields = payloadFields(rec.payload).map((f) => ({
            name: f.name,
            type: f.type,
            size: f.size,
            ...(f.count != null ? { count: f.count } : {}),
            preview: f.preview,
          }));
          return [
            makeRecord({
              verb: "case",
              format: "json",
              payload: { record: rec.id, verb: rec.verb, state: rec.state ?? "ready", media: rec.media ?? null, fields },
              state: "ready",
            }),
          ];
        }

        // Page a single field (string payload pages directly, no --field needed).
        const value = isString ? rec.payload : (rec.payload as JsonMap)[field as string];
        if (value === undefined) {
          const names = payloadFields(rec.payload).map((f) => f.name).join(", ");
          return [err(`record ${id} has no field '${field}' (fields: ${names})`)];
        }
        const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        const total = text.length;

        let offset = 0;
        if (ctx.opts.offset != null) {
          const n = Number(ctx.opts.offset);
          if (!Number.isFinite(n) || n < 0) return [err(`invalid --offset: ${ctx.opts.offset} (expected a non-negative number)`)];
          offset = Math.min(n, total);
        }
        let limit = 16000;
        if (ctx.opts.limit != null) {
          const n = Number(ctx.opts.limit);
          if (!Number.isFinite(n) || n <= 0) return [err(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`)];
          limit = n;
        }
        const chunk = text.slice(offset, offset + limit);
        const nextOffset = offset + chunk.length;
        const hasMore = nextOffset < total;
        return [
          makeRecord({
            verb: "case",
            format: "txt",
            payload: {
              record: id,
              field: isString ? "(text)" : field,
              offset,
              limit,
              total,
              returned: chunk.length,
              has_more: hasMore,
              next_offset: hasMore ? nextOffset : null,
              chunk,
            },
            state: "ready",
          }),
        ];
      }
      if (sub === "search") {
        const q = ctx.rest.slice(1).join(" ");
        if (!q) return [err("case memory search <query>")];
        let limit = 8;
        if (ctx.opts.limit != null) {
          const n = Number(ctx.opts.limit);
          if (!Number.isFinite(n) || n <= 0) {
            return [err(`case memory search: invalid --limit '${ctx.opts.limit}' (expected a positive number)`)];
          }
          limit = n;
        }
        const passages = await providers[0].query(q, { limit });
        return [makeRecord({ verb: "case", format: "json", payload: { query: q, passages }, state: "ready" })];
      }
      return [err("usage: case memory <list|get|search> [arg]")];
    }

    return [err("usage: case <init|info|records|memory>")];
  },
};
