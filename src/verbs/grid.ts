// `grid` verb: tile timestamped video frames into ONE labeled contact sheet for a
// single-call VLM triage pass (the "grid trick" — temporal search reframed as
// spatial search, per T*/LV-Haystack, plus Set-of-Mark numbering over time). The
// emitted media.grid record's media.ref is the montage image and payload.cells is
// the exact cell-number → timestamp map, so a follow-up
// `see <montage> --prompt "which numbered cell shows X?"` answer can be translated
// straight back to a source time. Pure internal ffmpeg (invariant #7), like crop.

import { basename, join } from "node:path";
import { makeRecord, type OvercastRecord } from "../record.js";
import { contactSheet, probe, parseTimecode } from "../media/ffmpeg.js";
import { resolveVideoArg } from "./media-ref.js";
import { badNumber } from "./validate.js";
import type { VerbSpec } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "grid", format: "json", payload: { error: message }, error: message, state: "error" });
}

const MAX_CELLS = 64;

export const gridVerb: VerbSpec = {
  name: "grid",
  group: "inspect",
  summary: "Tile timestamped video frames into a labeled contact sheet for one-shot VLM triage.",
  description:
    "Samples frames from a video — uniformly across a --start/--end window (default the whole clip, " +
    "--count frames) or at an explicit --at timestamp list — and tiles them into ONE contact-sheet image " +
    "via the internal ffmpeg toolkit, burning each cell's number + timestamp when the ffmpeg build has " +
    "drawtext (else the sheet is unlabeled and cells are numbered left-to-right, top-to-bottom). Emits a " +
    "media.grid record whose media.ref is the montage and whose payload.cells maps cell number → exact " +
    "timestamp. Chain it: `overcast see <montage-path> --prompt \"which numbered cell best shows X? give the " +
    "cell number\"` then read payload.cells to recover the source time — one VLM call triages a long clip " +
    "before a frame-precise zoom-in (see frame://<record>@<sec>).",
  args: [{ name: "input", summary: "Video file path or case record id", required: true }],
  flags: [
    { name: "count", summary: "Number of frames to sample across the window (default 16)", type: "number" },
    { name: "at", summary: "Explicit comma list of timestamps (SS or MM:SS), overrides --count/window", type: "string" },
    { name: "start", summary: "Window start (SS or MM:SS)", type: "string" },
    { name: "end", summary: "Window end (SS or MM:SS)", type: "string" },
    { name: "cols", summary: "Grid columns (default ceil(sqrt(count)), max 12)", type: "number" },
    { name: "width", summary: "Cell width in px (default 320)", type: "number" },
    { name: "out", summary: "Output image path (default .overcast/media/)", type: "string" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.grid",
  providerKey: "grid",
  run: async (ctx) => {
    if (!ctx.input) return [err("grid requires a video input (path or record id)")];
    const numErr =
      // count/cols set array lengths + the grid shape, so they must be whole
      // numbers — a fractional count truncates the samples while the step math
      // still divides by the float, skewing the window.
      badNumber(ctx.opts, "cols", (n) => Number.isInteger(n) && n >= 1 && n <= 12, "a whole number 1–12") ??
      badNumber(ctx.opts, "width", (n) => n >= 120 && n <= 960, "120–960") ??
      // --count only drives window sampling; an explicit --at overrides it, so
      // don't reject a count the user isn't actually using.
      (ctx.opts.at == null
        ? badNumber(ctx.opts, "count", (n) => Number.isInteger(n) && n >= 1 && n <= MAX_CELLS, `a whole number 1–${MAX_CELLS}`)
        : undefined);
    if (numErr) return [err(numErr)];

    // accept a path / URL / case record id, and validate it's real AV media.
    const resolved = resolveVideoArg(ctx.case, ctx.input, "grid input", { requireReady: false });
    if (resolved.error) return [err(resolved.error)];
    const input = resolved.ref ?? ctx.input;

    // grid tiles VIDEO frames — reject audio-only media that passes the AV gate
    // (resolveVideoArg accepts audio too). Probe once here and reuse it for the
    // window duration below. Lenient on a probe failure (proceed rather than block).
    const probed = await probe(input).catch(() => undefined);
    if (probed && !probed.hasVideo) {
      return [err(`grid needs a video — ${basename(input)} has no video stream`)];
    }

    // decide the timestamps: explicit --at wins; otherwise sample the window.
    let seconds: number[];
    let window: { start: number; end: number } | undefined;
    if (ctx.opts.at) {
      const parts = String(ctx.opts.at).split(",").map((s) => parseTimecode(s));
      if (parts.some((p) => p === undefined)) {
        return [err(`invalid --at: ${ctx.opts.at} (use comma-separated SS or MM:SS)`)];
      }
      seconds = [...new Set(parts as number[])].sort((a, b) => a - b);
      if (!seconds.length) return [err("--at listed no valid timestamps")];
      // reject rather than silently drop: a truncated triage that still reports
      // success would quietly miss the moments the caller explicitly asked for.
      if (seconds.length > MAX_CELLS) {
        return [err(`too many --at timestamps (${seconds.length}); max ${MAX_CELLS}`)];
      }
    } else {
      const start = ctx.opts.start != null ? parseTimecode(String(ctx.opts.start)) : 0;
      if (start === undefined) return [err(`invalid --start: ${ctx.opts.start}`)];
      let end = ctx.opts.end != null ? parseTimecode(String(ctx.opts.end)) : undefined;
      if (ctx.opts.end != null && end === undefined) return [err(`invalid --end: ${ctx.opts.end}`)];
      if (end === undefined) {
        end = probed?.durationSeconds;
        if (end === undefined) {
          return [err("could not read video duration — pass --end or an explicit --at list")];
        }
      }
      if (!(end > start)) return [err(`empty window: --start ${start} is not before --end ${end}`)];
      const count = ctx.opts.count != null ? Number(ctx.opts.count) : 16;
      const step = (end - start) / count;
      // sample the MIDPOINT of each segment so we never hit an all-black first/last frame.
      seconds = Array.from({ length: count }, (_, i) => Number((start + (i + 0.5) * step).toFixed(3)));
      window = { start, end };
    }

    try {
      const sheet = await contactSheet(input, seconds, ctx.case.mediaDir, {
        cols: ctx.opts.cols != null ? Number(ctx.opts.cols) : undefined,
        cellWidth: ctx.opts.width != null ? Number(ctx.opts.width) : undefined,
        outPath: ctx.opts.out ? String(ctx.opts.out) : undefined,
      });
      const grid = `${sheet.cols}x${sheet.rows}`;
      return [
        makeRecord({
          verb: "grid",
          format: "json",
          payload: {
            summary:
              `contact sheet: ${sheet.cells.length} frames from ${basename(input)} ` +
              `(${grid}${sheet.labeled ? ", labeled" : ", unlabeled — cells numbered left-to-right, top-to-bottom"})`,
            source: input,
            source_record: resolved.recordId,
            montage: sheet.output,
            grid,
            cols: sheet.cols,
            rows: sheet.rows,
            count: sheet.cells.length,
            labeled: sheet.labeled,
            window,
            cells: sheet.cells,
          },
          media: { ref: sheet.output },
          meta: { provider: "ffmpeg", case: ctx.case.dir },
          state: "ready",
        }),
      ];
    } catch (e) {
      return [err(`grid failed: ${(e as Error).message}`)];
    }
  },
};
