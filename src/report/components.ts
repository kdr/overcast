/**
 * Shared report primitives — DOM-free string builders used by wall, brief, and
 * status so freshness/coverage/thread rendering can't drift between surfaces.
 * No node/ffmpeg/pi imports; offline-unit-testable like report/wall.ts.
 */
import { escapeHtml } from "./html.js";

/** Compact age: 45s / 12m / 3h / 6d. "—" for unknown. Shared by every freshness
 *  chip so the wall HUD and the status board read identically. */
export function fmtAge(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/** Seconds → m:ss or h:mm:ss (media timestamps). */
export function fmtTime(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** A unicode block sparkline from activity bins — renders identically in the
 *  terminal payload, markdown, and HTML (no SVG, no CDN). Empty input → a flat
 *  baseline so a card never shows a blank gap. */
export function sparkline(bins: number[]): string {
  if (!bins.length) return "";
  const max = Math.max(...bins);
  if (max <= 0) return BLOCKS[0].repeat(bins.length);
  return bins.map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((v / max) * (BLOCKS.length - 1)))]).join("");
}

export type ChipTone = "" | "cyan" | "amber" | "magenta" | "bad" | "green";

/** A CSI chip. Tone maps to the palette classes csiShell/wall already define. */
export function chip(text: string, tone: ChipTone = ""): string {
  return `<span class="chip${tone ? " " + tone : ""}">${escapeHtml(text)}</span>`;
}

/** W/L/S/F sense-coverage badges — lit letters for present modalities. */
export function coverageBadges(coverage: { watch?: boolean; listen?: boolean; see?: boolean; face?: boolean }): string {
  const cells: Array<[string, boolean]> = [
    ["W", !!coverage.watch],
    ["L", !!coverage.listen],
    ["S", !!coverage.see],
    ["F", !!coverage.face],
  ];
  return `<span class="badges">${cells.map(([l, on]) => `<b class="${on ? "on" : ""}">${l}</b>`).join("")}</span>`;
}
