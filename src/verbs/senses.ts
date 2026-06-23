// Phase 2 sense + inspect verbs: listen (tinycloud speech-only), see
// (placeholder until a VLM is bound), enhance (internal ffmpeg), view
// (lightweight local player / OS-open). watch lives in registry/verbs.ts.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../record.js";
import { runListen } from "../providers/tinycloud/listen.js";
import {
  probe,
  enhance as ffEnhance,
  defaultOps,
  extractFrame,
  parseFrameRef,
  modalityFromExt,
  type EnhanceOp,
} from "../media/ffmpeg.js";
import { openHtmlPlayer, osOpen } from "../media/view.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

// ---- listen ----------------------------------------------------------------

export const listenVerb: VerbSpec = {
  name: "listen",
  group: "sense",
  summary: "Transcribe and analyze audio (or a video's audio track) into an audio.analysis record.",
  description:
    "Default provider: tinycloud (speech-only describe). Emits transcript, speaker-tagged " +
    "segments[] with media.at anchors, and detected language.",
  args: [{ name: "input", summary: "Audio/video file path or URL", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
    { name: "diarize", summary: "Attribute speech to distinct speakers", type: "boolean" },
    { name: "lang", summary: "Hint/force source language (e.g. en, es)", type: "string" },
  ],
  outputKind: "audio.analysis",
  providerKey: "listen",
  run: async (ctx) => {
    if (!ctx.input) {
      return [errorRecord("listen", "listen requires an audio/video input")];
    }
    const binding = ctx.profile.providers?.listen;
    const rec = await runListen(ctx.input, { run: binding?.run, signal: ctx.signal });
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
    "v1: no default (tinycloud) implementation — ships as a placeholder that reports " +
    "needs_credentials until a VLM provider is bound via `setup provider see <http|module>`. " +
    "Accepts a frame:// reference (rec@sec) which is resolved to a frame via the internal ffmpeg toolkit.",
  args: [{ name: "input", summary: "Image path, video frame, or frame://rec@sec", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
    { name: "ocr", summary: "Extract on-image text", type: "boolean" },
    { name: "detect", summary: "Comma list of classes to detect (face,plate,logo)", type: "string" },
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
      const src = ctx.case.recordById(fr.recordId)?.media?.ref;
      if (src && existsSync(src)) {
        try {
          resolvedRef = await extractFrame(src, fr.second, ctx.case.mediaDir);
        } catch {
          /* keep the original ref; placeholder will still report */
        }
      }
    }

    // If a see provider is bound, run it (exec). Otherwise: placeholder.
    const binding = ctx.profile.providers?.see;
    if (binding?.run) {
      // delegated providers are wired in Phase 5; for now, surface that it's bound.
      return [
        makeRecord({
          verb: "see",
          format: "json",
          payload: {
            caption: "",
            ocr: "",
            detections: [],
            note: `see provider bound (${binding.run}); full exec wiring lands in Phase 5`,
          },
          media: { ref: resolvedRef },
          meta: { provider: "bound", case: ctx.case.dir },
          state: "pending",
        }),
      ];
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
            "see has no default provider in v1. Bind a VLM: `overcast setup provider see <http|module>`.",
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
  summary: "Produce better media (denoise/normalize/upscale/...) via the internal ffmpeg toolkit.",
  description:
    "Deterministic, modality-dispatched ops on the bundled ffmpeg. Emits a media.enhanced " +
    "record whose media.ref is the output path — chain it into watch/listen/see.",
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
        if (!at) at = `${a[0]}-${a[1]}`;
      }
    }

    if (!existsSync(mediaPath)) {
      return [errorRecord("view", `media not found: ${mediaPath}`)];
    }

    const modality = modalityFromExt(mediaPath);
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

    const htmlPath = join(ctx.case.mediaDir, "view.html");
    const html = buildPlayerHtml(mediaPath, modality, at, markers, ctx.opts.spectrogram === true);
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
          opened: !noOpen,
        },
        media: { ref: mediaPath, at: markers.length === 1 ? markers[0] : (markers.length === 2 ? [markers[0], markers[1]] as [number, number] : undefined) },
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
  spectrogram: boolean,
): string {
  const startAt = at ? Number(String(at).split("-")[0]) || 0 : 0;
  const tag = modality === "video" ? "video" : "audio";
  const markerPins = markers
    .map((m) => `<button class="pin" onclick="seek(${Number(m)})">⏱ ${Number(m)}s</button>`)
    .join("");
  // Build a proper file:// URL (encodes spaces/specials) and HTML-escape every
  // interpolated path so a filename with quotes/`<`/`&` can't break the
  // attribute or inject script into the generated page.
  const fileUrl = htmlAttr(pathToFileURL(src).href);
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
${spectrogram && modality === "audio" ? '<p class="note">spectrogram: render via `enhance --ops spectrogram` (todo)</p>' : ""}
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
