// The single verb registry (CLAUDE.md invariant #5). Each verb is declared once
// here; CLI + agent tool + reference are generated from these specs. Phase 1
// ships `watch` (the vertical slice); later phases append entries.

import { makeRecord } from "../record.js";
import { stampWatchAudioAvailability } from "../media/ffmpeg.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import { providerEnv } from "../providers/provider-env.js";
import { listenVerb, seeVerb, enhanceVerb, viewVerb } from "../verbs/senses.js";
import { reconstructVerb } from "../verbs/reconstruct.js";
import { exifVerb, verifyVerb } from "../verbs/forensics.js";
import { screenshotVerb } from "../verbs/screenshot.js";
import { faceVerb } from "../verbs/face.js";
import { imageVerb } from "../verbs/image.js";
import { audioVerb } from "../verbs/audio.js";
import { voiceVerb } from "../verbs/voice.js";
import { clusterVerb } from "../verbs/cluster.js";
import { similarVerb } from "../verbs/similar.js";
import { cropVerb } from "../verbs/crop.js";
import { chronolocateVerb } from "../verbs/chronolocate.js";
import { gridVerb } from "../verbs/grid.js";
import { wallVerb } from "../verbs/wall.js";
import { situationVerb } from "../verbs/situation.js";
import { mapVerb } from "../verbs/map.js";
import { geofenceVerb } from "../verbs/geofence.js";
import { devicesVerb } from "../verbs/devices.js";
import { graphVerb } from "../verbs/graph.js";
import { resolveVideoArg } from "../verbs/media-ref.js";
import { provenanceFromCapture, stampProvenance } from "../verbs/provenance.js";
import { provenanceCase, stampArchive } from "../archive.js";
import {
  scanVerb,
  captureVerb,
  monitorVerb,
  targetVerb,
  sourceVerb,
  prebriefVerb,
} from "../verbs/osint.js";
import { indexVerb } from "../verbs/index.js";
import { archiveVerb } from "../verbs/archive.js";
import { askVerb, briefVerb } from "../verbs/read.js";
import { caseVerb } from "../verbs/case.js";
import { noteVerb } from "../verbs/note.js";
import { findingVerb } from "../verbs/finding.js";
import { setupVerb, providerVerb, doctorVerb } from "../verbs/setup.js";
import { skillsVerb } from "../verbs/skills.js";
import type { VerbSpec } from "./types.js";

