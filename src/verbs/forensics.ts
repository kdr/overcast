// Media-forensics senses: exif (ExifTool metadata + GPS) and verify (C2PA
// provenance). Each analyzes a captured/sensed artifact and emits an evidence
// record. They share one runner: resolve the input (path / http URL fetched into
// the case / case record id), dispatch to a bound provider or the shipped default
// exec script, then stamp case + source-post provenance — mirroring the see/listen
// senses (src/verbs/senses.ts) so behavior can't drift.

import { existsSync } from "node:fs";
import { isReady, makeRecord, type OvercastRecord } from "../record.js";
import { isCustomBinding, runBoundProvider, runExecProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import { providerEnv } from "../providers/provider-env.js";
import { fetchMediaToCase, isHttpUrl, kindForExt } from "../media/fetch.js";
import { validLatLng, gpsIssue } from "../geo.js";
import { resolveMediaRef } from "./media-ref.js";
import { provenanceFromCapture, scanHitProvenance, stampProvenance } from "./provenance.js";
import { provenanceCase } from "../archive.js";
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
  let archiveBucket: string | undefined;
  let ref = ctx.input;

  // stamp case + URL origin + source-post provenance on EVERY outgoing record
  // (successes and failures) so an error on a URL still carries meta.source_url.
  const stamp = (rec: OvercastRecord): OvercastRecord[] => {
    rec.meta = { ...rec.meta, case: ctx.case.dir, ...(sourceUrl ? { source_url: sourceUrl } : {}), ...(archiveBucket ? { archive: archiveBucket } : {}) };
    // the resolved scan/capture record's post fields (source_url/author/text)
    // first, then any capture the local file itself came from (stampProvenance
    // never clobbers, so the direct source wins).
    stampProvenance(rec, sourceProv);
    stampProvenance(rec, provenanceFromCapture(provenanceCase(ctx.case, archiveBucket, ctx.home), ref));
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
    // an archive/bucket ref carries its bucket record (from the bucket store, not
    // the active case) — gate on it so forensics never reads a pending/errored
    // capture's partial file (matches capture/archive add), and use it directly
    // for provenance (the active-case lookup would find nothing for a bucket id).
    if (resolved.record && !isReady(resolved.record)) {
      return [errorRecord(cfg.verb, `${cfg.verb} input: record ${resolved.record.id} isn't ready (state=${resolved.record.state ?? "?"})`)];
    }
    ref = resolved.ref;
    archiveBucket = resolved.archive; // forensics on an archived file traces to its bucket
    // carry the source record's provenance, and — when the record has no
    // media.ref (a scan hit whose media is a page URL) — fall back to its
    // payload.url, matching how capture/hitFetchRef resolve the same hit
    // (resolveMediaRef only follows media.ref, so it would otherwise leave the
    // bare record id and fail the local-file check).
    const rec = resolved.record ?? ctx.case.recordById(resolved.recordId ?? ctx.input);
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

/** Opt-in (`exif --geocode`) reverse geocoding: when a `geocode` provider is
 *  bound, resolve each ready record's GPS to `payload.place`. Gated on BOTH the
 *  flag and a bound provider — reverse geocoding egresses the subject's
 *  coordinates to a third party, so it must never fire silently. The intermediate
 *  geocode record is not persisted; only the resolved place string rides on the
 *  exif record. */
async function enrichWithPlace(ctx: VerbContext, records: OvercastRecord[]): Promise<void> {
  const binding = providerBinding(ctx, "geocode");
  const bound = isCustomBinding(binding);
  for (const rec of records) {
    if (rec.state && rec.state !== "ready") continue;
    const p = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : undefined;
    if (!p) continue;
    // validate the coordinate with the SAME WGS84 check the map applies, so a
    // NaN/Infinity/out-of-range tag the map would drop is never egressed to the
    // third-party geocoder.
    const coords = validLatLng(p.gps);
    if (!coords) {
      // --geocode was requested but there's nothing usable to geocode — leave
      // actionable feedback instead of a silent no-op, and label the issue
      // accurately (absent vs out-of-range vs malformed/incomplete).
      p.place = null;
      const issue = gpsIssue(p.gps);
      p.geocode_status =
        issue === "absent"
          ? "no GPS coordinates to geocode"
          : issue === "out-of-range"
            ? "GPS coordinates out of range — not geocoded"
            : "GPS coordinates malformed or incomplete — not geocoded";
      continue;
    }
    if (!bound) {
      p.place = null;
      p.geocode_status =
        'no geocode provider bound — `setup provider geocode "exec:bash examples/providers/geocode/geocode.sh --input {{input}}"` (opt-in)';
      continue;
    }
    try {
      const geo = await runBoundProvider("geocode", binding!, `${coords.lat},${coords.lng}`, {
        env: providerEnv(ctx.case.mediaDir),
        signal: ctx.signal,
      });
      const place = geo.payload && typeof geo.payload === "object" ? (geo.payload as Record<string, unknown>).place : undefined;
      if (typeof place === "string" && place) {
        p.place = place;
      } else if (geo.state && geo.state !== "ready") {
        // any non-ready state (error, needs_credentials, …) is a provider/setup or
        // dependency gap — NOT a coordinate lookup miss. Distinguish the two so a
        // missing `curl` isn't misreported as "no place for these coordinates".
        p.place = null;
        const detail = typeof geo.error === "string" && geo.error ? geo.error : `provider ${geo.state}`;
        p.geocode_status = `geocode unavailable (${geo.state}): ${detail}`;
      } else {
        // the provider ran cleanly but found no match for these coordinates
        p.place = null;
        p.geocode_status = "geocode returned no place for these coordinates";
      }
    } catch (e) {
      // non-fatal — the exif record stays valid without a place, but say why
      p.place = null;
      p.geocode_status = `geocode error: ${(e as Error).message}`;
    }
  }
}

// ---- exif (ExifTool metadata + GPS) ----------------------------------------

export const exifVerb: VerbSpec = {
  name: "exif",
  group: "sense",
  summary: "Extract embedded metadata — GPS, capture time, device — from an image or video (ExifTool).",
  description:
    "Runs ExifTool over an image or video and emits a media.metadata record: a searchable summary plus " +
    "GPS coordinates (signed decimals), capture time, camera make/model/serial/lens (the device-linking fingerprint `devices` groups by), editing software, MIME/dimensions/" +
    "duration, and a total tag count. The default backend is the shipped ExifTool provider (system `exiftool` " +
    "on PATH; install with `brew install exiftool` / `apt install libimage-exiftool-perl`); bind your own with " +
    "`setup provider exif <spec>`. Accepts a path, a case record/capture id, or an http(s) URL (fetched into " +
    "the case media dir first). The full raw tag dump stays in-provider — only the compact summary is indexed. " +
    "Pass `--geocode` to reverse-geocode the GPS into a place name via a bound (opt-in) `geocode` provider.",
  args: [{ name: "input", summary: "Image/video/file path, case record id, or http(s) URL", required: true }],
  flags: [
    { name: "geocode", summary: "Reverse-geocode GPS to a place via a bound `geocode` provider (opt-in — sends coordinates to that provider)", type: "boolean" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.metadata",
  providerKey: "exif",
  run: async (ctx) => {
    const records = await runForensicSense(ctx, { verb: "exif", shipped: ["examples", "providers", "exif", "exif.sh"] });
    if (ctx.opts.geocode === true) await enrichWithPlace(ctx, records);
    return records;
  },
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
