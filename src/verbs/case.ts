// `case` verb — inspect/manage the current case (the .overcast/ store). Case is
// a folder (invariant #4); this is the read/seed surface over it + the bound
// memory providers. Subcommands: init | info | records | memory.

import { makeRecord, type OvercastRecord } from "../record.js";
import { openCase } from "../case.js";
import { resolveMemory } from "../providers/memory/index.js";
import { parseSince } from "../providers/memory/local.js";
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
    "`case memory <list|get|search> [q]` routes to the bound memory providers.",
  args: [
    { name: "action", summary: "init | info | records | memory", required: true },
    { name: "arg", summary: "dir (init), record id (memory get), or query (memory search)" },
  ],
  flags: [
    { name: "name", summary: "Case name (init)", type: "string" },
    { name: "verb", summary: "Filter records by kind", type: "string" },
    { name: "since", summary: "Time filter (e.g. 24h, 2026-06-01)", type: "string" },
    { name: "limit", summary: "Max records/passages", type: "number" },
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
        if (!id) return [err("case memory get <record-id>")];
        const rec = ctx.case.recordById(id);
        return [makeRecord({ verb: "case", format: "json", payload: { record: rec ?? null }, state: rec ? "ready" : "error", error: rec ? undefined : `no record ${id}` })];
      }
      if (sub === "search") {
        const q = ctx.rest.slice(1).join(" ");
        if (!q) return [err("case memory search <query>")];
        const passages = await providers[0].query(q, { limit: ctx.opts.limit != null ? Number(ctx.opts.limit) : 8 });
        return [makeRecord({ verb: "case", format: "json", payload: { query: q, passages }, state: "ready" })];
      }
      return [err("usage: case memory <list|get|search> [arg]")];
    }

    return [err("usage: case <init|info|records|memory>")];
  },
};
