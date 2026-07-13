// Phase 2 sense + inspect verbs: listen (tinycloud speech-only), see
// (placeholder until a VLM is bound), enhance (internal ffmpeg), view
// (lightweight local player / OS-open). watch lives in registry/verbs.ts.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { isReady, makeRecord, type OvercastRecord } from "../record.js";
import { runListen } from "../providers/tinycloud/listen.js";
import { isCustomBinding, runBoundProvider, runExecProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import { seeWithBrain, brainSeeDisabled } from "../providers/brain/vision.js";
import { fetchMediaToCase, isHttpUrl, kindForExt } from "../media/fetch.js";
import { execCapture, parseFirstJson } from "../providers/exec.js";
import { resolveShippedArgv } from "../providers/shipped-ref.js";
import { tokenizeCommand } from "../providers/sources/index.js";
import { resolveMediaRef, resolveVideoArg } from "./media-ref.js";
import { provenanceCase, stampArchive } from "../archive.js";
import {
  probe,
  enhance as ffEnhance,
  defaultOps,
  extractFrame,
  parseFrameRef,
  parseAtSpan,
  modalityFromExt,
  spectrogram as ffSpectrogram,
  ENHANCE_OPS,
  type EnhanceOp,
  type Modality,
} from "../media/ffmpeg.js";
import { openHtmlPlayer, osOpen } from "../media/view.js";
import { escapeHtml, renderEnhanceGallery, type EnhanceGalleryItem, type EnhanceGalleryReport } from "../report/html.js";
import { providerEnv } from "../providers/provider-env.js";
import { provenanceFromCapture, stampProvenance } from "./provenance.js";
import { fanOutEnhance, hasFanOut } from "./enhance-fanout.js";
import { maybeReconstructViewer } from "./reconstruct.js";
import { shippedProviderPath } from "../pkg.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function hfToken(): string | undefined {
  return process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || undefined;
}

// ---- listen ----------------------------------------------------------------

export interface ListenDispatchOpts {
  describe?: boolean;
  diarize?: boolean;
  lang?: string;
}

/** Resolve the bound listen provider and run it (custom exec provider vs the
 *  tinycloud default), forwarding the declared flags. Shared by `listen` and by
 *  `enhance --summarize` (which transcribes each separated track). */
export async function dispatchListen(
  ctx: VerbContext,
  input: string,
  opts: ListenDispatchOpts = {},
): Promise<OvercastRecord> {
  const describe = opts.describe === true;
  const binding = providerBinding(ctx, "listen");
  // forward the declared listen flags to a custom provider, and give it the
  // same generous timeout the tinycloud mapper uses (long media).
  const extraArgs: string[] = [];
  if (describe) extraArgs.push("--describe");
  if (opts.diarize === true) extraArgs.push("--diarize");
  if (opts.lang) extraArgs.push("--lang", String(opts.lang));
  return isCustomBinding(binding)
    ? runBoundProvider("listen", binding!, input, {
        env: providerEnv(ctx.case.mediaDir),
        extraArgs,
        timeoutMs: 15 * 60_000,
        signal: ctx.signal,
      })
    : runListen(input, {
        run: binding?.run,
        describe,
        signal: ctx.signal,
        diarize: opts.diarize === true,
        lang: opts.lang ? String(opts.lang) : undefined,
      });
}

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
    const resolved = resolveVideoArg(ctx.case, ctx.input, "listen input", { requireReady: false, home: ctx.home });
    if (resolved.error) return [errorRecord("listen", resolved.error)];
    const input = resolved.ref ?? ctx.input;
    const rec = await dispatchListen(ctx, input, {
      describe: ctx.opts.describe === true,
      diarize: ctx.opts.diarize === true,
      lang: ctx.opts.lang ? String(ctx.opts.lang) : undefined,
    });
    rec.meta = { ...rec.meta, case: ctx.case.dir };
    // trace a transcript of a captured clip back to the post it came from,
    // and in-place archive sensing back to its bucket (like watch)
    stampProvenance(rec, provenanceFromCapture(provenanceCase(ctx.case, resolved.archive, ctx.home), input));
    return [stampArchive(rec, resolved.archive)];
  },
};

// ---- see (placeholder) -----------------------------------------------------

