// ---- graph (case knowledge graph) --------------------------------------------
// "Connect the dots": build a knowledge graph over the case's records —
// records/media/targets/findings/people/devices/places + regex-harvested typed
// entities — and render it as one self-contained interactive HTML viewer.
// Model/rendering live in src/signals/graph.ts + src/report/graph.ts; this verb
// owns validation, the optional --extract brain pass, the file write, and
// launching — mirroring `map` (verbs/map.ts).

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeRecord, errRecord, type OvercastRecord } from "../record.js";
import { openHtmlPlayer } from "../media/view.js";
import { normalizeHtmlTheme } from "../report/html.js";
import { buildGraphModel } from "../signals/graph.js";
import { renderGraphHtml } from "../report/graph.js";
import { mergeExtractions, runExtraction, extractCachePath, type MergedExtraction } from "../providers/brain/extract.js";
import { parseSince } from "../providers/memory/local.js";
import { listTargets } from "../state/target.js";
import type { VerbSpec } from "../registry/types.js";

// Sentinel default: an unset --export resolves against the case's mediaDir (like
// map.html / wall.html), NOT the cwd.
const GRAPH_DEFAULT_EXPORT = ".overcast/media/graph.html";

const err = (message: string): OvercastRecord => errRecord("graph", message);

export const graphVerb: VerbSpec = {
  name: "graph",
  group: "inspect",
  summary: "Build the case knowledge graph and render it as a self-contained interactive HTML viewer.",
  description:
    "Connects the dots across the case: evidence records (the same ask/brief evidence boundary), shared media, " +
    "targets (lines of investigation), accepted/open findings, cluster people, camera-fingerprint devices, places " +
    "(payload.place / GPS), and typed entities harvested by conservative regex from evidence text (email, phone, " +
    "@handle, url/domain, hashtag) plus structured lifts (exif serial, scan handles/identity fields). Edges carry " +
    "provenance record ids: record↔media, finding→source/target, note→record, match-verb links (face/image/audio/" +
    "voice/similar), device membership, entity mentions, and the shared target↔evidence thread matcher. " +
    "--extract additionally runs the configured brain LLM (BYO, text-only) over evidence text for entity/relation " +
    "extraction — results cache to .overcast/graph/extract.jsonl (delete the file to re-extract) and are marked as " +
    "leads, not proof. --focus restricts to the 2-hop neighborhood of a node/record/entity; --limit trims " +
    "lowest-degree leaf entities first (never records with findings). The viewer is fully offline: inlined " +
    "hand-rolled canvas force layout, pan/zoom, per-type toggles, text filter, and a node inspector with " +
    "`overcast view` / `case memory get` command hints.",
  args: [],
  flags: [
    { name: "extract", summary: "Also run the brain LLM over evidence text for entity/relation extraction (cached)", type: "boolean" },
    { name: "since", summary: "Only evidence since (e.g. 24h, 7d, 2026-06-01)", type: "string" },
    { name: "limit", summary: "Max nodes (lowest-degree leaf entities trim first)", type: "number", default: 400 },
    { name: "focus", summary: "Restrict to the 2-hop neighborhood of a node id, record id, media ref, or entity text", type: "string" },
    { name: "export", summary: "Graph HTML path", type: "string", default: GRAPH_DEFAULT_EXPORT },
    { name: "no-open", summary: "Write the viewer but don't launch it", type: "boolean" },
    { name: "theme", summary: "HTML theme: plain | csi", type: "string", choices: ["plain", "csi"], default: "plain" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.graph",
  providerKey: "graph",
  run: async (ctx) => {
    const theme = normalizeHtmlTheme(ctx.opts.theme);
    if (!theme) return [err(`invalid --theme '${ctx.opts.theme}' (expected plain or csi)`)];
    let limit = 400;
    if (ctx.opts.limit != null) {
      const n = Number(ctx.opts.limit);
      if (!Number.isFinite(n) || n <= 0) return [err(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`)];
      limit = Math.floor(n);
    }
    let sinceCutoff: number | undefined;
    if (ctx.opts.since != null) {
      const cutoff = parseSince(String(ctx.opts.since));
      if (cutoff == null) return [err(`invalid --since: ${ctx.opts.since} (try 24h, 7d, or 2026-06-01)`)];
      sinceCutoff = cutoff;
    }
    const focus = ctx.opts.focus != null ? String(ctx.opts.focus).trim() : undefined;
    if (ctx.opts.focus != null && !focus) return [err("--focus requires a value")];
    const rawExport = ctx.opts.export != null ? String(ctx.opts.export) : GRAPH_DEFAULT_EXPORT;
    const htmlPath = rawExport === GRAPH_DEFAULT_EXPORT ? join(ctx.case.mediaDir, "graph.html") : resolve(rawExport);

    const info = ctx.case.exists() ? ctx.case.info() : { name: "case" };
    const records = ctx.case.records();
    const targets = listTargets(ctx.case);

    // optional brain pass — per-record failures degrade to a warning count; a
    // missing brain degrades to a note, never an error (the structural graph
    // still renders).
    let extraction: MergedExtraction | undefined;
    let extractStats: Record<string, unknown> | undefined;
    if (ctx.opts.extract === true) {
      const run = await runExtraction(records, { profile: ctx.profile, caseDir: ctx.case.dir, sinceCutoff, signal: ctx.signal });
      extraction = mergeExtractions(run.lines);
      extractStats = {
        extracted_records: run.ran,
        cached_records: run.cached,
        failed_records: run.failed,
        entities: extraction.entities.length,
        relations: extraction.relations.length,
        cache: extractCachePath(ctx.case.dir),
        ...(run.unavailable ? { unavailable: run.unavailable } : {}),
      };
    }

    const model = buildGraphModel(records, {
      caseName: info.name,
      caseDir: ctx.case.dir,
      targets,
      sinceCutoff,
      limit,
      focus,
      extraction,
    });

    // nothing to graph → transient pending guidance, no artifact (map precedent)
    if (model.nodes.length === 0) {
      const note =
        model.stats.evidenceRecords === 0
          ? "no evidence records in the case — sense media (`watch`/`listen`/`see`/`exif`), run scans, or add notes first"
          : focus
            ? `--focus '${focus}' matched no node — try a record id, media filename, or entity text from the unfocused graph`
            : "evidence records exist but none survived the current filter — widen or drop --since";
      return [
        makeRecord({
          verb: "graph",
          format: "json",
          payload: { mode: "graph", viewer: null, nodes: 0, edges: 0, evidence_records: model.stats.evidenceRecords, note },
          meta: { transient: true },
          state: "pending",
        }),
      ];
    }

    const noOpen = ctx.opts["no-open"] === true;
    writeFileSync(htmlPath, renderGraphHtml(model, theme), "utf8");
    if (!noOpen) openHtmlPlayer(htmlPath);

    return [
      makeRecord({
        verb: "graph",
        format: "json",
        payload: {
          mode: "graph",
          viewer: htmlPath,
          theme,
          opened: !noOpen,
          nodes: model.stats.nodes,
          edges: model.stats.edges,
          components: model.stats.components,
          by_type: model.stats.byType,
          evidence_records: model.stats.evidenceRecords,
          ...(model.stats.truncated ? { truncated_nodes: model.stats.truncated } : {}),
          ...(focus ? { focus } : {}),
          // compact, agent-readable projection (raw layout/JS stays in the HTML)
          node_list: model.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            label: n.label,
            degree: n.degree,
            ...(n.recordId ? { record_id: n.recordId } : {}),
            ...(n.entityType ? { entity_type: n.entityType } : {}),
            ...(n.extracted ? { extracted: true } : {}),
          })),
          edge_list: model.edges.map((e) => ({
            source: e.source,
            target: e.target,
            kind: e.kind,
            ...(e.label ? { label: e.label } : {}),
            ...(e.recordId ? { record_id: e.recordId } : {}),
          })),
          ...(extractStats ? { extraction: extractStats, caveat: "LLM-extracted entities/relations are leads, not proof — verify against the cited records" } : {}),
        },
        // no record-level media: a graph spans many refs (node_list carries them)
        meta: { provider: "graph", case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};
