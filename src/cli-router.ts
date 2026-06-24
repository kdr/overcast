// Pure CLI-vs-TUI routing decision, extracted so it can be unit-tested as a truth
// table (the `bin/overcast.ts` entry self-executes, so it can't be imported). The
// entry calls routeArgv(); `mode: "cli"` runs the verb registry, `"tui"` launches
// the pi agent.

import { findVerb } from "./registry/verbs.js";

const KNOWN_TOP = new Set(["version", "commands", "help"]);
const GLOBAL_FLAGS = new Set(["--case", "--home", "--profile"]);
// overcast's own value-taking leading flags (skipped to find the verb) and the
// boolean output flag — so `overcast --json watch …` / `--format md watch …`
// dispatch the verb instead of treating --json/--format as the command.
const LEADING_VALUE_FLAGS = new Set(["--case", "--home", "--profile", "--format"]);
const LEADING_BOOL_FLAGS = new Set(["--json"]);
const VALID_FORMATS = new Set(["json", "md", "txt"]);

/** The effective command token — the first arg after any leading global/output flags. */
export function effectiveCmd(argv: string[]): string | undefined {
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (LEADING_BOOL_FLAGS.has(name)) { i += 1; continue; } // boolean flag: skip just it
    if (!LEADING_VALUE_FLAGS.has(name)) break;
    if (t.includes("=")) {
      // attached `--flag=value` is one token: skip it, the NEXT token is the
      // command. An attached value can't be mistaken for the verb (it's glued to
      // the flag), and for --format the value's validity is enforced downstream by
      // the verb's flag parser (`--format must be one of json|md|txt`) — so an
      // invalid `--format=bogus` still routes to the CLI to report, never the TUI.
      i += 1;
    } else {
      // space form: consume the value only if it isn't itself a flag — a
      // value-less global is malformed and must surface (reach the CLI), not be
      // swallowed so the command token disappears and the TUI launches. For
      // --format the value must be a REAL format (json|md|txt); otherwise the
      // next token is the verb (`overcast --format watch clip.mp4`), not a value.
      const v = argv[i + 1];
      if (name === "--format") {
        i += v !== undefined && VALID_FORMATS.has(v) ? 2 : 1;
      } else {
        i += v !== undefined && !v.startsWith("-") ? 2 : 1;
      }
    }
  }
  return argv[i];
}

/** True if a leading global flag is present but missing its value — a malformed
 *  CLI invocation that should reach runCli to report the error, not the TUI. */
export function hasMalformedGlobal(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const eq = t.includes("=");
    const name = eq ? t.slice(0, t.indexOf("=")) : t;
    if (!GLOBAL_FLAGS.has(name)) return false; // stop at the first non-global
    if (eq) {
      if (t.slice(t.indexOf("=") + 1) === "") return true; // `--case=`
    } else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) return true; // value-less
      i++; // skip the consumed value
    }
  }
  return false;
}

/** Does this (--tui-stripped) argv dispatch the verb registry (vs launch the TUI)? */
export function isCliDispatch(argv: string[]): boolean {
  const cmd = effectiveCmd(argv);
  // No command after the leading flags. Route to the CLI (to report the error) for
  // a value-less global (`overcast --case`) OR an output-flag-only invocation
  // (`overcast --json` / `--format md`) — those are meaningless without a verb.
  // A globals-only invocation (`overcast --case /dir`) falls through to the TUI.
  if (!cmd) {
    if (hasMalformedGlobal(argv)) return true;
    return argv.some((a) => {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      return LEADING_BOOL_FLAGS.has(name) || name === "--format";
    });
  }
  // A version request is CLI only when it is the command itself, so headless pi
  // usage like `overcast -p "…" -v` still launches the agent.
  if (cmd === "--version" || cmd === "-v") return true;
  // `overcast --help`/`-h` is OUR help, not pi's (only as the effective command).
  if (cmd === "--help" || cmd === "-h") return true;
  if (KNOWN_TOP.has(cmd)) return true;
  if (findVerb(cmd)) return true;
  // A leading non-flag token is a command — route mistyped verbs to the CLI so it
  // reports "unknown command" instead of silently launching the TUI.
  if (!cmd.startsWith("-")) return true;
  return false; // leading pi flag (e.g. -p) → TUI
}

export interface Route {
  mode: "cli" | "tui";
  /** argv with the TUI-only `--tui` flag stripped (what the CLI sees). */
  cliArgv: string[];
}

/** The top-level dispatch decision for `overcast <argv>`. */
export function routeArgv(argv: string[]): Route {
  // --tui is a TUI-only routing flag; the CLI never needs to see it.
  const cliArgv = argv.filter((a) => a !== "--tui");
  return { mode: isCliDispatch(cliArgv) ? "cli" : "tui", cliArgv };
}
