// overcast TUI branding: colorized banner, status line, and a minimal footer.
// The theme colors the chrome, but the banner is raw ASCII rendered by a pi-tui
// Text component, so we inject ANSI truecolor to match themes/overcast.json
// (neon green wordmark + amber accents) instead of the terminal default.

import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

const GREEN = "\x1b[38;2;0;255;127m"; // #00ff7f — bright wordmark face
const GREEN_DIM = "\x1b[38;2;31;157;87m"; // #1f9d57 — extrusion / muted
const PALE = "\x1b[38;2;198;247;213m"; // #c6f7d5 — text
const AMBER = "\x1b[38;2;255;196;0m"; // #ffc400 — accents
const AMBER_DIM = "\x1b[38;2;168;123;0m"; // #a87b00 — tagline
const RED = "\x1b[38;2;255;85;85m"; // #ff5555 — play icon
const RESET = "\x1b[0m";

// box-drawing "extrusion" glyphs in the ANSI-shadow font → dim green outline
const SHADOW_CHARS = new Set("╔╗╚╝║═╦╩╠╣".split(""));
// solid block glyphs → bright green face
const BLOCK_CHARS = new Set("█▀▄▌▐▮".split(""));

/** Per-character two-tone coloring of a wordmark line (face vs extrusion). */
function colorWordmark(line: string): string {
  let out = "";
  let mode: "block" | "shadow" | "" = "";
  for (const ch of line) {
    const want: "block" | "shadow" | "" = BLOCK_CHARS.has(ch)
      ? "block"
      : SHADOW_CHARS.has(ch)
        ? "shadow"
        : "";
    if (want && want !== mode) {
      out += want === "block" ? GREEN : GREEN_DIM;
      mode = want;
    }
    out += ch;
  }
  return out + RESET;
}

/**
 * Colorize the banner: the play-glyph box in amber (red ▶), the ASCII wordmark
 * in two-tone green (bright face + dim extrusion for the neon-outline look), and
 * the tagline in dim amber. Tolerant of banner edits — keys off line shape.
 */
export function colorizeBanner(banner: string): string {
  const lines = banner.replace(/\n+$/, "").split("\n");
  return lines
    .map((line) => {
      // the play-button box (top 3 lines): amber, with a red play triangle
      if (line.includes("▶") || /^[\s╔╗╚╝║═╦╩]*$/.test(line) === false && /[▮]/.test(line)) {
        return AMBER + line.replace("▶", `${RED}▶${AMBER}`) + RESET;
      }
      // the box frame lines around the play button (only box chars + spaces)
      if (/^\s*[╔╗╚╝║═╦╩]+\s*$/.test(line)) {
        return AMBER + line + RESET;
      }
      // tagline
      if (/v\s*i\s*d\s*e\s*o/i.test(line) || / · /.test(line)) {
        return AMBER_DIM + line + RESET;
      }
      // wordmark — two-tone
      return colorWordmark(line);
    })
    .join("\n");
}

/** A one-line status row shown under the banner (e.g. context file · tools · model). */
export function statusLine(parts: string[]): string {
  const kept = parts.filter(Boolean);
  if (kept.length === 0) return "";
  const body = kept.join(`${GREEN_DIM} · ${PALE}`);
  return `${GREEN}▶ ${PALE}${body}${RESET}`;
}

/** Compose the header: colorized banner, then (if any) a status line below it. */
export function headerText(banner: string, status: string): string {
  return status ? `${banner}\n${status}` : banner;
}

// --- minimal footer ---------------------------------------------------------

export interface FooterData {
  caseName: string;
  tokens: number | null;
  ctxPercent: number | null;
  model: string;
  thinking: string;
}

function fmtTokens(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** A left/right-justified minimal footer line (case · tok · ctx% · model · think). */
export class OvercastFooter implements Component {
  constructor(private readonly get: () => FooterData) {}
  // re-rendered each frame from live data; nothing cached to invalidate.
  invalidate(): void {}
  render(width: number): string[] {
    const d = this.get();
    const left = `${GREEN_DIM}case://${PALE}${d.caseName}${RESET}`;
    const right =
      `${GREEN_DIM}${fmtTokens(d.tokens)} tok ${GREEN_DIM}· ${PALE}ctx ${d.ctxPercent ?? 0}% ` +
      `${GREEN_DIM}· ${GREEN}${d.model} ${GREEN_DIM}· ${AMBER}think:${d.thinking}${RESET}`;
    const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [left + " ".repeat(pad) + right];
  }
}
