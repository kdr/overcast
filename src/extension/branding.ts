// overcast TUI branding: a live, colorized banner header + a minimal footer.
//
// The banner is raw ASCII (assets/banner.txt) rendered by a pi-tui Component, so
// we inject ANSI truecolor to paint it the overcast way: a green→cyan "synthwave"
// gradient wordmark, a magenta/cyan recording-deck HUD beside the play box, a
// centered tagline, and a bracket-tagged status row.
//
// The header animates ONCE: the wordmark does a "decrypt" reveal on launch, then
// the timer STOPS for good and the header is static. A steady-state ticker would
// call tui.requestRender() forever, repainting the header and snapping the
// terminal's scrollback back to the bottom — so you could never scroll up. pi is
// not forked — we attach as a normal Component via ctx.ui.setHeader and drive the
// reveal repaints through the public TUI.requestRender().

import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

/** Truncate a single line to the viewport width (ANSI-aware), so a fixed-width
 *  banner/footer never overflows and crashes pi's renderer on a narrow terminal. */
function fitWidth(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

// ---- palette (truecolor) ----------------------------------------------------
const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const RESET = "\x1b[0m";

const GREEN = fg(0, 255, 127); // #00ff7f — neon wordmark face (top of gradient)
const GREEN_DIM = fg(31, 157, 87); // #1f9d57 — chrome / muted separators
const PALE = fg(198, 247, 213); // #c6f7d5 — text
const AMBER = fg(255, 196, 0); // #ffc400 — accents
const RED = fg(255, 85, 85); // #ff5555
const CYAN = fg(0, 229, 255); // #00e5ff — secondary neon (bottom of gradient)
const CYAN_DIM = fg(0, 150, 170); // #0096aa — dim cyan deck frame
const MAGENTA = fg(255, 46, 151); // #ff2e97 — record / glitch accent
const MAGENTA_DIM = fg(150, 40, 95); // #96285f — wordmark extrusion / tagline

// Vertical green→cyan gradient, one face color per wordmark row (6 rows).
const GRAD = [
  fg(0, 255, 127),
  fg(0, 240, 150),
  fg(0, 225, 180),
  fg(0, 215, 205),
  fg(0, 225, 235),
  fg(0, 229, 255),
];
// glyphs used while a cell is still "decrypting" (width-1, like the real glyphs)
const SCRAMBLE = "█▀▄▌▐╔╗╚╝║═╦╩╠╣".split("");
// flicker colors for unlocked cells — glitchy RGB split
const SCAN_COLORS = [CYAN, GREEN, MAGENTA];
// per-cell level-meter colors (left→right)
const METER = [MAGENTA, AMBER, GREEN, GREEN, CYAN, CYAN];

// box-drawing "extrusion" glyphs (ANSI-shadow font) → dim magenta outline
const SHADOW_CHARS = new Set("╔╗╚╝║═╦╩╠╣".split(""));
// solid block glyphs → gradient face
const BLOCK_CHARS = new Set("█▀▄▌▐▮".split(""));

// ---- animation timing (tunable) --------------------------------------------
const REVEAL_MS = 800; // one-time wordmark decrypt-in on launch
const TAG_REVEAL_MS = 560; // tagline/status fade in near the end of the reveal
const REVEAL_TICK_MS = 55; // repaint cadence DURING the one-time reveal only

const deterministicHash = (r: number, c: number) =>
  (r * 131 + c * 17 + ((r * c) % 7) * 53) >>> 0;

/** Two-tone gradient coloring of one steady (settled) wordmark row: gradient face
 *  for block glyphs, dim-magenta extrusion for the box-drawing depth glyphs. */
function colorWordmarkRow(line: string, row: number): string {
  const face = GRAD[row] ?? GREEN;
  let out = "";
  let mode: "block" | "shadow" | "" = "";
  for (const ch of line) {
    const want: "block" | "shadow" | "" = BLOCK_CHARS.has(ch)
      ? "block"
      : SHADOW_CHARS.has(ch)
        ? "shadow"
        : "";
    if (want && want !== mode) {
      out += want === "block" ? face : MAGENTA_DIM;
      mode = want;
    }
    out += ch;
  }
  return out + RESET;
}

/** Per-cell lock time for the decrypt sweep: a left→right wipe with a small
 *  per-row offset and jitter, so the name resolves like a terminal decrypting. */
function lockTime(row: number, col: number, maxW: number): number {
  const base = (col / Math.max(1, maxW)) * REVEAL_MS * 0.78;
  const rowOff = row * 16;
  const jitter = (deterministicHash(row, col) % 5) * 28;
  return Math.min(REVEAL_MS, base + rowOff + jitter);
}

/** One wordmark row mid-reveal: settled cells in their final color, unsettled
 *  cells flicker through scramble glyphs in glitchy scan colors. Spaces hold. */
function revealWordmarkRow(line: string, row: number, elapsed: number, maxW: number): string {
  const face = GRAD[row] ?? GREEN;
  const tick = Math.floor(elapsed / 45);
  let out = "";
  let cur = "";
  let col = 0;
  for (const ch of line) {
    if (ch === " ") {
      out += " ";
      col++;
      continue;
    }
    const isBlock = BLOCK_CHARS.has(ch);
    const isShadow = SHADOW_CHARS.has(ch);
    if (!isBlock && !isShadow) {
      out += ch;
      col++;
      continue;
    }
    if (elapsed >= lockTime(row, col, maxW)) {
      const c = isBlock ? face : MAGENTA_DIM;
      if (c !== cur) {
        out += c;
        cur = c;
      }
      out += ch;
    } else {
      const g = SCRAMBLE[(deterministicHash(row, col) + tick) % SCRAMBLE.length];
      const c = SCAN_COLORS[(tick + col) % SCAN_COLORS.length];
      if (c !== cur) {
        out += c;
        cur = c;
      }
      out += g;
    }
    col++;
  }
  return out + RESET;
}

export interface HeaderOptions {
  /** Raw assets/banner.txt content (play box + wordmark + tagline). */
  banner: string;
  /** overcast version, shown on the deck (`v0.0.1`). */
  version: string;
  /** Bare context filename (e.g. "CLAUDE.md"), or "" if none loaded. */
  contextFile: string;
  /** Tool/verb count. */
  tools: number;
  /** Active model id (e.g. "tinycloud:advanced"). */
  model: string;
  /** First-run setup cue shown when no completed case setup exists. */
  setup?: string | (() => string | undefined);
}

// Only one header is live at a time; keep a handle so a re-created header (resize,
// theme change) clears the previous timer instead of leaking intervals.
let activeHeader: OvercastHeader | null = null;

/** The animated overcast header: synthwave gradient wordmark + a recording-deck
 *  HUD (blinking REC dot + bouncing level meter) + centered tagline + bracket
 *  status row, with a one-time decrypt reveal on launch. Width-aware so the
 *  fixed-width art can't overflow pi's renderer on a narrow terminal. */
export class OvercastHeader implements Component {
  private readonly deckBox: string[]; // 3 colored play-box rows (no HUD)
  private readonly wordRaw: string[]; // raw wordmark rows (for the reveal)
  private readonly wordSteady: string[]; // settled colored wordmark rows
  private readonly tagPad: number; // left pad to center the tagline
  private readonly tagRaw: string;
  private readonly ctxTag: string;
  private readonly tools: number;
  private readonly model: string;
  private readonly setup: string | (() => string | undefined) | undefined;
  private readonly version: string;
  private readonly maxW: number;
  private readonly ok: boolean;
  private readonly start = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tui: TUI | null,
    opts: HeaderOptions,
  ) {
    const lines = (opts.banner ?? "").replace(/\n+$/, "").split("\n");
    this.ok = lines.length >= 10;
    this.version = opts.version;

    const box = lines.slice(0, 3);
    this.wordRaw = lines.slice(3, 9);
    this.tagRaw = (lines[9] ?? "").trim();
    this.maxW = Math.max(1, ...this.wordRaw.map((l) => l.length));

    // play-box: dim-cyan frame, magenta ▶ play triangle
    this.deckBox = box.map((l) => CYAN_DIM + l.replace("▶", `${MAGENTA}▶${CYAN_DIM}`) + RESET);
    this.wordSteady = this.wordRaw.map((l, i) => colorWordmarkRow(l, i));
    this.tagPad = Math.max(0, Math.floor((this.maxW - visibleWidth(this.tagRaw)) / 2));

    this.ctxTag = opts.contextFile
      ? `${GREEN_DIM}[${GREEN}OK${GREEN_DIM}] ${PALE}${opts.contextFile}`
      : `${GREEN_DIM}[${AMBER}--${GREEN_DIM}] ${PALE}no context`;
    this.tools = opts.tools;
    this.model = opts.model;
    this.setup = opts.setup;

    if (activeHeader) activeHeader.dispose();
    activeHeader = this;
    if (this.ok) {
      this.timer = setInterval(() => this.tick(), REVEAL_TICK_MS);
      this.timer.unref?.();
    }
  }

  /** Drive repaints DURING the one-time decrypt reveal only. Once it finishes the
   *  timer stops for good — no steady-state ticker — so the header never repaints
   *  while idle and never fights the terminal's scrollback. */
  private tick(): void {
    if (Date.now() - this.start >= REVEAL_MS + 120) {
      this.dispose(); // reveal done → stop animating; the header is now static
      this.tui?.requestRender(); // settle the final frame once
      return;
    }
    this.tui?.requestRender();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  invalidate(): void {}

  /** The recording-deck HUD to the right of the play box (3 rows). Static — the
   *  REC dot stays lit and the meter holds a fixed level, since the header stops
   *  repainting after the reveal (an animated dot/meter would need a forever-timer
   *  that breaks scrollback). */
  private hud(): string[] {
    const row0 = `   ${MAGENTA}◉ ${PALE}REC ${MAGENTA_DIM}│ ${CYAN}v${this.version}${RESET}`;
    let meter = "   ";
    for (let i = 0; i < 6; i++) meter += i < 4 ? `${METER[i]}▰` : `${MAGENTA_DIM}▱`;
    meter += RESET;
    const row2 = `   ${MAGENTA_DIM}────────────${RESET}`;
    return [row0, meter, row2];
  }

  private statusRow(): string {
    const setup = typeof this.setup === "function" ? this.setup() : this.setup;
    return (
      `${this.ctxTag}  ${GREEN_DIM}[${MAGENTA}${this.tools}${GREEN_DIM}] ${PALE}tools  ` +
      `${GREEN_DIM}[${CYAN}◆${GREEN_DIM}] ${PALE}${this.model}` +
      (setup ? `  ${GREEN_DIM}[${AMBER}SETUP${GREEN_DIM}] ${PALE}${setup}` : "") +
      RESET
    );
  }

  render(width: number): string[] {
    if (!this.ok) return [];
    const elapsed = Date.now() - this.start;
    const revealing = elapsed < REVEAL_MS;
    const hud = this.hud();

    const lines: string[] = [];
    for (let i = 0; i < 3; i++) lines.push(this.deckBox[i] + hud[i]);
    for (let i = 0; i < this.wordRaw.length; i++) {
      lines.push(revealing ? revealWordmarkRow(this.wordRaw[i], i, elapsed, this.maxW) : this.wordSteady[i]);
    }
    // tagline + status fade in near the end of the reveal (height stays constant)
    const showTag = !revealing || elapsed >= TAG_REVEAL_MS;
    const showStatus = !revealing;
    lines.push(showTag ? " ".repeat(this.tagPad) + MAGENTA_DIM + this.tagRaw + RESET : "");
    lines.push(""); // breathing room
    lines.push(showStatus ? this.statusRow() : "");

    return lines.map((l) => fitWidth(l, width));
  }
}

/** Themed "busy" spinner: an animated ASCII table-flip — windup (cyan) → rage
 *  flip (red) → calm (green) → loop. pi renders custom indicator frames verbatim,
 *  so we color + width-pad them here (pad keeps the trailing label from jiggling). */
export function workingIndicator(): { frames: string[]; intervalMs: number } {
  const cels: Array<[string, string]> = [
    [CYAN, "(•_•)      ┬─┬"], // calm
    [CYAN, "( •_•)     ┬─┬"], // notices
    [CYAN, "(╯°□°)╯    ┬─┬"], // winds up
    [RED, "(╯°□°)╯︵  ┻━┻"], // FLIP
    [RED, "(╯°□°)╯ ︵  ┻━┻"], // table airborne
    [RED, "(╯°□°)╯  ︵  ┻━┻"], // …flying
    [GREEN, "(•_•)"], // table gone, calm
  ];
  const w = Math.max(...cels.map(([, s]) => [...s].length));
  const frames = cels.map(([c, s]) => c + s + " ".repeat(w - [...s].length) + RESET);
  return { frames, intervalMs: 150 };
}

// --- busy label ("verbs") ---------------------------------------------------
// The spinner *glyph* is the table-flip (workingIndicator()); this names the
// *word* beside it. pi's default is "Working..." — overcast instead names the
// actual op while a verb runs (off tool_execution_start), rotating through
// hacker-movie variations, and cycles iconic phrases while it reasons between
// tools. Plain text: pi colors the label with the theme. Lowercase reads hacker.
const OP_LABELS: Record<string, string[]> = {
  // senses
  watch: ["jacking into the feed…", "scrubbing the footage…", "decoding the stream…", "watching the tapes…"],
  listen: ["tapping the wire…", "bugging the line…", "intercepting comms…", "wiretapping…"],
  see: ["ENHANCE… ENHANCE…", "zoom… and ENHANCE…", "running facial recog…", "reading the pixels…"],
  enhance: ["ENHANCE… ENHANCE…", "cleaning the signal…", "upscaling reality…", "de-noising…"],
  view: ["patching the deck…", "cueing the player…", "spinning the reels…"],
  // OSINT
  scan: ["hacking the gibson…", "wardriving the subnet…", "portscanning…", "sweeping the perimeter…"],
  capture: ["exfiltrating…", "siphoning packets…", "ripping the stream…", "grabbing the loot…"],
  monitor: ["sniffing the traffic…", "tailing the target…", "staking it out…", "watching the wire…"],
  target: ["triangulating…", "locking on…", "painting the target…", "running the trace…"],
  source: ["splicing the uplink…", "patching in the feed…", "wiring the tap…"],
  prebrief: ["spinning up the op…", "prepping the rig…", "casing the joint…"],
  // read / reason
  ask: ["interrogating the mainframe…", "querying the matrix…", "asking the oracle…", "pinging the hive mind…"],
  brief: ["compiling the dossier…", "assembling intel…", "writing the report…"],
  case: ["cracking the case…", "pulling the files…", "reading the evidence…"],
  // config / dist
  setup: ["rooting the box…", "patching the kernel…", "flashing the firmware…"],
  provider: ["jacking in providers…", "wiring the backends…", "negotiating handshakes…"],
  doctor: ["probing the rig…", "running diagnostics…", "checking vitals…"],
  skills: ["forging payloads…", "compiling exploits…", "minting skills…"],
  commands: ["enumerating exploits…", "dumping the verb table…"],
  // pi base tools
  bash: ["dropping a shell…", "rooting the shell…", "spawning a subprocess…"],
  read: ["siphoning bytes…", "slurping the file…", "exfiltrating data…"],
  write: ["planting files…", "dropping the payload…", "writing to disk…"],
  edit: ["patching…", "hot-swapping bytes…", "splicing the source…"],
  grep: ["trawling the logs…", "pattern-matching…", "combing the haystack…"],
  find: ["sweeping the filesystem…", "hunting files…", "walking the tree…"],
  ls: ["enumerating…", "listing the directory…", "dumping the manifest…"],
};

/** Iconic hacker/sci-fi phrases shown while the agent reasons between tools. */
const IDLE_LABELS = [
  "hacking the gibson…",
  "it's a unix system, i know this…",
  "accessing the mainframe…",
  "breaching the ICE…",
  "follow the white rabbit…",
  "there is no spoon…",
  "god is a kid with an ant farm…",
  "mess with the best, die like the rest…",
  "shall we play a game?…",
  "bypassing the firewall…",
  "ridin' the lightning…",
  "i'm in…",
];

// Per-verb cursors so each verb advances through ITS OWN variations — a single
// shared counter would make a verb's phrase depend on unrelated verbs' calls.
const opIdx = new Map<string, number>();
let idleIdx = 0;

/** The busy-label for a running tool/verb — rotates through that verb's
 *  variations independently (falls back to `<name>…` for anything unmapped). */
export function opLabel(toolName: string): string {
  const v = OP_LABELS[toolName];
  if (!v || v.length === 0) return `${toolName}…`;
  const i = opIdx.get(toolName) ?? 0;
  opIdx.set(toolName, i + 1);
  return v[i % v.length];
}

/** A themed generic shown while the agent reasons — cycles the iconic phrases. */
export function idleLabel(): string {
  return IDLE_LABELS[idleIdx++ % IDLE_LABELS.length];
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

/** Context percentage as a short integer (e.g. 6) — never the raw float, which
 *  could render as `0.00009999999999999999` and blow out the footer width. */
function fmtPercent(p: number | null): string {
  if (p == null) return "0";
  return String(Math.round(p));
}

/** A left/right-justified minimal footer line (case · tok · ctx% · model · think). */
export class OvercastFooter implements Component {
  constructor(private readonly get: () => FooterData) {}
  // re-rendered each frame from live data; nothing cached to invalidate.
  invalidate(): void {}
  render(width: number): string[] {
    const d = this.get();
    const left = `${RED}●${GREEN_DIM} case://${PALE}${d.caseName}${RESET}`;
    const right =
      `${CYAN}▸${GREEN_DIM}${fmtTokens(d.tokens)} tok ${CYAN}▸${GREEN_DIM}ctx ${PALE}${fmtPercent(d.ctxPercent)}% ` +
      `${CYAN}▸${GREEN}${d.model} ${CYAN}▸${AMBER}think:${d.thinking}${RESET}`;
    const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [fitWidth(left + " ".repeat(pad) + right, width)];
  }
}
