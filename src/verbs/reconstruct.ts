// `reconstruct` — speculative scene reconstruction (the futuristic sibling of
// enhance). Given a still (or a video frame via --at / frame://), a bound
// provider synthesizes what the scene *would plausibly* look like from a camera
// the investigator never had: reposition (rotate/elevate/zoom), a turntable
// sweep, a liftable 3D mesh, or an estimated depth map.
//
// Forensic posture (deliberate, locked): every record carries `payload.caveat`
// (stamped in reconstruct-fanout even if a provider forgets) and the verb is in
// OPERATIONAL_VERBS — reconstructions persist, chain into `view`, and export,
// but NEVER feed ask/brief evidence or findings triggers. These are synthesized
// pixels — a hypothesis to steer the investigation, not proof.
//
// There is NO built-in backend (unlike enhance's ffmpeg default): novel-view
// synthesis needs a bound model provider (`examples/providers/fal/reconstruct.sh`).

import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { isReady, makeRecord, type OvercastRecord } from "../record.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import { providerEnv } from "../providers/provider-env.js";
import { resolveMediaRef } from "./media-ref.js";
import { provenanceCase, stampArchive } from "../archive.js";
import { provenanceFromCapture, stampProvenance } from "./provenance.js";
import {
  probe,
  extractFrame,
  parseFrameRef,
  parseTimecode,
  modalityFromExt,
  tileImageSheet,
  imagesToVideo,
} from "../media/ffmpeg.js";
import { openHtmlPlayer } from "../media/view.js";
import { fanOutReconstruct, hasReconstructFanOut, RECONSTRUCT_CAVEAT } from "./reconstruct-fanout.js";
import { renderReconstructGallery, type ReconstructGalleryView } from "../report/html.js";
import { buildOrbitViewerHtml, buildParallaxViewerHtml, buildArtifactViewerHtml } from "../report/reconstruct-viewers.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

const RECONSTRUCT_OPS: ReadonlySet<string> = new Set(["view", "sweep", "model", "depth"]);

function errorRecord(message: string): OvercastRecord {
  return makeRecord({
    verb: "reconstruct",
    format: "json",
    payload: { error: message },
    error: message,
    state: "error",
  });
}

function optNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function payloadOf(rec: OvercastRecord): Record<string, unknown> {
  return typeof rec.payload === "object" && rec.payload ? (rec.payload as Record<string, unknown>) : {};
}

