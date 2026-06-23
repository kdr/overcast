// CLI dispatch (one verb spec → CLI surface). Handles --version, commands --json,
// and direct verb execution (persist + print). Launching the pi TUI lives in
// bin/overcast.ts (dynamic import) so pure verb calls stay fast and pi-free.

import { versionInfo, OVERCAST_VERSION } from "./version.js";
import { VERBS, findVerb } from "./registry/verbs.js";
import { toJSON, type VerbContext, type VerbSpec } from "./registry/types.js";
import { parseVerbArgs, renderVerbHelp } from "./registry/to-cli.js";
import { openCase } from "./case.js";
import { loadProfile, type HomeOptions } from "./profile.js";
import { makeRecord, type OvercastRecord } from "./record.js";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/** Extract global flags (--case/--home/--profile) and return the remainder. */
function extractGlobals(argv: string[]): {
  rest: string[];
  caseDir?: string;
  home?: string;
  profile?: string;
  errors: string[];
} {
  const rest: string[] = [];
  const errors: string[] = [];
  const values: Record<string, string> = {};
  const GLOBALS = ["--case", "--home", "--profile"];
  // Each global REQUIRES a value, supplied either as `--case /path` or the
  // attached `--case=/path` form. A missing value (end of argv or a following
  // flag) is an error — and we must NOT swallow that following flag.
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const eq = t.indexOf("=");
    const name = eq >= 0 ? t.slice(0, eq) : t;
    if (!GLOBALS.includes(name)) {
      rest.push(t);
      continue;
    }
    if (eq >= 0) {
      const v = t.slice(eq + 1);
      if (v === "") errors.push(`${name} requires a value`);
      else values[name] = v;
    } else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        // leave the following token for normal parsing — don't advance i.
        errors.push(`${name} requires a value`);
      } else {
        values[name] = v;
        i++; // consume the value
      }
    }
  }
  return {
    rest,
    caseDir: values["--case"],
    home: values["--home"],
    profile: values["--profile"],
    errors,
  };
}

function renderRecord(rec: OvercastRecord, format: string): string {
  if (format === "json") return JSON.stringify(rec, null, 2);
  if (format === "md" || format === "txt") {
    if (typeof rec.payload === "string") return rec.payload;
    // prefer a human-readable text field (content/text/report — e.g. ask/brief
    // place their markdown under text/report); else stringify.
    const p = rec.payload as Record<string, unknown>;
    for (const k of ["content", "text", "report"]) {
      if (typeof p[k] === "string" && p[k]) return p[k] as string;
    }
    return JSON.stringify(rec.payload, null, 2);
  }
  // default human summary
  const head = `${rec.id} [${rec.verb}] state=${rec.state ?? "ready"}`;
  if (rec.error) return `${head}\n  error: ${rec.error}`;
  if (typeof rec.payload === "string") return `${head}\n  ${rec.payload.slice(0, 400)}`;
  const keys = Object.keys(rec.payload);
  return `${head}\n  payload: { ${keys.join(", ")} }${rec.media ? `\n  media: ${rec.media.ref}` : ""}`;
}

const GROUP_TITLES: Record<VerbSpec["group"], string> = {
  sense: "Senses",
  inspect: "Inspect",
  osint: "OSINT",
  read: "Read",
  state: "State",
  config: "Config",
};

/** Top-level `overcast --help`: the overcast surface (NOT pi's help). */
export function renderTopHelp(): string {
  const lines: string[] = [];
  lines.push(`overcast ${OVERCAST_VERSION} — senses (video/audio/image) + OSINT reach for any agent, built on pi`);
  lines.push("");
  lines.push("Usage:");
  lines.push("  overcast                      Launch the interactive overcast agent (TUI)");
  lines.push("  overcast <verb> [args] [--json]   Run a verb and emit record(s)");
  lines.push("  overcast -p \"<task>\" [--mode json]  Headless agent (one task, then exit)");
  lines.push("  overcast commands --json      Dump the verb registry (source of truth)");
  lines.push("  overcast --version [--json]   Version + pinned pi");
  lines.push("");
  const groups = new Map<VerbSpec["group"], VerbSpec[]>();
  for (const v of VERBS) {
    const a = groups.get(v.group) ?? [];
    a.push(v);
    groups.set(v.group, a);
  }
  for (const [group, title] of Object.entries(GROUP_TITLES) as [VerbSpec["group"], string][]) {
    const verbs = groups.get(group);
    if (!verbs || verbs.length === 0) continue;
    lines.push(`${title}:`);
    for (const v of verbs) lines.push(`  ${v.name.padEnd(12)} ${v.summary}`);
    lines.push("");
  }
  lines.push("Global flags:");
  lines.push("  --case <dir>     Operate on the case rooted at <dir> (default: cwd)");
  lines.push("  --home <dir>     overcast home for profiles (default: ~/.overcast)");
  lines.push("  --profile <name> Active profile (default: default)");
  lines.push("  --json           JSON output  ·  --format json|md|txt");
  lines.push("");
  lines.push("Run `overcast <verb> --help` for a verb's man page.");
  return lines.join("\n");
}

