// ---- wall (control-room monitor wall) ---------------------------------------
// One HTML page, many case videos muted + looping at their evidence moments,
// case state overlaid. Model/rendering live in src/report/wall.ts; this verb
// owns validation, the best-effort poster pass (ffmpeg), the file write, and
// launching — mirroring `view` (senses.ts) and `brief --export` (read.ts).

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeRecord, type OvercastRecord } from "../record.js";
import { extractFrame } from "../media/ffmpeg.js";
import { openHtmlPlayer } from "../media/view.js";
import { normalizeHtmlTheme } from "../report/html.js";
import { buildWallModel, renderWallHtml } from "../report/wall.js";
import { parseSince } from "../providers/memory/local.js";
import type { VerbSpec } from "../registry/types.js";

// Sentinel default: an unset/default --export resolves against the case's
// mediaDir (like view.html), NOT the cwd — `--case <dir>` must not scatter
// wall.html into whatever directory the command ran from.
const WALL_DEFAULT_EXPORT = ".overcast/media/wall.html";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "wall", format: "json", payload: { error: message }, error: message, state: "error" });
}

export const wallVerb: VerbSpec = {
  name: "wall",
  group: "inspect",
  summary: "Open a control-room monitor wall: case videos looping at their evidence moments.",
  description:
    "Generates a self-contained HTML wall of muted, looping video tiles — each anchored to its " +
    "best evidence moment (open finding > face hit > record anchor) — overlaid with case state: " +
    "sense-coverage badges, findings, per-source scan / monitor / brief freshness. Local media is " +
    "referenced by file:// URL (not embedded); missing or browser-hostile media renders a NO " +
    "SIGNAL / STILL tile (with an ffmpeg poster frame when extractable). Click a tile to open the " +
    "media at its anchor; hover for the intel card. --infinite repeats the real feeds to fill the " +
    "screen and keeps extending the grid as it scrolls — an endless monitor bank even from a " +
    "handful of feeds. --no-open writes the wall and emits a record with its path instead of " +
    "launching.",
  args: [],
  flags: [
    { name: "limit", summary: "Max tiles, most evidentiary/recent first (~25 is a practical decode ceiling)", type: "number", default: 12 },
    { name: "source", summary: "Only media from this source type (youtube | tiktok | x | web | lens | local)", type: "string" },
    { name: "since", summary: "Only media with records since (e.g. 24h, 7d, 2026-06-01)", type: "string" },
    { name: "export", summary: "Wall HTML path", type: "string", default: WALL_DEFAULT_EXPORT },
    { name: "refresh", summary: "Auto-reload the wall every N seconds (restarts the feeds)", type: "number" },
    { name: "infinite", summary: "Endless wall: repeat feeds to fill the screen and keep extending on scroll", type: "boolean" },
    { name: "no-open", summary: "Write the wall but don't launch it", type: "boolean" },
    { name: "theme", summary: "HTML theme: plain | csi", type: "string", choices: ["plain", "csi"], default: "plain" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "wall",
  providerKey: "wall",
  run: async (ctx) => {
    const theme = normalizeHtmlTheme(ctx.opts.theme);
    if (!theme) return [err(`invalid --theme '${ctx.opts.theme}' (expected plain or csi)`)];
    let limit = 12;
    if (ctx.opts.limit != null) {
      const n = Number(ctx.opts.limit);
      if (!Number.isFinite(n) || n <= 0) return [err(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`)];
      limit = Math.floor(n);
    }
    let sinceCutoff: number | undefined;
    if (ctx.opts.since != null) {
      const cutoff = parseSince(String(ctx.opts.since));
      if (cutoff == null) return [err(`invalid --since: ${ctx.opts.since} (try 24h, 7d, or 2026-06-01)`)];
      sinceCutoff = cutoff;
    }
    let refresh: number | undefined;
    if (ctx.opts.refresh != null) {
      const n = Number(ctx.opts.refresh);
      if (!Number.isFinite(n) || n <= 0) return [err(`invalid --refresh: ${ctx.opts.refresh} (expected seconds > 0)`)];
      refresh = Math.round(n);
    }
    const infinite = ctx.opts.infinite === true;
    const source = ctx.opts.source != null ? String(ctx.opts.source).trim() : undefined;
    if (ctx.opts.source != null && !source) {
      return [err("--source requires a value (youtube | tiktok | x | web | lens | local)")];
    }
    const rawExport = ctx.opts.export != null ? String(ctx.opts.export) : WALL_DEFAULT_EXPORT;
    const htmlPath = rawExport === WALL_DEFAULT_EXPORT ? join(ctx.case.mediaDir, "wall.html") : resolve(rawExport);

    const info = ctx.case.exists() ? ctx.case.info() : { name: "case" };
    const model = buildWallModel(ctx.case.records(), {
      caseName: info.name,
      caseDir: ctx.case.dir,
      limit,
      source,
      sinceCutoff,
      refreshSeconds: refresh,
      infinite,
    });

    // nothing to wall → transient pending guidance, no artifact (brief precedent)
    if (model.hud.totalVideos === 0 || model.tiles.length === 0) {
      const note =
        model.hud.totalVideos === 0
          ? "no case videos to wall; capture/watch media first (e.g. `scan --pull` or `watch <clip>`)"
          : "filters matched no case videos; loosen --source/--since";
      return [
        makeRecord({
          verb: "wall",
          format: "json",
          payload: { mode: "wall", viewer: null, tiles: 0, total_videos: model.hud.totalVideos, note },
          meta: { transient: true },
          state: "pending",
        }),
      ];
    }

    // best-effort poster stills for present-but-unplayable containers (mkv/avi/…);
    // a failed extraction just leaves the animated static tile (spectrogram
    // precedent). Local only — never point ffmpeg at a remote URL for a poster.
    for (const tile of model.tiles) {
      if (tile.mode !== "still" || /^https?:\/\//i.test(tile.ref)) continue;
      try {
        tile.poster = pathToFileURL(await extractFrame(tile.ref, tile.anchor.at, ctx.case.mediaDir)).href;
      } catch {
        /* non-fatal */
      }
    }

    const noOpen = ctx.opts["no-open"] === true;
    writeFileSync(htmlPath, renderWallHtml(model, theme), "utf8");
    if (!noOpen) openHtmlPlayer(htmlPath);

    return [
      makeRecord({
        verb: "wall",
        format: "json",
        payload: {
          mode: "wall",
          viewer: htmlPath,
          theme,
          opened: !noOpen,
          tiles: model.tiles.length,
          total_videos: model.hud.totalVideos,
          no_signal: model.tiles.filter((t) => t.mode === "down").length,
          stills: model.tiles.filter((t) => t.mode === "still").length,
          open_findings: model.hud.openFindings,
          refresh: refresh ?? null,
          infinite,
          tile_refs: model.tiles.map((t) => ({
            ref: t.ref,
            at: t.anchor.at,
            mode: t.mode,
            findings: t.openFindings,
            faces: t.faceCount,
          })),
        },
        // no record-level media: a wall spans many refs (tile_refs carries them)
        meta: { provider: "wall", case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};