export const watchVerb: VerbSpec = {
  name: "watch",
  group: "sense",
  summary: "Analyze a video into a reusable, time-anchored record (content/transcript/detailed).",
  description:
    "Runs the bound sense provider (default: tinycloud, exec) over a video file or URL " +
    "and emits a video.analysis record with markdown content, a transcript (when speech " +
    "is present), and the full structured describe in `detailed`. `--segment` picks the " +
    "provider's segmentation — shots (shot-detected boundaries; tune with " +
    "--shot-min-seconds/--shot-max-seconds) | chapters | segments | uniform:<seconds> — " +
    "instead of the provider default (uniform:20). The record's meta.segmentation " +
    "reports the segmentation that ACTUALLY ran — trust it over any segmentation echo " +
    "inside `detailed` (tinycloud ≤ 0.3.15 echoes uniform:20 there even on a shots run); " +
    "a kind mismatch with the request adds payload.warning. Footage with no hard cuts " +
    "(a locked-off talk camera) legitimately yields max-duration-capped shots that LOOK " +
    "uniform.",
  args: [{ name: "input", summary: "Video file path or URL", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
    // free string (not choices): tinycloud's kinds include parameterized forms
    // like uniform:<seconds>; the provider validates and errors loudly.
    { name: "segment", summary: "Segmentation kind passed to the provider: shots | chapters | segments | uniform:<seconds> (default: the provider's own, uniform:20)", type: "string" },
    { name: "shot-min-seconds", summary: "Min shot duration in seconds with --segment shots (e.g. 0.6 catches flash frames)", type: "number" },
    { name: "shot-max-seconds", summary: "Max shot duration in seconds with --segment shots", type: "number" },
  ],
  outputKind: "video.analysis",
  providerKey: "watch",
  run: async (ctx) => {
    if (!ctx.input) {
      return [
        makeRecord({
          verb: "watch",
          format: "json",
          payload: { content: "", transcript: "", detailed: null },
          error: "watch requires a video input (path or URL)",
          state: "error",
        }),
      ];
    }
    const resolved = resolveVideoArg(ctx.case, ctx.input, "watch input", { requireReady: false, home: ctx.home });
    if (resolved.error) {
      return [
        makeRecord({
          verb: "watch",
          format: "json",
          payload: { content: "", transcript: "", detailed: null },
          media: { ref: ctx.input },
          error: resolved.error,
          state: "error",
        }),
      ];
    }
    const input = resolved.ref ?? ctx.input;
    // resolve the run template from the active profile binding (else default).
    const binding = providerBinding(ctx, "watch");
    // segmentation flags thread through to the provider argv (tinycloud owns
    // them; a custom provider receives them as extraArgs, the wrapper contract
    // like listen's --diarize/--lang). Unset flags add nothing.
    const segment = ctx.opts.segment ? String(ctx.opts.segment) : undefined;
    const shotMin = ctx.opts["shot-min-seconds"] !== undefined ? Number(ctx.opts["shot-min-seconds"]) : undefined;
    const shotMax = ctx.opts["shot-max-seconds"] !== undefined ? Number(ctx.opts["shot-max-seconds"]) : undefined;
    const extraArgs: string[] = [];
    if (segment) extraArgs.push("--segment", segment);
    if (shotMin !== undefined) extraArgs.push("--shot-min-seconds", String(shotMin));
    if (shotMax !== undefined) extraArgs.push("--shot-max-seconds", String(shotMax));
    // A custom provider already emits a record → dispatch by transport. Only the
    // tinycloud default needs envelope→record mapping.
    const rec = isCustomBinding(binding)
      ? await runBoundProvider("watch", binding!, input, { env: providerEnv(ctx.case.mediaDir), extraArgs, timeoutMs: 15 * 60_000, signal: ctx.signal, home: ctx.home })
      : await runWatch(input, { run: binding?.run, segment, shotMinSeconds: shotMin, shotMaxSeconds: shotMax, signal: ctx.signal });
    rec.meta = { ...rec.meta, case: ctx.case.dir };
    await stampWatchAudioAvailability(rec, input);
    // trace back to the originating post (like listen) — for archived media the
    // capture that materialized it lives in the BUCKET, so look there
    stampProvenance(rec, provenanceFromCapture(provenanceCase(ctx.case, resolved.archive, ctx.home), input));
    // in-place sensing of an archived clip traces to its bucket, like the
    // scoped match verbs and capture pulls
    return [stampArchive(rec, resolved.archive)];
  },
};

/** The full verb registry. Append new verbs here. */
export const VERBS: VerbSpec[] = [
  watchVerb,
  listenVerb,
  seeVerb,
  faceVerb,
  imageVerb,
  audioVerb,
  voiceVerb,
  clusterVerb,
  similarVerb,
  exifVerb,
  verifyVerb,
  screenshotVerb,
  enhanceVerb,
  reconstructVerb,
  viewVerb,
  cropVerb,
  chronolocateVerb,
  gridVerb,
  wallVerb,
  situationVerb,
  mapVerb,
  geofenceVerb,
  devicesVerb,
  graphVerb,
  scanVerb,
  captureVerb,
  monitorVerb,
  indexVerb,
  archiveVerb,
  targetVerb,
  sourceVerb,
  noteVerb,
  findingVerb,
  prebriefVerb,
  askVerb,
  briefVerb,
  caseVerb,
  setupVerb,
  providerVerb,
  doctorVerb,
  skillsVerb,
];

export function findVerb(name: string): VerbSpec | undefined {
  return VERBS.find((v) => v.name === name);
}
