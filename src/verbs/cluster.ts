// `cluster` verb (sense): a persistent LOCAL face DB that groups detected faces
// into people ("clusters") and lets you browse them. Unlike deepface-local
// (which re-derives embeddings from curated reference images per query), a
// face-cluster index accumulates faces out of clips/images, stores their
// embeddings + provenance, and maintains cluster assignments under
// `.overcast/index/<id>/`. Always LOCAL — the tinycloud face path returns no
// embeddings, so clustering rides exclusively on the deepface provider
// (examples/providers/visual-db/face_cluster.py).
//
//   cluster add <video|image> --index <id>   ingest: detect → embed → assign-or-create
//   cluster identify <image|video> --index <id>  most-similar person for a probe (no writes)
//   cluster list              --index <id>   the people in the DB
//   cluster show <person-id>  --index <id>   one person's member faces
//   cluster label <person-id> <name>         name a person (stable across recluster)
//   cluster recluster         --index <id>   batch re-group every stored face
//   cluster view              --index <id>   self-contained HTML contact sheet
//
// The face-cluster index is created via `index create <name> --type face-cluster
// --local`; cluster ops resolve the case's sole face-cluster index when --index
// is omitted.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeRecord, type OvercastRecord } from "../record.js";
import { runLocalCluster } from "../providers/local/vision.js";
import { indexesByType, resolveIndexRef } from "../state/index.js";
import { resolveVisualArg } from "./media-ref.js";
import { renderClusterGallery, type ClusterGalleryPerson } from "../report/html.js";
import { openHtmlPlayer } from "../media/view.js";
import { badNumber } from "./validate.js";
import type { Case } from "../case.js";
import type { VerbSpec } from "../registry/types.js";

const VALID_ACTIONS = ["add", "ingest", "identify", "list", "show", "label", "recluster", "view"];
// ops whose record isn't about a piece of media — strip the exec-runner's
// placeholder media.ref so the record stays clean.
const NON_MEDIA_OPS = new Set(["list", "show", "label", "recluster", "view"]);

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "cluster", format: "json", payload: { error: message }, error: message, state: "error" });
}

const num = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Resolve --index (or auto-pick the sole one) to a LOCAL face-cluster index id. */
function resolveClusterIndex(c: Case, flag?: string): { id?: string; error?: string } {
  if (flag !== undefined) {
    const ref = resolveIndexRef(c, flag);
    if (ref.error) return { error: ref.error };
    const entry = ref.entry;
    if (!entry) return { error: `no such index '${flag}' in this case (see \`overcast index list\`)` };
    if (entry.backend !== "local" || entry.type !== "face-cluster") {
      return { error: `index ${entry.id} is type '${entry.type}'${entry.backend === "local" ? "" : " (remote)"}, not a local face-cluster index — create one with \`index create <name> --type face-cluster --local\`` };
    }
    return { id: entry.id };
  }
  const cands = indexesByType(c, "face-cluster").filter((x) => x.backend === "local");
  if (cands.length === 1) return { id: cands[0].id };
  if (cands.length === 0) {
    return { error: "no face-cluster index in this case — create one with `overcast index create <name> --type face-cluster --local`, then `cluster add <media> --index <id>`" };
  }
  return { error: `this case has ${cands.length} face-cluster indexes; pass --index <id> (one of: ${cands.map((x) => x.id).join(", ")})` };
}

