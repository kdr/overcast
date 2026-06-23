// overcast banner colorization. The theme colors the TUI chrome, but the banner
// is raw ASCII rendered by a pi-tui Text component, so we inject ANSI truecolor
// to match the overcast theme (neon green wordmark + amber accents) instead of
// the terminal default (white). Colors mirror themes/overcast.json.

const GREEN = "\x1b[38;2;0;255;127m"; // #00ff7f
const GREEN_DIM = "\x1b[38;2;31;157;87m"; // #1f9d57
const AMBER = "\x1b[38;2;255;196;0m"; // #ffc400
const RED = "\x1b[38;2;255;85;85m"; // #ff5555 (the REC dot)
const RESET = "\x1b[0m";

/**
 * Colorize the banner: the play-glyph box + ASCII wordmark in neon green, the
 * "video · understanding · osint" tagline dim green, and the REC status line in
 * amber (with a red dot). Tolerant of banner edits — colors by line shape.
 */
export function colorizeBanner(banner: string): string {
  const lines = banner.replace(/\n+$/, "").split("\n");
  return lines
    .map((line) => {
      if (line.includes("REC")) {
        // amber line, red dot
        return AMBER + line.replace("●", `${RED}●${AMBER}`) + RESET;
      }
      if (/[a-z]·|·[a-z]| · /i.test(line) || /v\s*i\s*d\s*e\s*o/i.test(line)) {
        return GREEN_DIM + line + RESET; // tagline
      }
      return GREEN + line + RESET; // glyph box + wordmark
    })
    .join("\n");
}
