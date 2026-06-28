// `case` verb — inspect/manage the current case (the .overcast/ store). Case is
// a folder (invariant #4); this is the read/seed surface over it + the bound
// memory providers. Subcommands: init | info | records | memory | clear.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRecord, type OvercastRecord } from "../record.js";
import { openCase } from "../case.js";
import { humanSize } from "../render.js";
import { matchesMemoryProvider, resolveMemory } from "../providers/memory/index.js";
import { parseSince } from "../providers/memory/local.js";
import { payloadFields, fieldText, fieldNames, getField } from "../render.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "case", format: "json", payload: { error: message }, error: message, state: "error" });
}

export const caseVerb: VerbSpec = {
  name: "case",
  group: "state",
  summary: "Inspect/manage the current case: init | info | records | memory | clear.",
  description:
    "A case is the cwd folder + its .overcast/ store. `case init [dir] --name` stands it up; " +
    "`case info` shows state; `case records [--verb] [--since]` lists records; " +
    "`case memory <list|get|search|index> [q]` routes to the bound memory providers. " +
    "`case clear` previews what would be lost; add `--yes` to clear records/media/state while preserving the case id. " +
    "`case memory get <id>` returns a field manifest (sizes); add `--field <name> [--offset N] " +
    "[--limit M]` to page a large field (e.g. a watch `content`) in full — never head/tail the raw jsonl.",
  args: [
    { name: "action", summary: "init | info | records | memory | clear", required: true },
    { name: "sub", summary: "memory subcommand (list|get|search), or dir for init" },
    { name: "arg", summary: "record id (memory get), query (memory search), or index action" },
  ],
  flags: [
    { name: "name", summary: "Case name (init)", type: "string" },
    { name: "verb", summary: "Filter records by kind", type: "string" },
    { name: "since", summary: "Time filter (e.g. 24h, 2026-06-01)", type: "string" },
    { name: "field", summary: "Payload field to read in full (memory get)", type: "string" },
    { name: "offset", summary: "Start char offset when paging a field (memory get)", type: "number" },
    { name: "limit", summary: "Max records/passages, or max chars when paging a field", type: "number" },
    { name: "memory", summary: "Memory provider/backend for case memory index (e.g. local-grep, qmd)", type: "string" },
    { name: "yes", summary: "Confirm destructive case clear", type: "boolean" },
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

    if (action === "clear") {
      const confirmed = ctx.opts.yes === true;
      const before = confirmed ? ctx.case.clear() : ctx.case.clearSummary();
      const lost = {
        records: before.records,
        counts: before.counts,
        media_files: before.media.files,
        media_size: humanSize(before.media.bytes),
        index_files: before.index.files,
        index_size: humanSize(before.index.bytes),
        state_files: before.stateFiles,
      };
      if (!confirmed) {
        return [
          makeRecord({
            verb: "case",
            format: "json",
            payload: {
              dir: before.dir,
              initialized: before.initialized,
              info: before.info,
              will_lose: lost,
              confirmation_required: true,
              confirm_with: "overcast case clear --yes",
              note: "case id/name are preserved; records, media, indexes, targets, sources, and seen state are cleared",
            },
            meta: { transient: true },
            state: "pending",
          }),
        ];
      }
      return [
        makeRecord({
          verb: "case",
          format: "json",
          payload: {
            dir: before.dir,
            initialized: before.initialized,
            info: before.info,
            cleared: true,
            lost,
            preserved: ["case.json"],
          },
          meta: { transient: true },
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
        return [makeRecord({
          verb: "case",
          format: "json",
          payload: {
            providers: providers.map((p) => ({
              id: p.id,
              backend: p.backend ?? p.id,
              aliases: p.aliases ?? [],
              indexable: !!p.rebuild,
            })),
          },
          state: "ready",
        })];
      }
      if (sub === "get") {
        const id = ctx.rest[1];
        if (!id) return [err("usage: case memory get <record-id> [--field <name>] [--offset N] [--limit M]")];
        const rec = ctx.case.recordById(id);
        if (!rec) {
          // records are per-case — a record saved in one case isn't visible from
          // another. Name the current case so a wrong-cwd lookup is obvious (the
          // common footgun: `cd`-ing elsewhere before re-reading a record).
          const msg = `no record ${id} in this case (${ctx.case.dir}) — records are per-case; cd back to the case you ran it in, or pass --case <dir>`;
          return [makeRecord({ verb: "case", format: "json", payload: { record: id, found: false, case: ctx.case.dir }, state: "error", error: msg })];
        }

        // A record's payload is a set of named fields — object keys, or the single
        // implicit "(text)" for a string payload. String and object travel the
        // SAME path from here (no isString branches): enumerate via fieldNames,
        // address via getField, measure/slice via fieldText.
        const field = ctx.opts.field != null ? String(ctx.opts.field) : undefined;
        const hasPaging = ctx.opts.offset != null || ctx.opts.limit != null;
        const names = fieldNames(rec.payload);

        // Bare `get <id>` (no --field, no paging flags) → a field manifest of how
        // to read the record — name/type/size + chars (the unit paging counts in).
        if (field == null && !hasPaging) {
          const fields = payloadFields(rec.payload).map((f) => ({
            name: f.name,
            type: f.type,
            size: f.size,
            chars: f.chars,
            ...(f.count != null ? { count: f.count } : {}),
            preview: f.preview,
          }));
          return [
            makeRecord({
              verb: "case",
              format: "json",
              payload: { record: rec.id, verb: rec.verb, state: rec.state ?? "ready", media: rec.media ?? null, fields },
              // a preview of this envelope points paging at the TARGET record
              meta: { pageTarget: rec.id },
              state: "ready",
            }),
          ];
        }

        // Resolve the field to page. Omitting --field is only unambiguous when the
        // record has exactly one field (a string payload's "(text)"); a multi-field
        // object payload needs --field, so --offset/--limit can't silently no-op.
        let target = field;
        if (target == null) {
          if (names.length === 1) target = names[0];
          else return [err(`case memory get ${id}: --field <name> required to page an object payload (fields: ${names.join(", ")})`)];
        }
        const value = getField(rec.payload, target);
        if (value === undefined) {
          return [err(`record ${id} has no field '${target}' (fields: ${names.join(", ")})`)];
        }
        // same canonical text the manifest measured (guarded; never throws)
        const text = fieldText(value);
        const total = text.length;

        let offset = 0;
        if (ctx.opts.offset != null) {
          const n = Number(ctx.opts.offset);
          if (!Number.isFinite(n) || n < 0) return [err(`invalid --offset: ${ctx.opts.offset} (expected a non-negative number)`)];
          // an overshoot must NOT silently clamp to the end (looks like a clean
          // end-of-field and can stop paging before earlier ranges were read).
          if (n > total) return [err(`--offset ${n} is past the end of field '${target}' (${total} chars)`)];
          offset = n;
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
              field: target,
              offset,
              limit,
              total,
              returned: chunk.length,
              has_more: hasMore,
              next_offset: hasMore ? nextOffset : null,
              chunk,
            },
            meta: { pageTarget: id },
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
      if (sub === "index") {
        const action = ctx.rest[1] ?? "status";
        const providerName = ctx.opts.memory ? String(ctx.opts.memory) : undefined;
        const selected = providerName
          ? providers.filter((p) => matchesMemoryProvider(p, providerName))
          : providers;
        if (providerName && selected.length === 0) {
          return [err(`no memory provider matches --memory ${providerName} (available: ${providers.map((p) => p.id).join(", ")})`)];
        }
        if (action === "status") {
          const statuses = [];
          for (const p of selected) {
            statuses.push(p.status ? await p.status() : { provider: p.id, backend: p.backend ?? p.id, state: "ready" });
          }
          return [makeRecord({ verb: "case", format: "json", payload: { memory_index: statuses }, state: "ready" })];
        }
        if (action === "rebuild" || action === "retry") {
          const statuses = [];
          for (const p of selected) {
            statuses.push(p.rebuild ? await p.rebuild() : { provider: p.id, backend: p.backend ?? p.id, state: "ready" });
          }
          const failed = statuses.filter((s) => s.state === "error");
          return [makeRecord({ verb: "case", format: "json", payload: { memory_index: statuses }, state: failed.length ? "error" : "ready", error: failed[0]?.error })];
        }
        if (action === "start") {
          const job = `job_${Date.now().toString(36)}`;
          const jobsDir = join(ctx.case.indexDir, "jobs");
          mkdirSync(jobsDir, { recursive: true });
          const jobFile = join(jobsDir, `${job}.json`);
          const cmd = process.env.OVERCAST_CMD ?? process.argv[1];
          const args = [
            "case", "memory", "index", "rebuild",
            "--case", ctx.case.dir,
            ...(ctx.home ? ["--home", ctx.home] : []),
            ...(ctx.profileName ? ["--profile", ctx.profileName] : []),
            ...(providerName ? ["--memory", providerName] : []),
            "--json",
          ];
          const jobPayload = { id: job, state: "queued", command: `${cmd} ${args.join(" ")}`, provider: providerName ?? "all", created: new Date().toISOString() };
          writeFileSync(jobFile, JSON.stringify(jobPayload, null, 2) + "\n", "utf8");
          try {
            const child = spawn(process.execPath, [cmd, ...args], { detached: true, stdio: "ignore", env: process.env });
            child.unref();
          } catch {
            /* status still carries the retry command */
          }
          return [makeRecord({ verb: "case", format: "json", payload: { job: jobPayload, job_file: jobFile }, state: "pending" })];
        }
        return [err("usage: case memory index <status|rebuild|start|retry> [--memory <provider>]")];
      }
      return [err("usage: case memory <list|get|search|index> [arg]")];
    }

    return [err("usage: case <init|info|records|memory|clear>")];
  },
};