export const clusterVerb: VerbSpec = {
  name: "cluster",
  group: "sense",
  summary: "Build and browse a local face-cluster DB: group faces into people, identify, label, and view.",
  description:
    "A persistent LOCAL face database backed by the deepface provider (clustering needs face embeddings, " +
    "which the tinycloud face path doesn't expose). `cluster add <media>` detects faces, embeds them, and " +
    "ASSIGN-OR-CREATEs each into a person (nearest existing person above --min-similarity, else a new one); " +
    "`cluster identify <image|video>` surfaces the most similar person for a probe (or flags it as a likely new " +
    "person) without writing; `cluster recluster` re-groups every stored face and carries human labels " +
    "forward; `cluster list`/`show` read the DB and `cluster view` renders a self-contained HTML contact " +
    "sheet. Needs a face-cluster index (`index create <name> --type face-cluster --local`); resolves the " +
    "case's sole one when --index is omitted. Emits a `cluster` record.",
  args: [
    { name: "action", summary: VALID_ACTIONS.join(" | "), required: true },
    { name: "arg", summary: "add/identify: media (path/URL/record-id) · show/label: person id", required: false },
    { name: "arg2", summary: "label: the name to assign (cluster label <person-id> <name>)", required: false },
  ],
  flags: [
    { name: "index", summary: "face-cluster index id/name (default: the case's sole face-cluster index)", type: "string" },
    { name: "min-similarity", summary: "add/identify: assign-or-create threshold; recluster: linkage threshold (0–100)", type: "number" },
    { name: "cluster", summary: "show/label: the person id (alternative to the positional)", type: "string" },
    { name: "label", summary: "label: the name to assign (alternative to the positional)", type: "string" },
    { name: "fps", summary: "add/identify: sampling frames per second (video)", type: "number" },
    { name: "max-frames", summary: "add/identify: video frame sample count/cap", type: "number" },
    { name: "start", summary: "add/identify: window start (SS or timecode)", type: "string" },
    { name: "end", summary: "add/identify: window end (SS or timecode)", type: "string" },
    { name: "limit", summary: "list/show/identify: max results", type: "number" },
    { name: "source-record", summary: "add: the case record id the media came from", type: "string" },
    { name: "out", summary: "view: HTML output path (default: .overcast/media/cluster-<id>.html)", type: "string" },
    { name: "no-open", summary: "view: write the gallery but don't launch it", type: "boolean" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "cluster",
  providerKey: "face",
  run: async (ctx) => {
    const c = ctx.case;
    const action = ctx.input;
    if (!action) return [err(`cluster requires an action: ${VALID_ACTIONS.join(" | ")}`)];
    if (!VALID_ACTIONS.includes(action)) return [err(`unknown cluster action '${action}' (expected ${VALID_ACTIONS.join(" | ")})`)];

    const numErr =
      badNumber(ctx.opts, "min-similarity", (n) => n >= 0 && n <= 100, "0–100") ??
      badNumber(ctx.opts, "fps", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "max-frames", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number");
    if (numErr) return [err(numErr)];

    // action-specific flags: each op forwards only the flags it uses, so a flag
    // set for the WRONG action would be silently dropped (the user thinks they
    // filtered/sampled but didn't). Reject the mismatch, like `face` does.
    const FLAG_OPS: Record<string, string[]> = {
      "min-similarity": ["add", "ingest", "identify", "recluster"],
      fps: ["add", "ingest", "identify"],
      "max-frames": ["add", "ingest", "identify"],
      start: ["add", "ingest", "identify"],
      end: ["add", "ingest", "identify"],
      limit: ["identify", "list", "show"],
      "source-record": ["add", "ingest"],
      cluster: ["show", "label"],
      label: ["label"],
      out: ["view"],
      "no-open": ["view"],
    };
    for (const [flag, ops] of Object.entries(FLAG_OPS)) {
      const provided = flag === "no-open" ? ctx.opts[flag] === true : ctx.opts[flag] != null;
      if (provided && !ops.includes(action)) {
        return [err(`--${flag} doesn't apply to cluster ${action} (only: ${ops.join(", ")})`)];
      }
    }

    const indexFlag = ctx.opts.index != null ? String(ctx.opts.index) : undefined;
    if (indexFlag !== undefined && !indexFlag.trim()) return [err("--index requires a face-cluster index id or name")];
    const idx = resolveClusterIndex(c, indexFlag);
    if (idx.error) return [err(idx.error)];
    const indexId = idx.id!;

    const sampling = {
      minSimilarity: num(ctx.opts["min-similarity"]),
      limit: num(ctx.opts.limit),
      fps: num(ctx.opts.fps),
      maxFrames: num(ctx.opts["max-frames"]),
      start: ctx.opts.start ? String(ctx.opts.start) : undefined,
      end: ctx.opts.end ? String(ctx.opts.end) : undefined,
      signal: ctx.signal,
    };

    const finish = (rec: OvercastRecord, op: string): OvercastRecord[] => {
      if (NON_MEDIA_OPS.has(op) && rec.media?.ref === "-") rec.media = undefined;
      return [rec];
    };

    if (action === "add" || action === "ingest") {
      const arg = ctx.rest[0];
      if (!arg) return [err("usage: cluster add <video|image> --index <id>")];
      const media = resolveVisualArg(c, arg, "cluster add", { requireReady: false });
      if (media.error) return [err(media.error)];
      // an explicit --source-record wins over the resolver's inferred record id
      // (the flag exists precisely for bare paths the resolver can't attribute);
      // a provided-but-blank value is a user error, not an omitted flag.
      let sourceRecord = media.recordId;
      if (ctx.opts["source-record"] != null) {
        const raw = String(ctx.opts["source-record"]).trim();
        if (!raw) return [err("--source-record requires a case record id")];
        sourceRecord = raw;
      }
      const rec = await runLocalCluster(c, media.ref!, { indexId, op: "ingest", sourceRecord, ...sampling });
      return [rec];
    }

    if (action === "identify") {
      const arg = ctx.rest[0];
      if (!arg) return [err("usage: cluster identify <image|video> --index <id>")];
      // a probe may be a still image OR a clip (the provider samples video frames
      // with the same --fps/--max-frames/--start/--end machinery as ingest).
      const media = resolveVisualArg(c, arg, "cluster identify", { requireReady: false });
      if (media.error) return [err(media.error)];
      const rec = await runLocalCluster(c, media.ref!, { indexId, op: "identify", minSimilarity: sampling.minSimilarity, limit: sampling.limit, fps: sampling.fps, maxFrames: sampling.maxFrames, start: sampling.start, end: sampling.end, signal: ctx.signal });
      return [rec];
    }

    if (action === "recluster") {
      const rec = await runLocalCluster(c, "-", { indexId, op: "recluster", minSimilarity: sampling.minSimilarity, signal: ctx.signal });
      return finish(rec, "recluster");
    }

    if (action === "list") {
      const rec = await runLocalCluster(c, "-", { indexId, op: "list", limit: sampling.limit, signal: ctx.signal });
      return finish(rec, "list");
    }

    if (action === "show") {
      const person = ctx.rest[0] ?? (ctx.opts.cluster != null ? String(ctx.opts.cluster) : undefined);
      if (!person || !person.trim()) return [err("usage: cluster show <person-id> --index <id>")];
      const rec = await runLocalCluster(c, "-", { indexId, op: "show", cluster: person, limit: sampling.limit, signal: ctx.signal });
      return finish(rec, "show");
    }

    if (action === "label") {
      const person = ctx.rest[0] ?? (ctx.opts.cluster != null ? String(ctx.opts.cluster) : undefined);
      const name = ctx.rest[1] ?? (ctx.opts.label != null ? String(ctx.opts.label) : undefined);
      if (!person || !person.trim()) return [err("usage: cluster label <person-id> <name> --index <id>")];
      if (!name || !name.trim()) return [err("cluster label requires a name (cluster label <person-id> <name>)")];
      const rec = await runLocalCluster(c, "-", { indexId, op: "label", cluster: person, label: name, signal: ctx.signal });
      return finish(rec, "label");
    }

    // view: render the people into a self-contained HTML contact sheet + open it.
    const listRec = await runLocalCluster(c, "-", { indexId, op: "list", limit: 10000, signal: ctx.signal });
    if (listRec.state === "error") return finish(listRec, "list");
    const payload = (listRec.payload ?? {}) as Record<string, unknown>;
    const clusters = (Array.isArray(payload.clusters) ? payload.clusters : []) as ClusterGalleryPerson[];
    // the whole-store totals come from the list payload — `clusters` is a page
    // (limit-capped), so counting it would understate a big DB and drop
    // off-page named people from the stats.
    const people = typeof payload.count === "number" ? payload.count : clusters.length;
    const named = typeof payload.named === "number" ? payload.named : undefined;
    const model = (listRec.meta as Record<string, unknown> | undefined)?.model;
    const html = renderClusterGallery({
      title: `overcast — face clusters`,
      subtitle: `${indexId} · ${people} ${people === 1 ? "person" : "people"}`,
      clusters,
      total: people,
      named,
      model: typeof model === "string" ? model : null,
    });
    const outPath = ctx.opts.out ? String(ctx.opts.out) : join(c.mediaDir, `cluster-${indexId}.html`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, "utf8");
    const noOpen = ctx.opts["no-open"] === true;
    if (!noOpen) openHtmlPlayer(outPath);
    return [makeRecord({
      verb: "cluster",
      format: "json",
      payload: {
        op: "view",
        index: indexId,
        viewer: outPath,
        people,
        opened: !noOpen,
        summary: `face-cluster gallery for ${indexId} (${people} ${people === 1 ? "person" : "people"})`,
      },
      meta: { provider: "local:face-cluster", case: c.dir },
      state: "ready",
    })];
  },
};