export const reconstructVerb: VerbSpec = {
  name: "reconstruct",
  group: "sense",
  summary:
    "Speculatively reposition the camera in a still (rotate/elevate/zoom, turntable sweep, 3D model, depth) via a bound generative provider — a hypothesis renderer, never evidence.",
  description:
    "Scene reconstruction: hold the camera at a captured moment, then move it. Give an image (or a " +
    "video + --at to pick the frame) and either camera moves — `--rotate <deg>` (0 front / 90 right / " +
    "180 behind, negative = left) with optional `--elevate <-30..90>` and `--zoom <0..10>` — or an op: " +
    "`--ops sweep` synthesizes --count camera stops around 360° and assembles a labeled contact sheet + " +
    "turntable video, `--ops model` lifts a textured 3D mesh (GLB) you can orbit in the built-in viewer, " +
    "`--ops depth` estimates a depth map rendered as a drag-to-parallax hologram. Every output is " +
    "GENERATIVE — synthesized pixels stamped with payload.caveat, excluded from ask/brief evidence and " +
    "findings triggers; use it to form hypotheses (what's around the corner? what would a second camera " +
    "have seen?), then verify with real captures. Needs a bound provider (no built-in): " +
    "`overcast provider setup apply --verb reconstruct --choice fal --yes` (FAL_KEY). " +
    "`view <record-id>` reopens the gallery / 3D orbit / parallax viewer; --view opens it immediately.",
  args: [
    { name: "input", summary: "Image (or video with --at) — path, record id, frame://rec@sec, or archive:<bucket>/<item>", required: true },
  ],
  flags: [
    { name: "rotate", summary: "Camera azimuth in degrees (0 front, 90 right, 180 behind; negative = left)", type: "number" },
    { name: "elevate", summary: "Camera elevation in degrees (-30 low-angle … 0 eye-level … 60 high … 90 bird's-eye)", type: "number" },
    { name: "zoom", summary: "Camera distance 0-10 (0 wide, 5 as-shot, 10 close-up)", type: "number" },
    { name: "ops", summary: "Reconstruction op: view (default with --rotate) | sweep | model | depth", type: "string", choices: ["view", "sweep", "model", "depth"] },
    { name: "count", summary: "Sweep: number of synthesized camera stops around 360° (2-24, default 8)", type: "number" },
    { name: "at", summary: "Video input: timestamp (SS or MM:SS) of the frame to reconstruct from", type: "string" },
    { name: "prompt", summary: "Extra scene hint forwarded to the view-synthesis model", type: "string" },
    { name: "seed", summary: "Generation seed for reproducibility", type: "number" },
    { name: "view", summary: "Open the reconstruction viewer (gallery / 3D orbit / parallax) when done", type: "boolean" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.reconstruction",
  providerKey: "reconstruct",
  run: async (ctx) => {
    if (!ctx.input) return [errorRecord("reconstruct requires an image (or video + --at) input")];

    // ---- input intake (enhance precedent: frame:// first, then the shared resolver)
    let input = ctx.input;
    let provenanceSource = ctx.input;
    let archiveBucket: string | undefined;
    const fr = parseFrameRef(ctx.input);
    if (fr) {
      const fsrc = resolveMediaRef(ctx.case, fr.recordId, ctx.home);
      const src = fsrc.error ? undefined : fsrc.ref;
      if (!src || !existsSync(src)) {
        return [errorRecord(`cannot resolve ${ctx.input}: ${fsrc.error ?? `record ${fr.recordId} has no media on disk`}`)];
      }
      if (fsrc.record && !isReady(fsrc.record)) {
        return [errorRecord(`cannot extract ${ctx.input}: record ${fsrc.record.id} isn't ready (state=${fsrc.record.state ?? "?"})`)];
      }
      provenanceSource = src;
      archiveBucket = fsrc.archive;
      try {
        input = await extractFrame(src, fr.second, ctx.case.mediaDir);
      } catch (e) {
        return [errorRecord(`frame extraction failed for ${ctx.input}: ${(e as Error).message}`)];
      }
    } else {
      const r = resolveMediaRef(ctx.case, input, ctx.home);
      if (r.error) return [errorRecord(`reconstruct input: ${r.error}`)];
      if (r.record && !isReady(r.record)) {
        return [errorRecord(`reconstruct input: record ${r.record.id} isn't ready (state=${r.record.state ?? "?"})`)];
      }
      input = r.ref;
      provenanceSource = r.ref;
      archiveBucket = r.archive;
    }
    if (!existsSync(input)) return [errorRecord(`input not found: ${input}`)];

    // ---- modality gate: the providers reconstruct from a single still. A video
    // is fine WITH --at (we extract the frame here — provenance stays on the clip).
    const p = await probe(input).catch(() => ({ modality: modalityFromExt(input) }) as Awaited<ReturnType<typeof probe>>);
    if (p.modality === "video") {
      const atRaw = ctx.opts.at !== undefined ? String(ctx.opts.at) : "";
      if (!atRaw) {
        return [errorRecord("reconstruct works on a single frame — for a video pass --at <sec|mm:ss> to pick the moment (or use frame://<rec>@<sec>)")];
      }
      const sec = parseTimecode(atRaw);
      if (sec === undefined) return [errorRecord(`invalid --at '${atRaw}' (use seconds or MM:SS)`)];
      try {
        input = await extractFrame(input, sec, ctx.case.mediaDir);
      } catch (e) {
        return [errorRecord(`frame extraction failed at --at ${atRaw}: ${(e as Error).message}`)];
      }
    } else if (p.modality !== "image") {
      return [errorRecord(`reconstruct needs an image or a video frame (got ${p.modality})`)];
    }

    // ---- op selection: --rotate/--elevate/--zoom imply the default `view` op.
    const rotate = optNum(ctx.opts.rotate);
    const elevate = optNum(ctx.opts.elevate);
    const zoom = optNum(ctx.opts.zoom);
    const camGiven = rotate !== undefined || elevate !== undefined || zoom !== undefined;
    const op = ctx.opts.ops ? String(ctx.opts.ops).toLowerCase().trim() : camGiven ? "view" : "";
    if (!op) {
      return [errorRecord(
        "specify a reconstruction: --rotate <deg> (with optional --elevate/--zoom) repositions the camera; --ops sweep|model|depth for a turntable / 3D model / depth map",
      )];
    }
    if (!RECONSTRUCT_OPS.has(op)) {
      return [errorRecord(`unknown --ops '${op}'. Valid ops: ${[...RECONSTRUCT_OPS].join(", ")}.`)];
    }
    if (op === "view" && !camGiven) {
      return [errorRecord("--ops view needs a camera move: --rotate <deg>, --elevate <deg>, and/or --zoom <0-10>")];
    }
    // fail fast on values the view model would 422 on (its documented ranges).
    if (elevate !== undefined && (elevate < -30 || elevate > 90)) {
      return [errorRecord(`--elevate ${elevate} out of range (-30 low-angle … 90 bird's-eye)`)];
    }
    if (zoom !== undefined && (zoom < 0 || zoom > 10)) {
      return [errorRecord(`--zoom ${zoom} out of range (0 wide … 10 close-up)`)];
    }
    const count = optNum(ctx.opts.count);
    if (count !== undefined && (count < 2 || count > 24 || !Number.isInteger(count))) {
      return [errorRecord(`--count ${count} out of range (2-24 camera stops)`)];
    }

    // ---- provider dispatch. No built-in: reconstruction is inherently a model op.
    const binding = providerBinding(ctx, "reconstruct");
    if (!isCustomBinding(binding)) {
      return [errorRecord(
        "reconstruct has no built-in backend — bind a provider first: " +
          "`overcast provider setup apply --verb reconstruct --choice fal --yes` (needs FAL_KEY), " +
          'or `overcast setup provider reconstruct "exec:bash examples/providers/fal/reconstruct.sh --input {{input}}"`.',
      )];
    }
    const extraArgs: string[] = ["--ops", op];
    if (rotate !== undefined) extraArgs.push("--rotate", String(rotate));
    if (elevate !== undefined) extraArgs.push("--elevate", String(elevate));
    if (zoom !== undefined) extraArgs.push("--zoom", String(zoom));
    if (count !== undefined) extraArgs.push("--count", String(count));
    if (ctx.opts.prompt) extraArgs.push("--prompt", String(ctx.opts.prompt));
    const seed = optNum(ctx.opts.seed);
    if (seed !== undefined) extraArgs.push("--seed", String(seed));

    // A `model` lift polls the fal queue (FAL_QUEUE_TIMEOUT_S, default 600s) then
    // downloads a multi-MB GLB; a `sweep` makes up to --count 24 sequential model
    // calls. Both can outlast enhance's 15-min budget and get killed mid-work,
    // stranding partial artifacts. Give reconstruct 30 min so the outer exec
    // timeout comfortably clears the provider's own longest bounded work (the
    // 600s queue poll + downloads, or a full sweep).
    const rec = await runBoundProvider("reconstruct", binding!, input, {
      env: providerEnv(ctx.case.mediaDir),
      extraArgs,
      timeoutMs: 30 * 60_000,
      signal: ctx.signal,
    });

    // Guard the envelope (enhance precedent). A ready record must (a) not declare
    // a malformed outputs[] (fail loudly — artifacts would be silently dropped),
    // and (b) echo the requested op, whether or not it fanned out. Validating the
    // op on BOTH paths matters: sweep assembly + viewer routing key off the
    // requested op, so a mis-bound/buggy provider returning a valid fan-out under
    // the WRONG op label would otherwise run sweep code over depth outputs (etc.)
    // and leave the parent's op/routing inconsistent.
    const recPayload = payloadOf(rec);
    const declaredOutputs = Array.isArray(recPayload.outputs) ? recPayload.outputs : undefined;
    if (rec.state === "ready") {
      if (!hasReconstructFanOut(rec) && declaredOutputs && declaredOutputs.length > 0) {
        return [errorRecord(
          `the reconstruct provider returned malformed outputs[] (each item needs a string 'ref' and 'kind'); no artifacts were expanded.`,
        )];
      }
      if (recPayload.op !== op) {
        return [errorRecord(
          `the bound reconstruct provider did not perform '--ops ${op}' (returned op=${JSON.stringify(recPayload.op ?? null)}). ` +
            "Bind the fal reconstruct provider: `overcast provider setup apply --verb reconstruct --choice fal --yes`.",
        )];
      }
      // op matches; a fan-out expands below, an empty result falls through.
    }

    // ---- sweep post-processing: assemble the contact sheet + turntable video
    // from the synthesized stops BEFORE fan-out, as two more outputs[] items —
    // so they become first-class children through the same seam. Best-effort:
    // a failed local assembly never voids the synthesized views themselves.
    if (op === "sweep" && rec.state === "ready" && hasReconstructFanOut(rec)) {
      const outputs = recPayload.outputs as Array<Record<string, unknown>>;
      const stops = outputs
        .filter((o) => o.kind === "view" && typeof o.ref === "string" && existsSync(o.ref as string))
        .sort((a, b) => (optNum(a.azimuth ?? a.rotate) ?? 0) - (optNum(b.azimuth ?? b.rotate) ?? 0));
      if (stops.length >= 2) {
        const outDir = join(ctx.case.mediaDir, "reconstruct");
        // scope both assembled artifacts to THIS record's id (rec.id is unique per
        // invocation) so a re-run never overwrites an earlier sweep's sheet/
        // turntable and strands its record on stale pixels — the same
        // collision-free-per-run intent as contactSheet's content hash.
        try {
          const sheet = await tileImageSheet(
            stops.map((s) => ({ path: s.ref as string, label: `az ${Math.round(optNum(s.azimuth ?? s.rotate) ?? 0)}` })),
            outDir,
            { outPath: join(outDir, `reconstruct-sheet-${rec.id}.png`) },
          );
          recPayload.sheet = sheet.output;
          outputs.push({ kind: "sheet", ref: sheet.output, cols: sheet.cols, rows: sheet.rows, labeled: sheet.labeled });
        } catch (e) {
          recPayload.sheet_error = (e as Error).message;
        }
        try {
          const turnPath = join(outDir, `reconstruct-turntable-${rec.id}.mp4`);
          const turn = await imagesToVideo(stops.map((s) => s.ref as string), turnPath, { fps: 2 });
          recPayload.turntable = turn;
          outputs.push({ kind: "turntable", ref: turn, fps: 2, frames: stops.length });
        } catch (e) {
          recPayload.turntable_error = (e as Error).message;
        }
        // keep the parent's declared count in step with the artifacts we just
        // appended — otherwise count (provider's view-only value) understates the
        // outputs[]/fan-out-children the record actually carries.
        recPayload.count = outputs.length;
      }
    }

    const recs = fanOutReconstruct(rec, { caseDir: ctx.case.dir });
    const prov = provenanceFromCapture(provenanceCase(ctx.case, archiveBucket, ctx.home), provenanceSource);
    for (const r of recs) {
      r.meta = { ...r.meta, case: ctx.case.dir };
      stampProvenance(r, prov);
      stampArchive(r, archiveBucket);
    }

    // ---- --view: open the right viewer straight from the fresh records (the
    // `view <id>` seam re-renders it any time from the persisted case).
    if (ctx.opts.view === true && rec.state === "ready") {
      try {
        const built = buildReconstructViewer(ctx, recs[0], recs.slice(1));
        if (built) {
          (payloadOf(recs[0])).viewer = built;
          openHtmlPlayer(built);
        }
      } catch {
        /* viewer is a convenience; never fail the reconstruction over it */
      }
    }

    return recs;
  },
};

// ---- viewer seam (shared by --view and the `view` verb) ----------------------

function childRefOfKind(children: OvercastRecord[], kind: string): string | undefined {
  for (const c of children) {
    const cp = payloadOf(c);
    if (cp.kind === kind && typeof c.media?.ref === "string" && existsSync(c.media.ref)) return c.media.ref;
  }
  return undefined;
}

/** Build the appropriate self-contained viewer HTML for a reconstruct PARENT
 *  record (+ its children) and return its path, or undefined when there's
 *  nothing renderable. model → 3D orbit viewer; depth → parallax hologram;
 *  view/sweep → CSI gallery (stops + sheet + turntable). */
export function buildReconstructViewer(
  ctx: VerbContext,
  parent: OvercastRecord,
  children: OvercastRecord[],
): string | undefined {
  const p = payloadOf(parent);
  const op = typeof p.op === "string" ? p.op : "";
  const sourceRef = parent.media?.ref;
  const caveat = typeof p.caveat === "string" ? p.caveat : RECONSTRUCT_CAVEAT;
  const title = `reconstruct ${op}`;
  const subtitle = sourceRef ? sourceRef.split("/").pop() : parent.id;

  if (op === "model") {
    const mesh = childRefOfKind(children, "mesh");
    if (!mesh) return undefined;
    const html = buildOrbitViewerHtml(mesh, { title, subtitle, caveat });
    const out = join(ctx.case.mediaDir, `reconstruct-orbit-${parent.id}.html`);
    writeFileSync(out, html, "utf8");
    return out;
  }
  if (op === "depth") {
    const depth = childRefOfKind(children, "depth");
    if (!depth || !sourceRef || !existsSync(sourceRef)) return undefined;
    const html = buildParallaxViewerHtml(sourceRef, depth, { title, subtitle, caveat });
    if (!html) return undefined;
    const out = join(ctx.case.mediaDir, `reconstruct-parallax-${parent.id}.html`);
    writeFileSync(out, html, "utf8");
    return out;
  }
  // view / sweep → gallery of synthesized stops
  const views: ReconstructGalleryView[] = [];
  for (const c of children) {
    const cp = payloadOf(c);
    if (cp.kind !== "view" || typeof c.media?.ref !== "string") continue;
    views.push({
      ref: c.media.ref,
      rotate: optNum(cp.azimuth ?? cp.rotate),
      elevate: optNum(cp.elevate),
      zoom: optNum(cp.zoom),
    });
  }
  views.sort((a, b) => (a.rotate ?? 0) - (b.rotate ?? 0));
  const html = renderReconstructGallery({
    op: op || "view",
    title,
    subtitle,
    caveat,
    sourceRef,
    model: typeof p.model === "string" ? p.model : undefined,
    views,
    sheet: typeof p.sheet === "string" ? p.sheet : childRefOfKind(children, "sheet"),
    turntable: typeof p.turntable === "string" ? p.turntable : childRefOfKind(children, "turntable"),
  });
  const out = join(ctx.case.mediaDir, `reconstruct-gallery-${parent.id}.html`);
  writeFileSync(out, html, "utf8");
  return out;
}

/** If `rec` is a reconstruct record with a dedicated viewer, render it and
 *  return the view record; else null so `view` falls through to its player.
 *  A PARENT (payload.op, no kind) gets the op's viewer over its fanned-out
 *  children; a CHILD opens its own caveat-bannered viewer — the interactive
 *  mesh/depth ones, or a bannered still/video wrapper for view/sheet/turntable
 *  so a synthesized artifact never OS-opens as a bare file with no "not
 *  evidence" context (every reconstruct child carries payload.caveat). */
export function maybeReconstructViewer(ctx: VerbContext, rec: OvercastRecord): OvercastRecord | null {
  if (rec.verb !== "reconstruct" || typeof rec.payload !== "object" || !rec.payload) return null;
  const p = payloadOf(rec);
  const caveat = typeof p.caveat === "string" ? p.caveat : RECONSTRUCT_CAVEAT;

  // child records: interactive viewers for the kinds a player can't show.
  if (typeof p.kind === "string") {
    const ref = rec.media?.ref;
    if (!ref || !existsSync(ref)) return null;
    const title = `reconstruct ${typeof p.op === "string" ? p.op : ""}`.trim();
    const subtitle = typeof p.source_media === "string" ? p.source_media.split("/").pop() : rec.id;
    const viewerOpts = { title, subtitle, caveat };
    let out: string | undefined;
    let mode: string | undefined;
    if (p.kind === "mesh") {
      out = join(ctx.case.mediaDir, `reconstruct-orbit-${rec.id}.html`);
      writeFileSync(out, buildOrbitViewerHtml(ref, viewerOpts), "utf8");
      mode = "orbit";
    } else if (p.kind === "depth") {
      const src = typeof p.source_media === "string" && existsSync(p.source_media) ? p.source_media : undefined;
      if (!src) return null;
      const html = buildParallaxViewerHtml(src, ref, viewerOpts);
      if (!html) return null;
      out = join(ctx.case.mediaDir, `reconstruct-parallax-${rec.id}.html`);
      writeFileSync(out, html, "utf8");
      mode = "parallax";
    } else if (p.kind === "view" || p.kind === "sheet" || p.kind === "turntable") {
      // synthesized still / contact sheet / turntable → the same caveat-bannered
      // wrapper, so the "not evidence" banner rides along with a raw PNG/MP4.
      const artKind = p.kind === "turntable" ? "video" : "image";
      const html = buildArtifactViewerHtml(ref, artKind, viewerOpts);
      if (!html) return null;
      out = join(ctx.case.mediaDir, `reconstruct-artifact-${rec.id}.html`);
      writeFileSync(out, html, "utf8");
      mode = artKind === "video" ? "clip" : "still";
    }
    if (!out) return null;
    if (ctx.opts["no-open"] !== true) openHtmlPlayer(out);
    return makeRecord({
      verb: "view",
      format: "json",
      payload: { mode, viewer: out, source_record: rec.id, caveat },
      media: { ref: out },
      meta: { case: ctx.case.dir },
      state: "ready",
    });
  }

  // parent records: op viewer over the fanned-out children.
  const op = p.op;
  if (op !== "view" && op !== "sweep" && op !== "model" && op !== "depth") return null;
  const children = ctx.case.records().filter(
    (r) => r.verb === "reconstruct" && (r.payload as Record<string, unknown> | undefined)?.source_record === rec.id,
  );
  const out = buildReconstructViewer(ctx, rec, children);
  if (!out) return null;
  if (ctx.opts["no-open"] !== true) openHtmlPlayer(out);
  return makeRecord({
    verb: "view",
    format: "json",
    payload: {
      mode: op === "model" ? "orbit" : op === "depth" ? "parallax" : "reconstruction",
      op,
      viewer: out,
      items: children.length,
      source_record: rec.id,
      caveat,
    },
    media: { ref: out },
    meta: { case: ctx.case.dir },
    state: "ready",
  });
}
