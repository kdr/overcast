// `grid` verb: tile timestamped video frames into ONE labeled contact sheet for a
// single-call VLM triage pass (the "grid trick" — temporal search reframed as
// spatial search, per T*/LV-Haystack, plus Set-of-Mark numbering over time). The
// emitted media.grid record's media.ref is the montage image and payload.cells is
// the exact cell-number → timestamp map, so a follow-up
// `see <montage> --prompt "which numbered cell shows X?"` answer can be translated
// straight back to a source time. Pure internal ffmpeg (invariant #7), like crop.

import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { makeRecord, errRecord, type OvercastRecord } from "../record.js";
import { contactSheet, probe, parseTimecode, type GridCell } from "../media/ffmpeg.js";
import { escapeHtml } from "../report/html.js";
import { openHtmlPlayer } from "../media/view.js";
import { resolveVideoArg } from "./media-ref.js";
import { stampArchive } from "../archive.js";
import { badNumber } from "./validate.js";
import type { VerbSpec } from "../registry/types.js";

const err = (message: string): OvercastRecord => errRecord("grid", message);

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
    "before a frame-precise zoom-in (see frame://<record>@<sec>). Add --view for a clickable HTML contact " +
    "sheet (cells labeled with their timestamp even when ffmpeg can't burn labels, each seeking the source " +
    "video on click); --no-open writes it without launching.",
  args: [{ name: "input", summary: "Video file path or case record id", required: true }],
  flags: [
    { name: "count", summary: "Number of frames to sample across the window (default 16)", type: "number" },
    { name: "at", summary: "Explicit comma list of timestamps (SS or MM:SS), overrides --count/window", type: "string" },
    { name: "start", summary: "Window start (SS or MM:SS)", type: "string" },
    { name: "end", summary: "Window end (SS or MM:SS)", type: "string" },
    { name: "cols", summary: "Grid columns (default ceil(sqrt(count)), max 12)", type: "number" },
    { name: "width", summary: "Cell width in px (default 320)", type: "number" },
    { name: "out", summary: "Output image path (default .overcast/media/)", type: "string" },
    { name: "view", summary: "Also render a clickable HTML contact sheet (numbered cells seek the source video)", type: "boolean" },
    { name: "no-open", summary: "With --view, write the HTML board but don't launch it", type: "boolean" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.grid",
  providerKey: "grid",
  run: async (ctx) => {
    if (!ctx.input) return [err("grid requires a video input (path or record id)")];
    // one notion of "is --at in use" for BOTH the validation gate and the branch
    // below — a `--at=` (empty string) is not null but is falsy, so keying the two
    // off different checks let an unvalidated --count slip into window sampling.
    const hasAt = typeof ctx.opts.at === "string" && ctx.opts.at.trim() !== "";
    const numErr =
      // count/cols set array lengths + the grid shape, so they must be whole
      // numbers — a fractional count truncates the samples while the step math
      // still divides by the float, skewing the window.
      badNumber(ctx.opts, "cols", (n) => Number.isInteger(n) && n >= 1 && n <= 12, "a whole number 1–12") ??
      badNumber(ctx.opts, "width", (n) => n >= 120 && n <= 960, "120–960") ??
      // --count only drives window sampling; an explicit --at overrides it, so
      // don't reject a count the user isn't actually using.
      (hasAt
        ? undefined
        : badNumber(ctx.opts, "count", (n) => Number.isInteger(n) && n >= 1 && n <= MAX_CELLS, `a whole number 1–${MAX_CELLS}`));
    if (numErr) return [err(numErr)];

    // accept a path / URL / case record id, and validate it's real AV media.
    const resolved = resolveVideoArg(ctx.case, ctx.input, "grid input", { requireReady: false, home: ctx.home });
    if (resolved.error) return [err(resolved.error)];
    const input = resolved.ref ?? ctx.input;

    // Local media only — the same rule `wall` and `read` already apply before
    // they call in. Handing a remote ref to ffprobe/ffmpeg would make the
    // SUBPROCESS fetch it, bypassing assertFetchHostAllowed entirely and turning
    // ffmpeg's stderr into an internal-host probe. (ffmpeg.ts refuses it at the
    // sink too; this is the caller-side error the analyst actually reads.)
    if (/^https?:\/\//i.test(input)) {
      return [err(`grid needs local media — ${input} is a remote URL; \`capture\` it into the case first`)];
    }

    // grid tiles VIDEO frames — reject audio-only media that passes the AV gate
    // (resolveVideoArg accepts audio too). Probe once here and reuse it for the
    // window duration below. Lenient on a probe failure (proceed rather than block).
    const probed = await probe(input).catch(() => undefined);
    if (probed && !probed.hasVideo) {
      return [err(`grid needs a video — ${basename(input)} has no video stream`)];
    }

    // decide the timestamps: explicit --at wins; otherwise sample the window.
    const dur = probed?.durationSeconds; // known clip length, or undefined
    let seconds: number[];
    let window: { start: number; end: number } | undefined;
    if (hasAt) {
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
      // a --at past EOF would extract a repeated last frame while cells[].at still
      // claims that (never-sampled) second — reject it instead of lying.
      if (dur !== undefined) {
        const past = seconds.filter((t) => t > dur);
        if (past.length) {
          return [err(`--at past the video duration (${dur.toFixed(1)}s): ${past.join(", ")}`)];
        }
      }
    } else {
      const start = ctx.opts.start != null ? parseTimecode(String(ctx.opts.start)) : 0;
      if (start === undefined) return [err(`invalid --start: ${ctx.opts.start}`)];
      let end = ctx.opts.end != null ? parseTimecode(String(ctx.opts.end)) : undefined;
      if (ctx.opts.end != null && end === undefined) return [err(`invalid --end: ${ctx.opts.end}`)];
      if (end === undefined) {
        end = dur;
        if (end === undefined) {
          return [err("could not read video duration — pass --end or an explicit --at list")];
        }
      } else if (dur !== undefined && end > dur) {
        // never sample past EOF — clamp an over-long --end to the real clip length
        // so midpoints stay inside the video (and cells[].at stays truthful).
        end = dur;
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
      const blanks = sheet.cells.length - seconds.length; // trailing padding tiles

      // --view: render the human-facing counterpart to the VLM-facing PNG — a
      // clickable HTML board that labels every cell with its number + timestamp
      // (in CSS, so labels show even when this ffmpeg lacks drawtext) and seeks
      // the source video on click. Opens unless --no-open (like `view`).
      let viewPath: string | undefined;
      let opened = false;
      if (ctx.opts.view) {
        viewPath = sheet.output.replace(/\.png$/i, "") + "_board.html";
        const html = buildGridHtml({
          montage: sheet.output,
          video: input,
          videoIsRemote: /^https?:\/\//i.test(input),
          cells: sheet.cells,
          cols: sheet.cols,
          rows: sheet.rows,
          cellWidth: sheet.cellWidth,
          cellHeight: sheet.cellHeight,
          title: basename(input),
        });
        writeFileSync(viewPath, html, "utf8");
        if (ctx.opts["no-open"] !== true) {
          openHtmlPlayer(viewPath);
          opened = true;
        }
      }

      return [
        // in-place triage of an archived clip traces to its bucket, like the
        // other senses (grid's own montage still lives in the case media dir)
        stampArchive(makeRecord({
          verb: "grid",
          format: "json",
          payload: {
            summary:
              `contact sheet: ${seconds.length} frames from ${basename(input)} ` +
              `(${grid}${blanks > 0 ? `, last ${blanks} cell(s) blank` : ""}` +
              `${sheet.labeled ? ", labeled" : ", unlabeled — cells numbered left-to-right, top-to-bottom"})`,
            source: input,
            source_record: resolved.recordId,
            montage: sheet.output,
            grid,
            cols: sheet.cols,
            rows: sheet.rows,
            count: seconds.length,
            labeled: sheet.labeled,
            window,
            // full tile map (cols×rows); entries with at:null are blank padding.
            cells: sheet.cells,
            ...(viewPath ? { view: viewPath, opened } : {}),
          },
          media: { ref: sheet.output },
          meta: { provider: "ffmpeg", case: ctx.case.dir },
          state: "ready",
        }), resolved.archive),
      ];
    } catch (e) {
      return [err(`grid failed: ${(e as Error).message}`)];
    }
  },
};

// --- HTML contact-sheet board (the --view render) ---------------------------

interface GridHtmlOpts {
  montage: string;
  video: string;
  videoIsRemote: boolean;
  cells: GridCell[];
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  title: string;
}

/** Whole seconds → M:SS (labels); the exact seconds ride the seek + the record. */
function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A self-contained board: the montage PNG with a percentage-positioned overlay of
 * numbered, seekable cells (percentages so the overlay scales exactly with the
 * image), above the source video. Clicking a cell seeks the video to that cell's
 * timestamp. Blank padding tiles render dimmed and inert.
 */
function buildGridHtml(o: GridHtmlOpts): string {
  const margin = 6, gap = 6; // must match contactSheet's tile margin/padding
  const totalW = 2 * margin + o.cols * o.cellWidth + (o.cols - 1) * gap;
  const totalH = 2 * margin + o.rows * o.cellHeight + (o.rows - 1) * gap;
  const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(4)}%`;

  const overlay = o.cells
    .map((cell) => {
      const idx = cell.n - 1;
      const c = idx % o.cols;
      const r = Math.floor(idx / o.cols);
      const style =
        `left:${pct(margin + c * (o.cellWidth + gap), totalW)};` +
        `top:${pct(margin + r * (o.cellHeight + gap), totalH)};` +
        `width:${pct(o.cellWidth, totalW)};height:${pct(o.cellHeight, totalH)}`;
      if (cell.at == null) {
        return `<div class="cell blank" style="${style}"><span class="badge">${cell.n}</span></div>`;
      }
      return (
        `<button class="cell" style="${style}" onclick="seek(${cell.at})" ` +
        `title="cell ${cell.n} · ${cell.at}s">` +
        `<span class="badge">${cell.n}</span><span class="tc">${escapeHtml(mmss(cell.at))}</span></button>`
      );
    })
    .join("");

  const videoUrl = escapeHtml(o.videoIsRemote ? o.video : pathToFileURL(o.video).href);
  const montageUrl = escapeHtml(pathToFileURL(o.montage).href);
  const nameEsc = escapeHtml(o.title);

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>overcast grid — ${nameEsc}</title>
<style>
  :root{--bg:#08120c;--panel:#0d1c12;--rule:#1f9d57;--ink:#c6f7d5;--amber:#ffc400;--dim:#5f9e79}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-monospace,Menlo,Consolas,monospace;padding:20px}
  h1{color:var(--amber);font-size:14px;letter-spacing:2px;margin:0 0 4px}
  .sub{color:var(--dim);font-size:12px;margin:0 0 16px}
  .board{position:relative;max-width:1100px;margin:0 auto;border:1px solid var(--rule);border-radius:8px;overflow:hidden;line-height:0}
  .board img{display:block;width:100%;height:auto}
  .overlay{position:absolute;inset:0}
  .cell{position:absolute;margin:0;padding:0;border:1px solid transparent;background:transparent;cursor:pointer;border-radius:4px;transition:border-color .12s,background .12s}
  .cell:hover,.cell:focus-visible{border-color:var(--amber);background:rgba(255,196,0,.12);outline:none}
  .cell .badge{position:absolute;top:5px;left:5px;font-size:12px;font-weight:700;color:#08120c;background:var(--amber);border-radius:4px;padding:1px 6px;line-height:1.4}
  .cell .tc{position:absolute;bottom:5px;right:5px;font-size:11px;color:var(--ink);background:rgba(8,18,12,.72);border:1px solid var(--rule);border-radius:4px;padding:1px 5px}
  .cell.blank{cursor:default;background:repeating-linear-gradient(45deg,rgba(255,255,255,.03),rgba(255,255,255,.03) 6px,transparent 6px,transparent 12px)}
  .cell.blank .badge{background:var(--dim);opacity:.6}
  video{display:block;width:100%;max-width:1100px;margin:16px auto 0;background:#000;border:1px solid var(--rule);border-radius:8px}
  .hint{color:var(--dim);font-size:12px;text-align:center;margin:12px 0 0}
</style></head><body>
<h1>▦ OVERCAST GRID — ${nameEsc}</h1>
<p class="sub">${o.cols}×${o.rows} contact sheet · click a numbered cell to seek the clip to that moment</p>
<div class="board"><img src="${montageUrl}" alt="contact sheet"><div class="overlay">${overlay}</div></div>
<video id="v" src="${videoUrl}" controls preload="metadata"></video>
<p class="hint">cells labeled #n · M:SS — the exact seconds live in the grid record's payload.cells</p>
<script>
  var v=document.getElementById('v');
  function seek(t){ if(!v)return; v.currentTime=t; v.play&&v.play().catch(function(){}); v.scrollIntoView({behavior:'smooth',block:'nearest'}); }
</script>
</body></html>`;
}
