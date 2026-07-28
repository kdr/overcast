// Small string/text utilities shared across the codebase.

/** Escape a literal for embedding in a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ESC-introduced terminal sequences, built from explicit escapes so NO raw
// control byte ever appears in this source file. Whole sequences are matched,
// not just the introducer: stripping the ESC alone out of `ESC [ 2 J` would
// leave a visible "[2J" behind.
//   CSI   ESC [ params final     cursor moves, erase display/line (the forgery primitive)
//   OSC   ESC ] ... BEL | ST     window title, hyperlink (OSC 8), clipboard write (OSC 52)
//   DCS / SOS / PM / APC         ESC P|X|^|_ ... ST
//   short ESC ( B charset select, ESC 7 / ESC 8 cursor save+restore
//   last alternative             a lone ESC matching none of the above
const ESC_CHAR = "\u001B";
const BEL_CHAR = "\u0007";
const ST_PATTERN = ESC_CHAR + "\\\\";
const ANSI_SEQUENCE_RE = new RegExp(
  ESC_CHAR +
    "(?:" +
    "\\[[0-9;:<=>?]*[ -/]*[@-~]" +
    "|\\][\\s\\S]*?(?:" + BEL_CHAR + "|" + ST_PATTERN + "|$)" +
    "|[PX^_][\\s\\S]*?(?:" + ST_PATTERN + "|$)" +
    "|[()][0-9A-Za-z]" +
    "|[0-9A-Za-z=><\\\\]" +
    ")?",
  "g",
);

// Remaining C0 controls, DEL, and the raw C1 block (a bare U+009B is CSI on
// terminals that decode 8-bit controls). Keeps ONLY \t (09) and \n (0A) -- a
// lone \r is dropped too, since it overwrites the line just printed.
// 8-bit CSI: on a terminal that decodes C1 controls, U+009B introduces a control
// sequence with NO leading ESC. Stripping it as a lone control char would leave
// its parameters ("2J") as visible text, so match the whole sequence here first.
const C1_CSI_RE = new RegExp("\\u009B[0-9;:<=>?]*[ -/]*[@-~]", "g");

// Remaining C0 controls, DEL, and the rest of the C1 block.
const CONTROL_CHAR_RE = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]",
  "g",
);

/**
 * Strip terminal control sequences from text that ORIGINATED IN UNTRUSTED
 * CONTENT, before any surface prints it.
 *
 * overcast inlines scraped page snippets, transcripts of attacker-supplied
 * media, and provider stderr straight into record payloads, and pi-tui
 * deliberately PRESERVES ANSI/CSI/OSC (it measures them as zero-width). In an
 * evidence tool that is output forgery against the analyst reading the
 * evidence: an erase-display + cursor-home pair repaints the screen with
 * fabricated "records", OSC 8 makes a link's visible text differ from its
 * target, and OSC 52 writes the clipboard on terminals that allow it.
 *
 * Only `\n` and `\t` survive. Sequences are DROPPED rather than escaped: the
 * goal is that untrusted bytes cannot move the cursor, not that they round-trip.
 */
export function sanitizeTerminalText(s: string): string {
  if (!s) return s;
  return s.replace(ANSI_SEQUENCE_RE, "").replace(C1_CSI_RE, "").replace(CONTROL_CHAR_RE, "");
}
