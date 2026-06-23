// The single verb registry (CLAUDE.md invariant #5). Each verb is declared once
// here; CLI + agent tool + reference are generated from these specs. Phase 1
// ships `watch` (the vertical slice); later phases append entries.

import { makeRecord } from "../record.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import { listenVerb, seeVerb, enhanceVerb, viewVerb } from "../verbs/senses.js";
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
    // resolve the run template from the active profile binding (else default).
    const binding = ctx.profile.providers?.watch;
    const env = { ...process.env };
    // ensure the Cloudglue key reaches the tinycloud CLI if only in tinycloud config
    if (!env.CLOUDGLUE_API_KEY && ctx.profile) {
      // tinycloud CLI reads its own config; nothing to inject here by default.
    }
    const rec = await runWatch(ctx.input, {
      run: binding?.run,
      env,
      signal: ctx.signal,
    });
    // tag the case into meta for indexing
    rec.meta = { ...rec.meta, case: ctx.case.dir };
    return [rec];
  },
};

/** The full verb registry. Append new verbs here. */
export const VERBS: VerbSpec[] = [
  watchVerb,
  listenVerb,
  seeVerb,
  enhanceVerb,
  viewVerb,
];

export function findVerb(name: string): VerbSpec | undefined {
  return VERBS.find((v) => v.name === name);
}
