// Media-forensics / geolocation senses: exif (ExifTool metadata + GPS), and —
// added in later waves — verify (C2PA provenance) and geolocate (Picarta). Each
// analyzes a captured/sensed artifact and emits an evidence record. They share
// one runner: resolve the input (path / http URL fetched into the case / case
// record id), dispatch to a bound provider or the shipped default exec script,
// then stamp case + source-post provenance — mirroring the see/listen senses
// (src/verbs/senses.ts) so behavior can't drift.

import { existsSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../record.js";
import { isCustomBinding, runBoundProvider, runExecProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import { providerEnv } from "../providers/provider-env.js";
import { fetchMediaToCase, isHttpUrl, kindForExt } from "../media/fetch.js";
import { resolveMediaRef, isImage } from "./media-ref.js";
import { provenanceFromCapture, stampProvenance } from "./provenance.js";
import { shippedPath } from "../pkg.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function errorRecord(verb: string, message: string): OvercastRecord {
  return makeRecord({ verb, format: "json", payload: { error: message }, error: message, state: "error" });
}

interface SenseConfig {
  verb: string;
  /** shipped default provider script, as shippedPath() segments */
  shipped: string[];
  /** input resolution: "media" = any file (exif/verify), "image" = still only (geolocate) */
  resolve: "media" | "image";
}

/** Shared runner for the forensic senses. */
async function runForensicSense(ctx: VerbContext, cfg: SenseConfig): Promise<OvercastRecord[]> {
  if (!ctx.input) return [errorRecord(cfg.verb, `${cfg.verb} requires a media input`)];

  let sourceUrl: string | undefined;
  let ref = ctx.input;

  // stamp case + URL origin + source-post provenance on EVERY outgoing record
  // (successes and failures) so an error on a URL still carries meta.source_url.
  const stamp = (rec: OvercastRecord): OvercastRecord[] => {
    rec.meta = { ...rec.meta, case: ctx.case.dir, ...(sourceUrl ? { source_url: sourceUrl } : {}) };
    stampProvenance(rec, provenanceFromCapture(ctx.case, ref));
    return [rec];
  };

  // resolve the input to a local file, in three steps:
  // 1) a case record/capture id → its media.ref (which may be a local path OR a
  //    remote URL — scan hits carry http media.ref).
  if (!isHttpUrl(ref)) ref = resolveMediaRef(ctx.case, ref).ref;
  // 2) a remote ref — passed directly OR resolved from a scan hit — is fetched
  //    into the case first (like see/capture) so providers read a local file.
  //    Without this a scan hit's http media.ref would reach the provider as
  //    --input and fail its local-file check.
  if (isHttpUrl(ref)) {
    sourceUrl = ref;
    let dl;
    try {
      dl = await fetchMediaToCase(ref, ctx.case.mediaDir, { signal: ctx.signal });
    } catch (e) {
      return stamp(errorRecord(cfg.verb, `could not fetch ${sourceUrl}: ${(e as Error).message}`));
    }
    // image-only senses (geolocate) must validate the FETCHED content, not just
    // local paths — else a URL resolving to video/HTML reaches the provider
    // (wasted API call, misleading error). Mirrors the `see` sense.
    if (cfg.resolve === "image" && kindForExt(dl.ext) !== "image") {
      return stamp(
        errorRecord(
          cfg.verb,
          `${sourceUrl} did not resolve to a still image (got ${dl.ext ? dl.ext.slice(1) : dl.contentType ?? "unknown"}, saved to ${dl.path}) — ${cfg.verb} needs an image`,
        ),
      );
    }
    ref = dl.path;
  }
  // 3) local file: must exist; image-only senses must get an image.
  if (!existsSync(ref)) return stamp(errorRecord(cfg.verb, `${cfg.verb}: file not found: ${ref}`));
  if (cfg.resolve === "image" && !isImage(ref)) {
    return stamp(errorRecord(cfg.verb, `${cfg.verb}: ${ref} is not an image file`));
  }

  // dispatch: a bound provider wins; else the shipped default exec script.
  const binding = providerBinding(ctx, cfg.verb);
  const env = providerEnv(ctx.case.mediaDir);
  if (isCustomBinding(binding)) {
    return stamp(await runBoundProvider(cfg.verb, binding!, ref, { env, signal: ctx.signal }));
  }
  const script = shippedPath(...cfg.shipped);
  if (!script) return stamp(errorRecord(cfg.verb, `the ${cfg.verb} provider script isn't available in this build`));
  // explicit --input placement so the media path is never argv[1] (a file named
  // "run"/"describe" can't trigger that subcommand), matching the see/HF path.
  return stamp(await runExecProvider(cfg.verb, `bash ${script} --input {{input}}`, ref, { env, signal: ctx.signal }));
}

// ---- exif (ExifTool metadata + GPS) ----------------------------------------

export const exifVerb: VerbSpec = {
  name: "exif",
  group: "sense",
  summary: "Extract embedded metadata — GPS, capture time, device — from an image or video (ExifTool).",
  description:
    "Runs ExifTool over an image or video and emits a media.metadata record: a searchable summary plus " +
    "GPS coordinates (signed decimals), capture time, camera make/model, editing software, MIME/dimensions/" +
    "duration, and a total tag count. The default backend is the shipped ExifTool provider (system `exiftool` " +
    "on PATH; install with `brew install exiftool` / `apt install libimage-exiftool-perl`); bind your own with " +
    "`setup provider exif <spec>`. Accepts a path, a case record/capture id, or an http(s) URL (fetched into " +
    "the case media dir first). The full raw tag dump stays in-provider — only the compact summary is indexed.",
  args: [{ name: "input", summary: "Image/video/file path, case record id, or http(s) URL", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.metadata",
  providerKey: "exif",
  run: (ctx) => runForensicSense(ctx, { verb: "exif", shipped: ["examples", "providers", "exif", "exif.sh"], resolve: "media" }),
};

// ---- verify (C2PA / Content Credentials provenance) ------------------------

export const verifyVerb: VerbSpec = {
  name: "verify",
  group: "sense",
  summary: "Check a media file's C2PA / Content Credentials provenance manifest (c2patool).",
  description:
    "Reads the embedded C2PA / Content Credentials manifest of an image or video and emits a " +
    "media.provenance record: whether a signed manifest is present, the claim generator, the signer/" +
    "certificate issuer, the signature algorithm, the validation state + codes, and assertion/ingredient " +
    "counts. Media with no credentials is a clean `ready` record (`has_manifest: false`), not an error. " +
    "The default backend is the shipped c2patool provider (system `c2patool` on PATH; install with " +
    "`brew install c2patool`); bind your own with `setup provider verify <spec>`. Accepts a path, a case " +
    "record/capture id, or an http(s) URL. Distinct from source-post provenance (where a record came from) " +
    "— this checks the media's own embedded credentials.",
  args: [{ name: "input", summary: "Image/video/file path, case record id, or http(s) URL", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.provenance",
  providerKey: "verify",
  run: (ctx) => runForensicSense(ctx, { verb: "verify", shipped: ["examples", "providers", "verify", "verify.sh"], resolve: "media" }),
};

// ---- geolocate (content-based image geolocation) ---------------------------

export const geolocateVerb: VerbSpec = {
  name: "geolocate",
  group: "sense",
  summary: "Predict where an image was taken from its content (Picarta AI) — GPS, city, country.",
  description:
    "Estimates the geographic location of a still image from its visual content alone (architecture, " +
    "signage, vegetation) — works even when EXIF GPS is stripped. Emits a geo.estimate record: a summary, " +
    "predicted lat/lng, city/country/province, a confidence, and the top-K candidate locations. Complements " +
    "`exif` (which reads embedded GPS when present). The default backend is the shipped Picarta provider " +
    "(`PICARTA_API_KEY`, free credits to start); bind your own with `setup provider geolocate <spec>`. " +
    "Accepts an image path, a case record/capture id, or an http(s) URL (fetched into the case media dir).",
  args: [{ name: "input", summary: "Image path, case record id, or http(s) URL", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "geo.estimate",
  providerKey: "geolocate",
  run: (ctx) => runForensicSense(ctx, { verb: "geolocate", shipped: ["examples", "providers", "geolocate", "geolocate.sh"], resolve: "image" }),
};