export const seeVerb: VerbSpec = {
  name: "see",
  group: "sense",
  summary: "Understand an image or a single video frame (caption, OCR, detections).",
  description:
    "Defaults to the BRAIN LLM when it supports images: a direct 'describe this image in detail' " +
    "call (turnkey with the Cloudglue brain, or any image-capable `setup llm`). Falls back to a " +
    "Hugging Face captioner when HF_TOKEN is set (override with HF_SEE_MODEL), else a placeholder " +
    "until a VLM is bound. Switch backends via `setup provider see builtin:hf` (classic HF) or " +
    "`builtin:brain`; disable the brain default with OVERCAST_SEE_BRAIN=off. Forwards --ocr/--prompt; " +
    "--detect needs a detection provider (OWLv2 for boxes, or the opt-in Cloudglue tinycloud see/extract " +
    "provider for boxless facts, tinycloud >= 0.3.7). Accepts frame://rec@sec (resolved via the internal ffmpeg " +
    "toolkit) and http(s) image URLs, fetched into the case media dir first (meta.source_url keeps " +
    "the origin).",
  args: [{ name: "input", summary: "Image path, http(s) image URL, video frame, or frame://rec@sec", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
    { name: "ocr", summary: "Extract on-image text", type: "boolean" },
    { name: "detect", summary: "Comma list of target objects to locate (bind the detect provider for bounding boxes)", type: "string" },
    { name: "prompt", summary: "Focus the description", type: "string" },
  ],
  outputKind: "image.analysis",
  providerKey: "see",
  run: async (ctx) => {
    if (!ctx.input) return [errorRecord("see", "see requires an image input")];

    // Stamp the case (+ URL provenance, once known) on EVERY outgoing see
    // record — successes and failures alike, so an error on a URL input still
    // carries meta.source_url.
    let sourceUrl: string | undefined;
    let archiveBucket: string | undefined;
    const stamp = (rec: OvercastRecord): OvercastRecord[] => {
      rec.meta = { ...rec.meta, case: ctx.case.dir, ...(sourceUrl ? { source_url: sourceUrl } : {}), ...(archiveBucket ? { archive: archiveBucket } : {}) };
      return [rec];
    };

    // resolve a frame:// reference to an extracted frame (still needs a VLM to analyze)
    let resolvedRef = ctx.input;
    const fr = parseFrameRef(ctx.input);
    if (fr) {
      // resolve the frame's SOURCE through the shared resolver so the record
      // part accepts a case record id, a capture id, OR an
      // archive:<bucket>/<item> ref (a clip cited from `ask --archive` lives in
      // the bucket, not the active case). A frame:// ref that can't be resolved
      // must FAIL clearly — never hand the literal "frame://…" to a provider.
      const fsrc = resolveMediaRef(ctx.case, fr.recordId, ctx.home);
      const src = fsrc.error ? undefined : fsrc.ref;
      if (!src || !existsSync(src)) {
        return stamp(errorRecord("see", `cannot resolve ${ctx.input}: ${fsrc.error ?? `record ${fr.recordId} has no media on disk`}`));
      }
      // a bucket source that's still materializing (pending/errored capture) has
      // a partial file — don't extract a frame from it (matches direct archive refs)
      if (fsrc.record && !isReady(fsrc.record)) {
        return stamp(errorRecord("see", `cannot extract ${ctx.input}: record ${fsrc.record.id} isn't ready (state=${fsrc.record.state ?? "?"})`));
      }
      archiveBucket = fsrc.archive;
      try {
        resolvedRef = await extractFrame(src, fr.second, ctx.case.mediaDir);
      } catch (e) {
        return stamp(errorRecord("see", `frame extraction failed for ${ctx.input}: ${(e as Error).message}`));
      }
    }

    // record ids / capture ids / archive:<bucket>/<item> refs resolve through
    // the SHARED resolver (like watch/listen/exif) — retired archive files and
    // in-flight bucket captures error here instead of slipping through as
    // literal paths.
    if (!fr && !isHttpUrl(resolvedRef)) {
      const r = resolveMediaRef(ctx.case, resolvedRef, ctx.home);
      if (r.error) return stamp(errorRecord("see", `see input: ${r.error}`));
      if (r.record && !isReady(r.record)) return stamp(errorRecord("see", `see input: record ${r.record.id} isn't ready (state=${r.record.state ?? "?"})`));
      resolvedRef = r.ref;
      archiveBucket = r.archive;
    }

    // An http(s) URL is fetched into the case media dir first (evidence, like
    // capture) so every backend — the brain LLM, the HF captioner, exec
    // detectors — reads a local file instead of choking on the URL. The record
    // keeps the origin in meta.source_url; media.ref is the local artifact.
    if (isHttpUrl(resolvedRef)) {
      sourceUrl = resolvedRef;
      let dl;
      try {
        dl = await fetchMediaToCase(resolvedRef, ctx.case.mediaDir, { signal: ctx.signal });
      } catch (e) {
        return stamp(errorRecord("see", `could not fetch ${resolvedRef}: ${(e as Error).message}`));
      }
      const kind = kindForExt(dl.ext);
      if (kind === "av") {
        return stamp(
          errorRecord(
            "see",
            `${resolvedRef} resolved to ${dl.ext.slice(1)} media (saved to ${dl.path}) — see analyzes still ` +
              "images; run `watch`/`listen` on it, or `see frame://<record>@<sec>` for a single frame",
          ),
        );
      }
      if (kind === "other") {
        const bodyNote = dl.ext === ".html" ? ", body is HTML" : dl.ext === ".txt" ? ", body is text" : "";
        return stamp(
          errorRecord(
            "see",
            `${resolvedRef} did not return an image (content-type ${dl.contentType ?? "unknown"}${bodyNote}) — ` +
              "check the link (login walls and expired signed URLs commonly return HTML)",
          ),
        );
      }
      resolvedRef = dl.path;
    }

    // Provider resolution for see:
    //  0. a built-in backend selector — `setup provider see builtin:brain|builtin:hf`
    //     forces one path (see below), else
    //  1. an explicit profile binding (exec runs it; http/inproc → explicit
    //     error rather than being silently ignored), else
    //  2. the BRAIN LLM when it supports images (the new turnkey default), else
    //  3. the shipped Hugging Face captioner when HF_TOKEN is set, else
    //  4. the placeholder (needs_credentials + guidance).
    const binding = providerBinding(ctx, "see");
    const builtin = binding?.module?.startsWith("builtin:") ? binding.module.slice("builtin:".length) : undefined;
    if (builtin && builtin !== "brain" && builtin !== "hf") {
      return stamp(errorRecord("see", `unknown built-in see backend 'builtin:${builtin}' (expected builtin:brain or builtin:hf)`));
    }
    const forceBrain = builtin === "brain";
    const forceHf = builtin === "hf";
    const seeEnv = providerEnv(ctx.case.mediaDir);
    // forward the declared see flags to whichever provider runs (custom or HF).
    const extraArgs: string[] = [];
    if (ctx.opts.ocr === true) extraArgs.push("--ocr");
    if (ctx.opts.detect) extraArgs.push("--detect", String(ctx.opts.detect));
    if (ctx.opts.prompt) extraArgs.push("--prompt", String(ctx.opts.prompt));
    // A real custom binding (exec/http/inproc) wins — but NOT a `builtin:` selector,
    // which is handled by the brain/HF branches below.
    if (isCustomBinding(binding) && !builtin) {
      // --detect needs a detection-capable provider. If the bound provider's
      // `describe` clearly declares no detection (no "detections" payload / detect
      // task), fail fast instead of handing --detect to a captioner that ignores
      // it and returns a caption. Lenient: an unavailable/unparseable describe just
      // proceeds (don't block a working provider on a describe hiccup).
      if (ctx.opts.detect && binding!.describe) {
        // resolve `shipped:` refs in the describe command; an unresolvable ref
        // skips the preflight (lenient, like an unavailable describe) — the run
        // itself surfaces the clear "build lacks shipped provider files" record.
        let dp: string[] | undefined;
        try {
          dp = resolveShippedArgv(tokenizeCommand(binding!.describe));
        } catch {
          dp = undefined;
        }
        const dres = dp
          ? await execCapture(dp[0], dp.slice(1), { signal: ctx.signal, timeoutMs: 30_000 }).catch(() => undefined)
          : undefined;
        if (dres && dres.code === 0) {
          const d = parseFirstJson(dres.stdout) as Record<string, unknown> | undefined;
          const payload = d && Array.isArray(d.payload) ? (d.payload as unknown[]) : [];
          const task = d && typeof d.task === "string" ? d.task : "";
          if (!payload.includes("detections") && !/detect/i.test(task)) {
            return stamp(
              makeRecord({
                verb: "see",
                format: "json",
                payload: { caption: "", ocr: "", detections: [], detect: String(ctx.opts.detect) },
                error:
                  "the bound see provider doesn't support --detect (its describe declares no detections); " +
                  "bind a detector: `overcast provider setup apply --preset owl-local --yes` (run " +
                  "`scripts/visual-db-uv.sh --detect` once and export the printed DETECT_PY — the venv " +
                  "python; system python3 lacks the deps).",
                state: "error",
              }),
            );
          }
        }
      }
      const rec = await runBoundProvider("see", binding!, resolvedRef, {
        env: seeEnv,
        extraArgs,
        signal: ctx.signal,
      });
      return stamp(rec);
    }
    // --detect needs a detection provider. The turnkey HF captioner / placeholder
    // below can't detect, so fail clearly instead of passing the label list to a
    // captioner (which would mistake it for the image path).
    if (ctx.opts.detect) {
      return stamp(
        makeRecord({
          verb: "see",
          format: "json",
          payload: { caption: "", ocr: "", detections: [], detect: String(ctx.opts.detect) },
          error:
            "see --detect needs a detection provider; bind one: " +
            "`overcast provider setup apply --preset owl-local --yes` (OWLv2 — run " +
            "`scripts/visual-db-uv.sh --detect` once and export the printed DETECT_PY venv python first).",
          state: "error",
        }),
      );
    }
    // New default: describe with the BRAIN LLM when it supports images (BYO).
    // Forced on with `builtin:brain`; skipped for `builtin:hf` or when disabled
    // via OVERCAST_SEE_BRAIN=off. On "unavailable" (no image-capable brain) we
    // fall through to HF/placeholder — unless the brain was explicitly forced.
    if (!forceHf && (forceBrain || !brainSeeDisabled())) {
      const res = await seeWithBrain(resolvedRef, {
        profile: ctx.profile,
        caseDir: ctx.case.dir,
        prompt: ctx.opts.prompt ? String(ctx.opts.prompt) : undefined,
        ocr: ctx.opts.ocr === true,
        signal: ctx.signal,
      });
      if (res.kind === "record") return stamp(res.record);
      if (forceBrain) {
        return stamp(
          errorRecord(
            "see",
            `see (brain) can't run: ${res.reason}. Configure an image-capable brain (\`setup llm\`), ` +
              "or switch backends with `overcast setup provider see builtin:hf` / `setup provider see <spec>`.",
          ),
        );
      }
      // else: no image-capable brain — fall through to the HF captioner / placeholder.
    }

    // Classic Hugging Face captioner: the fallback default, and the switchable
    // "old implementation" (`builtin:hf` runs it even when a brain is available;
    // with no HF_TOKEN it self-reports needs_credentials).
    if (hfToken() || forceHf) {
      const hf = shippedProviderPath("senses", "hf", "see.sh");
      if (hf) {
        // pass --input explicitly (like execDescriptor) so the media path is never
        // argv[1] and a file named "init"/"describe" can't trigger that subcommand.
        const rec = await runExecProvider("see", `bash ${hf} --input {{input}}`, resolvedRef, {
          env: seeEnv,
          extraArgs,
          signal: ctx.signal,
        });
        return stamp(rec);
      }
      if (forceHf) {
        return stamp(errorRecord("see", "the Hugging Face see provider script isn't available in this build"));
      }
    }

    return stamp(
      makeRecord({
        verb: "see",
        format: "json",
        payload: {
          caption: "",
          ocr: "",
          detections: [],
          guidance:
            "see has no image-capable brain and no VLM bound. Configure a brain (`setup llm`, or a " +
            "Cloudglue key for the turnkey brain), set HF_TOKEN for the Hugging Face captioner, or bind " +
            "a VLM with `setup provider see <spec>`.",
        },
        media: { ref: resolvedRef },
        meta: { provider: "placeholder" },
        state: "needs_credentials",
      }),
    );
  },
};

// ---- enhance (internal ffmpeg + bound split providers) ---------------------

// Ops that CANNOT run on the internal ffmpeg toolkit — they fan a single input
// out into many derived artifacts and require a bound model/analysis provider
// (local-models, fal, or a shipped example script). separate/segment split media
// into tracks/cutouts; ela overlays forensic maps; panorama stitches a wide still.
const PROVIDER_ONLY_OPS: ReadonlySet<string> = new Set(["separate", "segment", "ela", "panorama"]);

/** Remediation hint tailored to the provider-only op family — ela/panorama are
 *  shipped catalog choices; separate/segment need the local-models (or fal) preset.
 *  Shared by the no-binding and the wrong-provider (single-output) error paths so a
 *  user is never told to bind a split preset for an op that doesn't use one. */
function providerOpHint(op: string): string {
  return op === "ela" || op === "panorama"
    ? `Bind one with \`overcast provider setup apply --verb enhance --choice ${op} --yes\` ` +
        `(${op === "panorama" ? "opencv-python + numpy" : "pillow + numpy"}).`
    : `Run \`overcast provider setup plan --preset local-models\` (or --preset fal) then \`--yes\`; ` +
        `local-models needs \`scripts/visual-db-uv.sh --enhance\`.`;
}

/** For each separated-voice track record, transcribe it via the bound listen
 *  provider and fold the transcript + a short spoken-summary onto the track
 *  record itself (self-contained evidence). Non-fatal per track: a failed
 *  transcription just attaches `transcript_error`. No brain-LLM call (invariant
 *  #2) — the "summary" is the provider's own summary field or a truncation. */
async function summarizeTracks(ctx: VerbContext, recs: OvercastRecord[]): Promise<void> {
  for (const r of recs) {
    if (typeof r.payload !== "object" || r.payload == null) continue;
    const p = r.payload as Record<string, unknown>;
    if (p.kind !== "track") continue;
    const ref = r.media?.ref;
    if (!ref) continue;
    try {
      const listenRec = await dispatchListen(ctx, ref, {});
      if (listenRec.state && listenRec.state !== "ready") {
        p.transcript_error = listenRec.error ?? `listen ${listenRec.state}`;
        continue;
      }
      const lp =
        typeof listenRec.payload === "object" && listenRec.payload != null
          ? (listenRec.payload as Record<string, unknown>)
          : {};
      const transcript = typeof lp.transcript === "string" ? lp.transcript : undefined;
      if (transcript) p.transcript = transcript;
      const spoken =
        typeof lp.summary === "string" && lp.summary
          ? lp.summary
          : transcript
            ? transcript.slice(0, 300) + (transcript.length > 300 ? "…" : "")
            : undefined;
      if (spoken) {
        const base = typeof p.summary === "string" && p.summary ? `${p.summary} — ` : "";
        p.summary = base + spoken;
      }
      if (listenRec.meta?.provider) p.listen_provider = listenRec.meta.provider;
    } catch (e) {
      p.transcript_error = (e as Error).message;
    }
  }
}

export const enhanceVerb: VerbSpec = {
  name: "enhance",
  group: "sense",
  summary: "Produce better media (denoise/normalize/upscale), split it (separate voices / segment objects), or derive analysis artifacts (ela forensic overlays / panorama stitch) via ffmpeg or a bound provider.",
  description:
    "Default: deterministic, modality-dispatched ops on the bundled ffmpeg (denoise/normalize/" +
    "voice-isolate/upscale/stabilize/grayscale). Bind a model/analysis provider for AI restoration or the " +
    "PROVIDER-ONLY ops via `setup provider enhance <spec>`: `--ops separate` splits an audio/video's voices " +
    "into per-speaker tracks (add --summarize to transcribe each), `--ops segment --prompt \"<thing>\"` " +
    "cuts requested objects out of an image as mask + cutout evidence, `--ops ela` derives ELA/noise/" +
    "luminance forensic overlays from an image (heuristic edit-detection leads), `--ops panorama` stitches " +
    "a panning video into one wide still (skyline/landmark exposure for geolocation). These ops need a bound " +
    "provider (local-models = pyannote + GroundingDINO/SAM2, fal = sam-audio + sam-3, or the shipped " +
    "ela/panorama catalog choices); image segmentation/ela of a video is out of scope " +
    "(run on a frame:// still). Emits a media.enhanced record per output — for the fan-out ops, one child " +
    "record per track/mask/overlay whose media.ref chains into watch/listen/see/view/crop.",
  args: [{ name: "input", summary: "Media file path", required: true }],
  flags: [
    { name: "ops", summary: "Comma list of ops (denoise,normalize,upscale,separate,segment,ela,panorama,...)", type: "string" },
    { name: "prompt", summary: "What to segment (--ops segment) or the target voice to extract", type: "string" },
    { name: "speakers", summary: "Speaker-count hint for --ops separate", type: "string" },
    { name: "summarize", summary: "Transcribe/summarize each separated track via the bound listen provider", type: "boolean" },
    { name: "masks-only", summary: "For --ops segment, emit binary masks instead of RGBA cutouts", type: "boolean" },
    { name: "out", summary: "Output path (default .overcast/media/)", type: "string" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.enhanced",
  providerKey: "enhance",
  run: async (ctx) => {
    if (!ctx.input) return [errorRecord("enhance", "enhance requires a media input")];
    // resolve a frame:// reference to an extracted still first — so the documented
    // "segment a video frame" path (enhance frame://rec@sec --ops segment) works,
    // mirroring `see`. Never hand a literal frame://… string to a provider.
    let input = ctx.input;
    // provenance is traced from the ORIGINAL media, not the extracted still: a
    // frame:// still is not itself a capture, so provenanceFromCapture must look up
    // the source clip the frame came from (else the video-frame path loses it).
    let provenanceSource = ctx.input;
    // record ids / capture ids / archive:<bucket>/<item> refs resolve through
    // the SHARED resolver (like watch/listen/see); retired archive files error.
    let archiveBucket: string | undefined;
    const fr = parseFrameRef(ctx.input);
    if (fr) {
      // resolve the frame's SOURCE through the shared resolver so a bucket clip
      // (cited from `ask --archive`, addressed archive:<bucket>/<item>) works too.
      const fsrc = resolveMediaRef(ctx.case, fr.recordId, ctx.home);
      const src = fsrc.error ? undefined : fsrc.ref;
      if (!src || !existsSync(src)) {
        return [errorRecord("enhance", `cannot resolve ${ctx.input}: ${fsrc.error ?? `record ${fr.recordId} has no media on disk`}`)];
      }
      if (fsrc.record && !isReady(fsrc.record)) {
        return [errorRecord("enhance", `cannot extract ${ctx.input}: record ${fsrc.record.id} isn't ready (state=${fsrc.record.state ?? "?"})`)];
      }
      provenanceSource = src;
      archiveBucket = fsrc.archive;
      try {
        input = await extractFrame(src, fr.second, ctx.case.mediaDir);
      } catch (e) {
        return [errorRecord("enhance", `frame extraction failed for ${ctx.input}: ${(e as Error).message}`)];
      }
    }
    if (!fr) {
      const r = resolveMediaRef(ctx.case, input, ctx.home);
      if (r.error) return [errorRecord("enhance", `enhance input: ${r.error}`)];
      if (r.record && !isReady(r.record)) return [errorRecord("enhance", `enhance input: record ${r.record.id} isn't ready (state=${r.record.state ?? "?"})`)];
      input = r.ref;
      provenanceSource = r.ref;
      archiveBucket = r.archive;
    }
    if (!existsSync(input)) {
      return [errorRecord("enhance", `input not found: ${input}`)];
    }
    // parse ops loosely first: the split ops (separate/segment) are NOT ffmpeg
    // ops — they REQUIRE a bound provider. Gate them before the ffmpeg cast so a
    // helpful error fires instead of ffmpeg choking on an unknown filter. Ops are
    // normalized to lowercase so `Separate`/`SEGMENT` still hit the split guards
    // (and the ffmpeg op set is lowercase too).
    const opsStr = ctx.opts.ops ? String(ctx.opts.ops) : "";
    const rawOps = opsStr.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const enhBinding = providerBinding(ctx, "enhance");
    const providerOps = rawOps.filter((o) => PROVIDER_ONLY_OPS.has(o));

    // Reject unrecognized ops up front (known = ffmpeg ops + split ops). Without
    // this a typo like `--ops segement` slips past the split-op checks and gets
    // forwarded to a bound toolbox, which falls through to its DEFAULT enhance —
    // a failed split op that looks like success. Fail loudly at the chokepoint.
    const KNOWN_OPS = new Set<string>([...ENHANCE_OPS, ...PROVIDER_ONLY_OPS]);
    const unknownOps = rawOps.filter((o) => !KNOWN_OPS.has(o));
    if (unknownOps.length) {
      return [
        errorRecord(
          "enhance",
          `unknown --ops: ${unknownOps.join(", ")}. Valid ops: ${[...ENHANCE_OPS, ...PROVIDER_ONLY_OPS].join(", ")}.`,
        ),
      ];
    }

    // A provider-only op (separate/segment/ela/panorama) can't compose with any
    // other op: the toolbox providers dispatch to exactly ONE handler, so
    // `--ops segment,separate` or `--ops ela,denoise` would silently drop the rest.
    // Require it solo.
    if (providerOps.length && rawOps.length !== 1) {
      return [
        errorRecord(
          "enhance",
          `a provider-only op (${providerOps.join(", ")}) must be the only --ops value (got: ${rawOps.join(",")}). Run these ops one at a time.`,
        ),
      ];
    }

    // A bound enhance provider (e.g. the HF model-ops provider, or the local /
    // fal split providers) takes over; the DEFAULT stays the internal ffmpeg
    // toolkit (invariant #7). Bind via `setup provider enhance <spec>`.
    if (isCustomBinding(enhBinding)) {
      // forward the declared flags to the provider ONLY when set, so existing
      // single-output bindings (hf/fal/elevenlabs) still get byte-identical argv.
      const extraArgs: string[] = [];
      // forward the NORMALIZED ops (lowercased) so a bound toolbox matches
      // `separate`/`segment` even if the user typed `Separate`.
      if (rawOps.length) extraArgs.push("--ops", rawOps.join(","));
      if (ctx.opts.prompt) extraArgs.push("--prompt", String(ctx.opts.prompt));
      if (ctx.opts.speakers) extraArgs.push("--speakers", String(ctx.opts.speakers));
      if (ctx.opts["masks-only"] === true) extraArgs.push("--masks-only");
      // dispatch by transport (exec runs it; http/inproc return an explicit
      // error) rather than silently falling back to ffmpeg. Local CPU models
      // (pyannote / SAM2) blow the 5-min default, so allow 15 min.
      const rec = await runBoundProvider("enhance", enhBinding!, input, {
        env: providerEnv(ctx.case.mediaDir),
        extraArgs: extraArgs.length ? extraArgs : undefined,
        timeoutMs: 15 * 60_000,
        signal: ctx.signal,
      });
      // Guard split-op results. A ready record that does NOT fan out is one of
      // three cases, only one of which is valid:
      //   1. declared a non-empty outputs[] that fails validation (item missing
      //      kind/ref) — MALFORMED: fanOutEnhance would silently drop it to just
      //      the parent, losing the artifacts. Fail loudly.
      //   2. no outputs[] and payload.op doesn't echo the requested op — a
      //      single-output provider (hf/esrgan/voice-isolator) ignored --ops.
      //   3. empty/absent outputs[] and payload.op matches — a legit "nothing
      //      produced" (e.g. a segment prompt that matched nothing). Allowed.
      const recPayload =
        typeof rec.payload === "object" && rec.payload ? (rec.payload as Record<string, unknown>) : {};
      const recOp = recPayload.op;
      const declaredOutputs = Array.isArray(recPayload.outputs) ? recPayload.outputs : undefined;
      if (providerOps.length && rec.state === "ready" && !hasFanOut(rec)) {
        if (declaredOutputs && declaredOutputs.length > 0) {
          return [
            errorRecord(
              "enhance",
              `the '${providerOps[0]}' provider returned malformed outputs[] (each item needs a string 'ref' and 'kind'); no artifacts were expanded.`,
            ),
          ];
        }
        if (recOp !== providerOps[0]) {
          return [
            errorRecord(
              "enhance",
              `the bound enhance provider did not perform '--ops ${providerOps[0]}' (it returned a single output). ` +
                providerOpHint(providerOps[0]),
            ),
          ];
        }
        // else: op matches + no outputs → a valid empty result, fall through.
      }
      // expand a multi-output envelope (per-speaker tracks / per-instance masks)
      // into [parent, ...children]; single-output providers pass through.
      const recs = fanOutEnhance(rec, { caseDir: ctx.case.dir });
      const prov = provenanceFromCapture(provenanceCase(ctx.case, archiveBucket, ctx.home), provenanceSource);
      for (const r of recs) {
        r.meta = { ...r.meta, case: ctx.case.dir };
        stampProvenance(r, prov);
        stampArchive(r, archiveBucket);
      }
      // --summarize: transcribe each separated track through the bound listen
      // provider, embedding transcript+summary on the track record itself.
      if (ctx.opts.summarize === true) {
        await summarizeTracks(ctx, recs);
      }
      return recs;
    }

    // no custom binding: the provider-only ops can't run on ffmpeg.
    if (providerOps.length) {
      return [
        errorRecord(
          "enhance",
          `--ops ${providerOps.join(",")} needs a bound enhance provider. ${providerOpHint(providerOps[0])}`,
        ),
      ];
    }

    const requested = rawOps.length ? (rawOps as EnhanceOp[]) : undefined;
    const outDir = ctx.case.mediaDir;
    try {
      const p = await probe(input).catch(() => ({ modality: modalityFromExt(input) }) as Awaited<ReturnType<typeof probe>>);
      const ops = requested ?? defaultOps(p.modality);
      if (ops.length === 0) {
        return [errorRecord("enhance", `no enhance ops apply to modality '${p.modality}'`)];
      }
      const result = await ffEnhance(
        input,
        ops,
        outDir,
        ctx.opts.out ? String(ctx.opts.out) : undefined,
      );
      const ffRec = makeRecord({
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
      });
      // trace back to the originating post — same as the bound-provider path, and
      // for the frame:// path use the ORIGINAL clip (provenanceSource), not the still.
      stampProvenance(ffRec, provenanceFromCapture(provenanceCase(ctx.case, archiveBucket, ctx.home), provenanceSource));
      return [stampArchive(ffRec, archiveBucket)];
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
    "record's media.at) and opens it. For other files, uses the OS open command. Given an `enhance` " +
    "split-op PARENT record (--ops separate/segment), renders a GALLERY of its fanned-out children " +
    "instead — per-speaker audio players + spectrograms for separate (with cross-talk regions), or " +
    "cutout/mask images for segment. Given a `reconstruct` record, renders its dedicated viewer: a " +
    "speculative gallery (view/sweep), an embedded 3D orbit viewer (model / mesh children), or a " +
    "drag-parallax hologram (depth). --no-open writes the viewer and emits a view record with its path.",
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
    let archiveBucket: string | undefined;
    let at = ctx.opts.at ? String(ctx.opts.at) : undefined;
    const rec = ctx.case.recordById(ctx.input);
    // a pending/errored CASE record's partial media must not be opened — the
    // recordById fast-path would otherwise skip the readiness gate the archive-ref
    // branch below (and see/enhance/exif/verify) all apply (thread-2 class).
    if (rec && !isReady(rec)) return [errorRecord("view", `view input: record ${rec.id} isn't ready (state=${rec.state ?? "?"})`)];
    if (!rec) {
      // capture ids / archive:<bucket>/<item> refs / raw bucket paths go through
      // the SHARED resolver (retired archive files error, like the senses)
      const r = resolveMediaRef(ctx.case, ctx.input, ctx.home);
      if (r.error) return [errorRecord("view", `view input: ${r.error}`)];
      if (r.record && !isReady(r.record)) return [errorRecord("view", `view input: record ${r.record.id} isn't ready (state=${r.record.state ?? "?"})`)];
      mediaPath = r.ref;
      archiveBucket = r.archive;
    }
    if (rec?.media?.ref) {
      mediaPath = rec.media.ref;
      // a record already stamped with its bucket (e.g. a `capture archive:…`
      // copy) carries that trace onto the view record too
      if (typeof rec.meta?.archive === "string") archiveBucket = rec.meta.archive;
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

    // An enhance split-op PARENT record → render a gallery of its fanned-out
    // children (per-track audio + spectrograms, or cutout/mask images) instead of
    // the parent's single source media. Falls through when it isn't such a parent.
    if (rec) {
      const gallery = await maybeEnhanceGallery(ctx, rec);
      if (gallery) return [gallery];
      // reconstruct records get their dedicated viewers (gallery of synthesized
      // stops, 3D orbit for a mesh, drag-parallax for a depth map) — same seam.
      const reconstruction = maybeReconstructViewer(ctx, rec);
      if (reconstruction) return [reconstruction];
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
          meta: { provider: "view", case: ctx.case.dir, ...(archiveBucket ? { archive: archiveBucket } : {}) },
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
        meta: { provider: "view", case: ctx.case.dir, ...(archiveBucket ? { archive: archiveBucket } : {}) },
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

/** Provider-only enhance ops whose PARENT record fans out into gallery-able
 *  children (audio tracks / image cutouts / forensic overlays / a stitched still).
 *  Keep in sync with the fan-out ops in PROVIDER_ONLY_OPS. */
const GALLERY_OPS: ReadonlySet<string> = new Set(["separate", "segment", "ela", "panorama"]);

/** If `rec` is an enhance fan-out PARENT (payload.op in GALLERY_OPS), render an
 *  HTML gallery of its fanned-out children and return the view record; else null
 *  (so `view` falls through to its single-media player). A parent is identified by
 *  op + the ABSENCE of a top-level `kind` — a fanned-out CHILD carries `kind`
 *  (track/cutout/mask/ela/noise/luminance/panorama). This (not an outputs[] check)
 *  is used so a valid EMPTY result — op matches with outputs empty OR absent
 *  (handler guard case 3) — still renders the gallery, while children play/show
 *  normally. `source_record` isn't a discriminator: a parent can carry it too
 *  (capture provenance). */
async function maybeEnhanceGallery(ctx: VerbContext, rec: OvercastRecord): Promise<OvercastRecord | null> {
  if (rec.verb !== "enhance" || typeof rec.payload !== "object" || !rec.payload) return null;
  const p = rec.payload as Record<string, unknown>;
  const op = p.op;
  if (typeof op !== "string" || !GALLERY_OPS.has(op) || typeof p.kind === "string") return null;
  const children = ctx.case.records().filter(
    (r) => r.verb === "enhance" && (r.payload as Record<string, unknown> | undefined)?.source_record === rec.id,
  );

  const items: EnhanceGalleryItem[] = [];
  for (const child of children) {
    const cp = (typeof child.payload === "object" && child.payload ? child.payload : {}) as Record<string, unknown>;
    const ref = child.media?.ref;
    if (typeof ref !== "string") continue;
    const item: EnhanceGalleryItem = {
      kind: typeof cp.kind === "string" ? cp.kind : "output",
      ref,
      label: typeof cp.speaker === "string" ? cp.speaker : typeof cp.label === "string" ? cp.label : undefined,
      score: typeof cp.score === "number" ? cp.score : undefined,
      speechSeconds: typeof cp.speech_seconds === "number" ? cp.speech_seconds : undefined,
      segments: Array.isArray(cp.segments) ? cp.segments.length : undefined,
      transcript: typeof cp.transcript === "string" ? cp.transcript : undefined,
    };
    // a spectrogram makes the separation legible — best-effort (needs local audio).
    if (op === "separate" && existsSync(ref)) {
      item.spectrogram = await ffSpectrogram(ref, ctx.case.mediaDir).catch(() => undefined);
    }
    items.push(item);
  }
  // no early return on empty items — a valid count-0 parent still renders the
  // gallery (renderEnhanceGallery shows an explicit empty state).

  const overlaps = Array.isArray(p.overlap)
    ? (p.overlap as Array<Record<string, unknown>>)
        .map((o) => ({ at: o?.at, speakers: o?.speakers }))
        .filter((o): o is { at: [number, number]; speakers: string[] } =>
          Array.isArray(o.at) && o.at.length === 2 && o.at.every((n) => typeof n === "number") && Array.isArray(o.speakers))
    : undefined;

  const report: EnhanceGalleryReport = {
    op,
    title: `enhance ${op}`,
    subtitle: typeof p.input === "string" ? (p.input.split("/").pop() ?? rec.id) : rec.id,
    sourceRef: rec.media?.ref,
    model: typeof p.model === "string" ? p.model : typeof p.detect_model === "string" ? p.detect_model : undefined,
    caveat: typeof p.caveat === "string" ? p.caveat : undefined,
    overlaps,
    items,
  };
  const htmlPath = join(ctx.case.mediaDir, `enhance-gallery-${rec.id}.html`);
  writeFileSync(htmlPath, renderEnhanceGallery(report), "utf8");
  if (ctx.opts["no-open"] !== true) openHtmlPlayer(htmlPath);
  return makeRecord({
    verb: "view",
    format: "json",
    payload: { mode: op === "separate" ? "separation" : op === "segment" ? "segmentation" : op, op, viewer: htmlPath, items: items.length, source_record: rec.id },
    media: { ref: htmlPath },
    meta: { case: ctx.case.dir },
    state: "ready",
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
  const parsed = at ? parseAtSpan(String(at)) : undefined;
  const startAt = parsed == null ? 0 : Array.isArray(parsed) ? parsed[0] : parsed;
  const tag = modality === "video" ? "video" : "audio";
  const markerPins = markers
    .map((m) => `<button class="pin" onclick="seek(${Number(m)})">⏱ ${Number(m)}s</button>`)
    .join("");
  // For local files build a proper file:// URL (encodes spaces/specials); a
  // remote http(s) URL is used as-is. Either way HTML-escape every interpolated
  // path so a filename with quotes/`<`/`&` can't break the attribute or inject
  // script into the generated page.
  const fileUrl = escapeHtml(isRemote ? src : pathToFileURL(src).href);
  const nameEsc = escapeHtml(basenameOf(src));
  const srcEsc = escapeHtml(src);
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
${spectrogramPath ? `<img src="${escapeHtml(pathToFileURL(spectrogramPath).href)}" alt="spectrogram" style="width:100%;max-width:1024px;border:1px solid #1f9d57;margin-top:12px"/>` : ""}
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