/** Run the CLI. Returns a process exit code. */
export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  // Global flags may appear anywhere — including before the verb
  // (`overcast --case /dir watch v.mp4`). Strip them up front, then treat the
  // first remaining token as the command.
  const { rest: tokens, caseDir, home, profile, errors: globalErrors } =
    extractGlobals(argv);
  const cmd = tokens[0];

  // top-level help (overcast's own — never pi's). Validate globals first so a
  // bad `--case`/`--home`/`--profile` is reported, consistent with verb dispatch.
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    if (globalErrors.length) {
      for (const e of globalErrors) io.err(`overcast: ${e}\n`);
      return 2;
    }
    io.out(renderTopHelp() + "\n");
    return 0;
  }

  // version — only when it's the command itself, so `overcast watch x -v` runs
  // the verb (and an unknown command with a stray -v still errors) rather than
  // printing the version for a `-v` anywhere in argv.
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const json = tokens.includes("--json");
    io.out(
      json
        ? JSON.stringify(versionInfo()) + "\n"
        : `overcast ${versionInfo().overcast} (pi ${versionInfo().pi})\n`,
    );
    return 0;
  }

  // commands --json: dump the registry (source of truth)
  if (cmd === "commands") {
    const json = tokens.includes("--json");
    const specs = VERBS.map(toJSON);
    if (json) {
      io.out(JSON.stringify({ verbs: specs }, null, 2) + "\n");
    } else {
      for (const s of specs) io.out(`${s.name.padEnd(12)} ${s.summary}\n`);
    }
    return 0;
  }

  // verb dispatch
  const spec = cmd ? findVerb(cmd) : undefined;
  if (spec) {
    // Validate globals before anything else (including --help): an invalid
    // global like a value-less `--case` is an error regardless.
    if (globalErrors.length) {
      for (const e of globalErrors) io.err(`overcast ${spec.name}: ${e}\n`);
      return 2;
    }
    const parsed = parseVerbArgs(spec, tokens.slice(1));
    if (parsed.help) {
      io.out(renderVerbHelp(spec));
      return 0;
    }
    if (parsed.errors.length) {
      for (const e of parsed.errors) io.err(`overcast ${spec.name}: ${e}\n`);
      return 2;
    }
    const homeOpts: HomeOptions = { home, profile };
    const c = openCase(caseDir ?? process.cwd());
    c.ensure();
    const ctx: VerbContext = {
      input: parsed.input,
      rest: parsed.rest,
      opts: parsed.opts,
      case: c,
      profile: loadProfile(homeOpts),
      home,
      profileName: profile,
    };

    let records: OvercastRecord[];
    try {
      records = await spec.run(ctx);
    } catch (e) {
      // Spawn failure / timeout / abort: persist an error record like provider
      // non-zero exits do, so the case store reflects the attempt.
      const rec = makeRecord({
        verb: spec.name,
        format: "json",
        payload: {},
        error: (e as Error).message,
        state: "error",
      });
      c.writeRecord(rec);
      io.err(`overcast ${spec.name}: ${(e as Error).message}\n`);
      return 1;
    }

    for (const rec of records) c.writeRecord(rec);

    const wantJson = parsed.opts.json === true || parsed.opts.format === "json";
    const format = wantJson ? "json" : (parsed.opts.format as string) ?? "human";
    for (const rec of records) io.out(renderRecord(rec, format) + "\n");

    // a record in error state → non-zero exit (state is authoritative hint)
    return records.some((r) => r.state === "error") ? 1 : 0;
  }

  // unknown command
  io.err(`overcast: unknown command '${cmd ?? ""}'\n`);
  return 1;
}
