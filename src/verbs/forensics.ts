// Media-forensics senses: exif (ExifTool metadata + GPS) and verify (C2PA
// provenance). Each analyzes a captured/sensed artifact and emits an evidence
// record. They share one runner: resolve the input (path / http URL fetched into
// the case / case record id), dispatch to a bound provider or the shipped default
// exec script, then stamp case + source-post provenance — mirroring the see/listen
// senses (src/verbs/senses.ts) so behavior can't drift.

import { existsSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../record.js";
import { isCustomBinding, runBoundProvider, runExecProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import { providerEnv } from "../providers/provider-env.js";
import { fetchMediaToCase, isHttpUrl, kindForExt } from "../media/fetch.js";
import { resolveMediaRef } from "./media-ref.js";
import { provenanceFromCapture, scanHitProvenance, stampProvenance } from "./provenance.js";
import { shippedPath } from "../pkg.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function errorRecord(verb: string, message: string): OvercastRecord {
  return makeRecord({ verb, format: "json", payload: { error: message }, error: message, state: "error" });
}

interface SenseConfig {
  verb: string;
  /** shipped default provider script, as shippedPath() segments */
  shipped: string[];
}

/** Shared runner for the forensic senses. */
async function runForensicSense(ctx: VerbContext, cfg: SenseConfig): Promise<OvercastRecord[]> {
  if (!ctx.input) return [errorRecord(cfg.verb, `${cfg.verb} requires a media input`)];

  let sourceUrl: string | undefined;
  let sourceProv: Record<string, unknown> = {};
  let ref = ctx.input;

  // stamp case + URL origin + source-post provenance on EVERY outgoing record
  // (successes and failures) so an error on a URL still carries meta.source_url.
  const stamp = (rec: OvercastRecord): OvercastRecord[] => {
    rec.meta = { ...rec.meta, case: ctx.case.dir, ...(sourceUrl ? { source_url: sourceUrl } : {}) };
    // the resolved scan/capture record's post fields (source_url/author/text)
    // first, then any capture the local file itself came from (stampProvenance
    // never clobbers, so the direct source wins).
    stampProvenance(rec, sourceProv);
    stampProvenance(rec, provenanceFromCapture(ctx.case, ref));
    return [rec];
  };

  // resolve the input to a local file, in three steps:
  // 1) a case record/capture id → its media.ref (which may be a local path OR a
  //    remote URL — scan hits carry http media.ref). Carry the source record's
  //    provenance so a sense run directly on a scan hit stays traceable to the
  //    originating post (capture stamps the same via scanHitProvenance).
  if (!isHttpUrl(ref)) {
    const resolved = resolveMediaRef(ctx.case, ref, ctx.home);
    if (resolved.error) return [errorRecord(cfg.verb, `${cfg.verb} input: ${resolved.error}`)];
    ref = resolved.ref;
    // carry the source record's provenance, and — when the record has no
    // media.ref (a scan hit whose media is a page URL) — fall back to its
    // payload.url, matching how capture/hitFetchRef resolve the same hit
    // (resolveMediaRef only follows media.ref, so it would otherwise leave the
    // bare record id and fail the local-file check).
    const rec = ctx.case.recordById(resolved.recordId ?? ctx.input);
    if (rec) {
      sourceProv = scanHitProvenance(rec);
      if (!resolved.recordId) {
        const p = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : {};
        if (typeof p.url === "string" && p.url) ref = p.url;
      }
    }
  }
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
    // validate the FETCHED content by kind, not just local paths: an expired CDN /
    // auth URL returns HTML, which would otherwise yield a misleading "ready"
    // forensic result ("no GPS", has_manifest:false). Accept image OR av, reject
    // non-media. Mirrors the `see` sense's fetched-kind guard.
    if (kindForExt(dl.ext) === "other") {
      const got = dl.ext ? dl.ext.slice(1) : dl.contentType ?? "unknown";
      return stamp(errorRecord(cfg.verb, `${sourceUrl} did not resolve to media (got ${got}, saved to ${dl.path}) — likely an expired link or a login/HTML page`));
    }
    ref = dl.path;
  }
  // 3) local file must exist.
  if (!existsSync(ref)) return stamp(errorRecord(cfg.verb, `${cfg.verb}: file not found: ${ref}`));

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
  run: (ctx) => runForensicSense(ctx, { verb: "exif", shipped: ["examples", "providers", "exif", "exif.sh"] }),
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
  run: (ctx) => runForensicSense(ctx, { verb: "verify", shipped: ["examples", "providers", "verify", "verify.sh"] }),
};
