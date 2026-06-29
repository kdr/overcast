// The single verb registry (CLAUDE.md invariant #5). Each verb is declared once
// here; CLI + agent tool + reference are generated from these specs. Phase 1
// ships `watch` (the vertical slice); later phases append entries.

import { makeRecord } from "../record.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import { providerEnv } from "../providers/provider-env.js";
import { listenVerb, seeVerb, enhanceVerb, viewVerb } from "../verbs/senses.js";
import { faceVerb } from "../verbs/face.js";
import { imageVerb } from "../verbs/image.js";
import { cropVerb } from "../verbs/crop.js";
import { resolveVideoArg } from "../verbs/media-ref.js";
import {
  scanVerb,
  captureVerb,
  monitorVerb,
  targetVerb,
  sourceVerb,
  prebriefVerb,
} from "../verbs/osint.js";
import { indexVerb } from "../verbs/index.js";
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
    "is present), and the full structured describe in `detailed`.",
  args: [{ name: "input", summary: "Video file path or URL", required: true }],
  flags: [
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
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
    const resolved = resolveVideoArg(ctx.case, ctx.input, "watch input", { requireReady: false });
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
    // A custom provider already emits a record → dispatch by transport. Only the
    // tinycloud default needs envelope→record mapping.
    const rec = isCustomBinding(binding)
      ? await runBoundProvider("watch", binding!, input, { env: providerEnv(ctx.case.mediaDir), timeoutMs: 15 * 60_000, signal: ctx.signal })
      : await runWatch(input, { run: binding?.run, signal: ctx.signal });
    rec.meta = { ...rec.meta, case: ctx.case.dir };
    return [rec];
  },
};

/** The full verb registry. Append new verbs here. */
export const VERBS: VerbSpec[] = [
  watchVerb,
  listenVerb,
  seeVerb,
  faceVerb,
  imageVerb,
  enhanceVerb,
  viewVerb,
  cropVerb,
  scanVerb,
  captureVerb,
  monitorVerb,
  indexVerb,
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
