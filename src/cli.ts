// CLI dispatch (one verb spec → CLI surface). Handles --version, commands --json,
// and direct verb execution (persist + print). Launching the pi TUI lives in
// bin/overcast.ts (dynamic import) so pure verb calls stay fast and pi-free.

import { versionInfo } from "./version.js";
import { VERBS, findVerb } from "./registry/verbs.js";
import { toJSON, type VerbContext } from "./registry/types.js";
import { parseVerbArgs, renderVerbHelp } from "./registry/to-cli.js";
import { openCase } from "./case.js";
import { loadProfile, type HomeOptions } from "./profile.js";
import type { OvercastRecord } from "./record.js";

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
  let caseDir: string | undefined;
  let home: string | undefined;
  let profile: string | undefined;
  // each global REQUIRES a value; a missing value (end of argv or a following
  // flag) is an error rather than silently consuming nothing / the next flag.
  const take = (name: string, i: number): string | undefined => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      errors.push(`${name} requires a value`);
      return undefined;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--case") {
      caseDir = take("--case", i);
      i++;
    } else if (t === "--home") {
      home = take("--home", i);
      i++;
    } else if (t === "--profile") {
      profile = take("--profile", i);
      i++;
    } else rest.push(t);
  }
  return { rest, caseDir, home, profile, errors };
}

function renderRecord(rec: OvercastRecord, format: string): string {
  if (format === "json") return JSON.stringify(rec, null, 2);
  if (format === "md" || format === "txt") {
    if (typeof rec.payload === "string") return rec.payload;
    // prefer a `content` field for md; else stringify
    const p = rec.payload as Record<string, unknown>;
    if (typeof p.content === "string" && p.content) return p.content;
    return JSON.stringify(rec.payload, null, 2);
  }
  // default human summary
  const head = `${rec.id} [${rec.verb}] state=${rec.state ?? "ready"}`;
  if (rec.error) return `${head}\n  error: ${rec.error}`;
  if (typeof rec.payload === "string") return `${head}\n  ${rec.payload.slice(0, 400)}`;
  const keys = Object.keys(rec.payload);
  return `${head}\n  payload: { ${keys.join(", ")} }${rec.media ? `\n  media: ${rec.media.ref}` : ""}`;
}

/** Run the CLI. Returns a process exit code. */
export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const cmd = argv[0];

  // version
  if (cmd === "version" || argv.includes("--version") || argv.includes("-v")) {
    const json = argv.includes("--json");
    io.out(
      json
        ? JSON.stringify(versionInfo()) + "\n"
        : `overcast ${versionInfo().overcast} (pi ${versionInfo().pi})\n`,
    );
    return 0;
  }

  // commands --json: dump the registry (source of truth)
  if (cmd === "commands") {
    const json = argv.includes("--json");
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
    const { rest, caseDir, home, profile, errors: globalErrors } = extractGlobals(argv.slice(1));
    const parsed = parseVerbArgs(spec, rest);
    if (parsed.help) {
      io.out(renderVerbHelp(spec));
      return 0;
    }
    const allErrors = [...globalErrors, ...parsed.errors];
    if (allErrors.length) {
      for (const e of allErrors) io.err(`overcast ${spec.name}: ${e}\n`);
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
    };

    let records: OvercastRecord[];
    try {
      records = await spec.run(ctx);
    } catch (e) {
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
