// Phase 2 sense + inspect verbs: listen (tinycloud speech-only), see
// (placeholder until a VLM is bound), enhance (internal ffmpeg), view
// (lightweight local player / OS-open). watch lives in registry/verbs.ts.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../record.js";
import { runListen } from "../providers/tinycloud/listen.js";
import { isCustomBinding, runBoundProvider, runExecProvider } from "../providers/run.js";
import { execCapture, parseFirstJson } from "../providers/exec.js";
import { tokenizeCommand } from "../providers/sources/index.js";
import { resolveVideoArg } from "./media-ref.js";
import {
  probe,
  enhance as ffEnhance,
  defaultOps,
  extractFrame,
  parseFrameRef,
  modalityFromExt,
  spectrogram as ffSpectrogram,
  type EnhanceOp,
  type Modality,
} from "../media/ffmpeg.js";
import { openHtmlPlayer, osOpen } from "../media/view.js";
import { providerEnv } from "../providers/provider-env.js";
import { shippedPath } from "../pkg.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function hfToken(): string | undefined {
  return process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || undefined;
}

// ---- listen ----------------------------------------------------------------

export const listenVerb: VerbSpec = {
  name: "listen",
  group: "sense",
  summary: "Transcribe and analyze audio (or a video's audio track) into an audio.analysis record.",
  description:
    "Default provider: tinycloud. Speech-only transcript by default; --describe runs the full " +
    "multimodal describe to surface the AUDIO-SCENE description (sounds, music, events, ambience), " +
    "not just speech. Emits transcript, speaker-tagged segments[] with media.at anchors, language.",
  args: [{ name: "input", summary: "Audio/video file path or URL", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
    { name: "describe", summary: "Audio-scene description (full describe), not just speech", type: "boolean" },
    { name: "diarize", summary: "Attribute speech to distinct speakers", type: "boolean" },
    { name: "lang", summary: "Hint/force source language (e.g. en, es)", type: "string" },
  ],
  outputKind: "audio.analysis",
  providerKey: "listen",
  run: async (ctx) => {
    if (!ctx.input) {
      return [errorRecord("listen", "listen requires an audio/video input")];
    }
    const resolved = resolveVideoArg(ctx.case, ctx.input, "listen input", { requireReady: false });
    if (resolved.error) return [errorRecord("listen", resolved.error)];
    const input = resolved.ref ?? ctx.input;
    const describe = ctx.opts.describe === true;
    const binding = ctx.profile.providers?.listen;
    // forward the declared listen flags to a custom provider, and give it the
    // same generous timeout the tinycloud mapper uses (long media).
    const extraArgs: string[] = [];
    if (describe) extraArgs.push("--describe");
    if (ctx.opts.diarize === true) extraArgs.push("--diarize");
    if (ctx.opts.lang) extraArgs.push("--lang", String(ctx.opts.lang));
    const rec = isCustomBinding(binding)
      ? await runBoundProvider("listen", binding!, input, {
          env: providerEnv(ctx.case.mediaDir),
          extraArgs,
          timeoutMs: 15 * 60_000,
          signal: ctx.signal,
        })
      : await runListen(input, {
          run: binding?.run,
          describe,
          signal: ctx.signal,
          diarize: ctx.opts.diarize === true,
          lang: ctx.opts.lang ? String(ctx.opts.lang) : undefined,
        });
    rec.meta = { ...rec.meta, case: ctx.case.dir };
    return [rec];
  },
};

// ---- see (placeholder) -----------------------------------------------------

export const seeVerb: VerbSpec = {
  name: "see",
  group: "sense",
  summary: "Understand an image or a single video frame (caption, OCR, detections).",
  description:
    "Defaults to a Hugging Face image captioner when HF_TOKEN is set (override with " +
    "HF_SEE_MODEL); otherwise a placeholder (needs_credentials) until a VLM is bound via " +
    "`setup provider see`. Accepts frame://rec@sec, resolved to a frame via the internal ffmpeg toolkit.",
  args: [{ name: "input", summary: "Image path, video frame, or frame://rec@sec", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
    { name: "ocr", summary: "Extract on-image text", type: "boolean" },
    { name: "detect", summary: "Comma list of target objects to locate (bind the detect provider for bounding boxes)", type: "string" },
    { name: "prompt", summary: "Focus the description", type: "string" },
    { name: "embed", summary: "Persist a visual embedding (query seed)", type: "boolean" },
  ],
  outputKind: "image.analysis",
  providerKey: "see",
  run: async (ctx) => {
    if (!ctx.input) return [errorRecord("see", "see requires an image input")];

    // resolve a frame:// reference to an extracted frame (still needs a VLM to analyze)
    let resolvedRef = ctx.input;
    const fr = parseFrameRef(ctx.input);
    if (fr) {
      // a frame:// ref that can't be resolved must FAIL clearly — never hand the
      // literal "frame://…" string to a provider (which reports a confusing
      // "image not found: frame://…").
      const src = ctx.case.recordById(fr.recordId)?.media?.ref;
      if (!src || !existsSync(src)) {
        return [errorRecord("see", `cannot resolve ${ctx.input}: record ${fr.recordId} has no media on disk`)];
      }
      try {
        resolvedRef = await extractFrame(src, fr.second, ctx.case.mediaDir);
      } catch (e) {
        return [errorRecord("see", `frame extraction failed for ${ctx.input}: ${(e as Error).message}`)];
      }
    }

    // Provider resolution for see:
    //  1. an explicit profile binding (exec runs it; http/inproc → explicit
    //     error rather than being silently ignored), else
    //  2. the shipped Hugging Face captioner when HF_TOKEN is set (turnkey), else
    //  3. the placeholder (needs_credentials + guidance).
    const binding = ctx.profile.providers?.see;
    const seeEnv = providerEnv(ctx.case.mediaDir);
    // forward the declared see flags to whichever provider runs (custom or HF).
    const extraArgs: string[] = [];
    if (ctx.opts.ocr === true) extraArgs.push("--ocr");
    if (ctx.opts.detect) extraArgs.push("--detect", String(ctx.opts.detect));
    if (ctx.opts.prompt) extraArgs.push("--prompt", String(ctx.opts.prompt));
    if (isCustomBinding(binding)) {
      // --detect needs a detection-capable provider. If the bound provider's
      // `describe` clearly declares no detection (no "detections" payload / detect
      // task), fail fast instead of handing --detect to a captioner that ignores
      // it and returns a caption. Lenient: an unavailable/unparseable describe just
      // proceeds (don't block a working provider on a describe hiccup).
      if (ctx.opts.detect && binding!.describe) {
        const dp = tokenizeCommand(binding!.describe);
        const dres = await execCapture(dp[0], dp.slice(1), { signal: ctx.signal, timeoutMs: 30_000 }).catch(() => undefined);
        if (dres && dres.code === 0) {
          const d = parseFirstJson(dres.stdout) as Record<string, unknown> | undefined;
          const payload = d && Array.isArray(d.payload) ? (d.payload as unknown[]) : [];
          const task = d && typeof d.task === "string" ? d.task : "";
          if (!payload.includes("detections") && !/detect/i.test(task)) {
            return [
              makeRecord({
                verb: "see",
                format: "json",
                payload: { caption: "", ocr: "", detections: [], detect: String(ctx.opts.detect) },
                error:
                  "the bound see provider doesn't support --detect (its describe declares no detections); " +
                  "bind a detector, e.g. `overcast setup provider see \"exec:python3 examples/providers/detect/detect.py\"`.",
                state: "error",
                meta: { case: ctx.case.dir },
              }),
            ];
          }
        }
      }
      const rec = await runBoundProvider("see", binding!, resolvedRef, {
        env: seeEnv,
        extraArgs,
        signal: ctx.signal,
      });
      rec.meta = { ...rec.meta, case: ctx.case.dir };
      return [rec];
    }
    // --detect needs a detection provider. The turnkey HF captioner / placeholder
    // below can't detect, so fail clearly instead of passing the label list to a
    // captioner (which would mistake it for the image path).
    if (ctx.opts.detect) {
      return [
        makeRecord({
          verb: "see",
          format: "json",
          payload: { caption: "", ocr: "", detections: [], detect: String(ctx.opts.detect) },
          error:
            "see --detect needs a detection provider; bind one, e.g. " +
            "`overcast setup provider see \"exec:python3 examples/providers/detect/detect.py\"` (OWLv2).",
          state: "error",
          meta: { case: ctx.case.dir },
        }),
      ];
    }
    if (hfToken()) {
      const hf = shippedPath("examples", "providers", "hf", "see.sh");
      if (hf) {
        // pass --input explicitly (like execDescriptor) so the media path is never
        // argv[1] and a file named "init"/"describe" can't trigger that subcommand.
        const rec = await runExecProvider("see", `bash ${hf} --input {{input}}`, resolvedRef, {
          env: seeEnv,
          extraArgs,
          signal: ctx.signal,
        });
        rec.meta = { ...rec.meta, case: ctx.case.dir };
        return [rec];
      }
    }

    return [
      makeRecord({
        verb: "see",
        format: "json",
        payload: {
          caption: "",
          ocr: "",
          detections: [],
          guidance:
            "see has no default provider yet. Bind a VLM: `overcast setup provider see <http|module>`.",
        },
        media: { ref: resolvedRef },
        meta: { provider: "placeholder", case: ctx.case.dir },
        state: "needs_credentials",
      }),
    ];
  },
};

// ---- enhance (internal ffmpeg) ---------------------------------------------

export const enhanceVerb: VerbSpec = {
  name: "enhance",
  group: "sense",
  summary: "Produce better media (denoise/normalize/upscale/...) via ffmpeg or a bound model provider.",
  description:
    "Default: deterministic, modality-dispatched ops on the bundled ffmpeg (denoise/normalize/" +
    "voice-isolate/upscale/stabilize/grayscale). Bind a model provider for AI upscaling/restoration " +
    "via `setup provider enhance <spec>` (samples: fal esrgan/deepfilternet3, HF, ElevenLabs voice " +
    "isolation). Emits a media.enhanced record whose media.ref is the output path — chain it into watch/listen/see.",
  args: [{ name: "input", summary: "Media file path", required: true }],
  flags: [
    { name: "ops", summary: "Comma list of ops (denoise,normalize,upscale,...)", type: "string" },
    { name: "out", summary: "Output path (default .overcast/media/)", type: "string" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.enhanced",
  providerKey: "enhance",
  run: async (ctx) => {
    if (!ctx.input) return [errorRecord("enhance", "enhance requires a media input")];
    if (!existsSync(ctx.input)) {
      return [errorRecord("enhance", `input not found: ${ctx.input}`)];
    }
    // A bound enhance provider (e.g. the HF model-ops provider) takes over for
    // model-based ops; the DEFAULT stays the internal ffmpeg toolkit (invariant
    // #7). Bind via `overcast setup provider enhance "exec:bash …/hf/enhance.sh"`.
    const enhBinding = ctx.profile.providers?.enhance;
    if (isCustomBinding(enhBinding)) {
      // dispatch by transport (exec runs it; http/inproc return an explicit
      // error) rather than silently falling back to ffmpeg when a non-exec
      // enhance provider is bound.
      const rec = await runBoundProvider("enhance", enhBinding!, ctx.input, {
        env: providerEnv(ctx.case.mediaDir),
        signal: ctx.signal,
      });
      rec.meta = { ...rec.meta, case: ctx.case.dir };
      return [rec];
    }
    const opsStr = ctx.opts.ops ? String(ctx.opts.ops) : "";
    const requested = opsStr
      ? (opsStr.split(",").map((s) => s.trim()).filter(Boolean) as EnhanceOp[])
      : undefined;
    const outDir = ctx.case.mediaDir;
    try {
      const p = await probe(ctx.input).catch(() => ({ modality: modalityFromExt(ctx.input!) }) as Awaited<ReturnType<typeof probe>>);
      const ops = requested ?? defaultOps(p.modality);
      if (ops.length === 0) {
        return [errorRecord("enhance", `no enhance ops apply to modality '${p.modality}'`)];
      }
      const result = await ffEnhance(
        ctx.input,
        ops,
        outDir,
        ctx.opts.out ? String(ctx.opts.out) : undefined,
      );
      return [
        makeRecord({
          verb: "enhance",
          format: "json",
          payload: {
            ops: result.ops,
            skipped: result.skipped,
            modality: result.modality,
            output: result.output,
          },
          media: { ref: result.output },
          meta: { provider: "ffmpeg", case: ctx.case.dir },
          state: "ready",
        }),
      ];
    } catch (e) {
      return [errorRecord("enhance", `ffmpeg enhance failed: ${(e as Error).message}`)];
    }
  },
};

// ---- view (local player / OS-open) -----------------------------------------

export const viewVerb: VerbSpec = {
  name: "view",
  group: "inspect",
  summary: "Open media in a lightweight local viewer (scrubbable player) or hand off to the OS.",
  description:
    "For video/audio, generates a self-contained HTML player (timeline + markers for a referenced " +
    "record's media.at) and opens it. For other files, uses the OS open command. --no-open writes " +
    "the viewer and emits a view record with its path instead of launching.",
  args: [{ name: "ref", summary: "Media path, capture-id, or record-id", required: true }],
  flags: [
    { name: "at", summary: "Start at SS or seek a START-END span", type: "string" },
    { name: "spectrogram", summary: "(audio) also render a spectrogram", type: "boolean" },
    { name: "no-open", summary: "Write the viewer but don't launch it", type: "boolean" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "view",
  providerKey: "view",
  run: async (ctx) => {
    if (!ctx.input) return [errorRecord("view", "view requires a media ref")];

    // resolve a record-id to its media (jump to its media.at)
    let mediaPath = ctx.input;
    let markers: number[] = [];
    // a true [start,end] span carried by the resolved record — preserved as-is
    // for the view record's media.at (we never SYNTHESIZE a span from 2 points).
    let recordSpan: [number, number] | undefined;
    let at = ctx.opts.at ? String(ctx.opts.at) : undefined;
    const rec = ctx.case.recordById(ctx.input);
    if (rec?.media?.ref) {
      mediaPath = rec.media.ref;
      const a = rec.media.at;
      if (typeof a === "number") {
        markers = [a];
        if (!at) at = String(a);
      } else if (Array.isArray(a)) {
        markers = a;
        recordSpan = [a[0], a[1]];
        if (!at) at = `${a[0]}-${a[1]}`;
      }
      // Records like `listen` carry per-segment anchors in the payload rather
      // than a single record-level media.at — surface those as timeline pins.
      const segs = (rec.payload as Record<string, unknown> | undefined)?.segments;
      if (Array.isArray(segs)) {
        const segMarkers: number[] = [];
        for (const s of segs) {
          const sa = (s as Record<string, unknown> | null)?.at;
          if (typeof sa === "number") segMarkers.push(sa);
          else if (Array.isArray(sa) && typeof sa[0] === "number") segMarkers.push(sa[0]);
        }
        if (segMarkers.length) {
          markers = [...new Set([...markers, ...segMarkers])].sort((x, y) => x - y);
          if (!at) at = String(markers[0]);
        }
      }
    }

    // watch/listen accept and persist http(s) URLs; view must too (don't treat
    // a URL as a missing local path or wrap it in a file:// URL).
    const isUrl = /^https?:\/\//i.test(mediaPath);
    if (!isUrl && !existsSync(mediaPath)) {
      return [errorRecord("view", `media not found: ${mediaPath}`)];
    }

    // Detect modality by content (ffprobe) for local files, matching `enhance`;
    // fall back to the extension (and use it directly for remote URLs).
    const modality: Modality = isUrl
      ? modalityFromExt(mediaPath)
      : (
          await probe(mediaPath).catch(
            () => ({ modality: modalityFromExt(mediaPath) }) as Awaited<ReturnType<typeof probe>>,
          )
        ).modality;
    const noOpen = ctx.opts["no-open"] === true;

    if (modality !== "video" && modality !== "audio") {
      // OS open for non-AV files
      if (!noOpen) osOpen(mediaPath);
      return [
        makeRecord({
          verb: "view",
          format: "json",
          payload: { mode: "os-open", ref: mediaPath, opened: !noOpen },
          media: { ref: mediaPath },
          meta: { provider: "view", case: ctx.case.dir },
          state: "ready",
        }),
      ];
    }

    // optional spectrogram (audio): render a real PNG via ffmpeg showspectrumpic
    let spectro: string | undefined;
    if (ctx.opts.spectrogram === true && modality === "audio" && !isUrl) {
      try {
        spectro = await ffSpectrogram(mediaPath, ctx.case.mediaDir);
      } catch {
        /* non-fatal; the player still renders without it */
      }
    }

    const htmlPath = join(ctx.case.mediaDir, "view.html");
    const html = buildPlayerHtml(mediaPath, modality, at, markers, spectro, isUrl);
    writeFileSync(htmlPath, html, "utf8");
    if (!noOpen) openHtmlPlayer(htmlPath);

    return [
      makeRecord({
        verb: "view",
        format: "json",
        payload: {
          mode: modality,
          ref: mediaPath,
          viewer: htmlPath,
          at: at ?? null,
          markers,
          spectrogram: spectro ?? null,
          opened: !noOpen,
        },
        // a real span if the source had one; otherwise the first marker as a
        // point seek — never a fabricated [start,end] from two distinct points.
        media: { ref: mediaPath, at: recordSpan ?? (markers.length ? markers[0] : undefined) },
        meta: { provider: "view", case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};

// ---- helpers ---------------------------------------------------------------

function errorRecord(verb: string, message: string): OvercastRecord {
  return makeRecord({
    verb,
    format: "json",
    payload: { error: message },
    error: message,
    state: "error",
  });
}

function buildPlayerHtml(
  src: string,
  modality: "video" | "audio",
  at: string | undefined,
  markers: number[],
  spectrogramPath: string | undefined,
  isRemote = false,
): string {
  const startAt = at ? parseTimecode(String(at).split("-")[0]) : 0;
  const tag = modality === "video" ? "video" : "audio";
  const markerPins = markers
    .map((m) => `<button class="pin" onclick="seek(${Number(m)})">⏱ ${Number(m)}s</button>`)
    .join("");
  // For local files build a proper file:// URL (encodes spaces/specials); a
  // remote http(s) URL is used as-is. Either way HTML-escape every interpolated
  // path so a filename with quotes/`<`/`&` can't break the attribute or inject
  // script into the generated page.
  const fileUrl = htmlAttr(isRemote ? src : pathToFileURL(src).href);
  const nameEsc = htmlText(basenameOf(src));
  const srcEsc = htmlText(src);
  return `<!doctype html><html><head><meta charset="utf-8">
<title>overcast view — ${nameEsc}</title>
<style>
  body{background:#08120c;color:#c6f7d5;font-family:ui-monospace,monospace;margin:0;padding:24px}
  h1{color:#ffc400;font-size:14px;letter-spacing:2px}
  ${tag}{width:100%;max-width:960px;background:#000;border:1px solid #1f9d57}
  .pins{margin-top:12px}
  .pin{background:#0d1f14;color:#00ff7f;border:1px solid #1f9d57;padding:4px 8px;margin:2px;cursor:pointer}
  .note{color:#1f9d57;font-size:12px;margin-top:8px}
</style></head><body>
<h1>▶ OVERCAST VIEW — ${nameEsc}</h1>
<${tag} id="m" src="${fileUrl}" controls></${tag}>
<div class="pins">${markerPins || '<span class="note">no markers</span>'}</div>
${spectrogramPath ? `<img src="${htmlAttr(pathToFileURL(spectrogramPath).href)}" alt="spectrogram" style="width:100%;max-width:1024px;border:1px solid #1f9d57;margin-top:12px"/>` : ""}
<p class="note">${srcEsc}</p>
<script>
  const m=document.getElementById('m');
  function seek(s){m.currentTime=s;m.play();}
  m.addEventListener('loadedmetadata',()=>{ if(${startAt}>0) m.currentTime=${startAt}; });
</script>
</body></html>`;
}

function basenameOf(p: string): string {
  return p.split("/").pop() ?? p;
}

/** Parse a seek value: plain seconds ("134", "134.5") or a timecode ("02:14",
 *  "1:02:14"). Returns 0 for anything unparseable. */
function parseTimecode(s: string): number {
  const str = s.trim();
  if (str === "") return 0;
  if (str.includes(":")) {
    const parts = str.split(":").map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return 0;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
}

/** Escape for HTML text content. */
function htmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape for a double-quoted HTML attribute value. */
function htmlAttr(s: string): string {
  return htmlText(s).replace(/"/g, "&quot;");
}
