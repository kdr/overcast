// Generate a CLI argv parser + --help from a VerbSpec (one spec → CLI surface).

import type { VerbSpec, FlagSpec } from "./types.js";

export interface ParsedInvocation {
  input?: string;
  rest: string[];
  opts: Record<string, string | number | boolean | undefined>;
  help: boolean;
}

function coerce(flag: FlagSpec, raw: string | boolean): string | number | boolean {
  if (flag.type === "boolean") return raw === true || raw === "true";
  if (flag.type === "number") return Number(raw);
  return String(raw);
}

/**
 * Parse argv (after the verb name) per a spec. Supports:
 *   --flag value | --flag=value | --bool | positional args.
 * Unknown flags are tolerated into opts (loose), matching tinycloud's style.
 */
export function parseVerbArgs(spec: VerbSpec, argv: string[]): ParsedInvocation {
  const flagByName = new Map<string, FlagSpec>();
  for (const f of spec.flags) flagByName.set(f.name, f);

  const positionals: string[] = [];
  const opts: Record<string, string | number | boolean | undefined> = {};
  let help = false;

  for (const f of spec.flags) {
    if (f.default !== undefined) opts[f.name] = f.default;
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") {
      help = true;
      continue;
    }
    if (tok.startsWith("--")) {
      let name = tok.slice(2);
      let value: string | boolean | undefined;
      const eq = name.indexOf("=");
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const flag = flagByName.get(name);
      if (flag && flag.type === "boolean") {
        opts[name] = value === undefined ? true : value === "true";
      } else if (value !== undefined) {
        opts[name] = flag ? coerce(flag, value) : value;
      } else {
        // consume next token as value unless it's another flag
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          opts[name] = flag ? coerce(flag, next) : next;
          i++;
        } else {
          opts[name] = true; // bare unknown flag → boolean
        }
      }
    } else {
      positionals.push(tok);
    }
  }

  return {
    input: positionals[0],
    rest: positionals.slice(1),
    opts,
    help,
  };
}

/** Render `--help` text for a verb from its spec. */
export function renderVerbHelp(spec: VerbSpec): string {
  const lines: string[] = [];
  const argSig = spec.args
    .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`) + (a.variadic ? "..." : ""))
    .join(" ");
  lines.push(`overcast ${spec.name} ${argSig} [options]`);
  lines.push("");
  lines.push(`  ${spec.summary}`);
  if (spec.description) {
    lines.push("");
    lines.push(`  ${spec.description}`);
  }
  if (spec.args.length) {
    lines.push("");
    lines.push("Arguments:");
    for (const a of spec.args) lines.push(`  ${a.name.padEnd(16)} ${a.summary}`);
  }
  lines.push("");
  lines.push("Options:");
  for (const f of spec.flags) {
    const meta = f.type === "boolean" ? "" : ` <${f.type}>`;
    const def = f.default !== undefined ? ` (default: ${f.default})` : "";
    lines.push(`  --${(f.name + meta).padEnd(20)} ${f.summary}${def}`);
  }
  lines.push(`  --json               JSON output`);
  lines.push(`  --format <fmt>       json | md | txt`);
  lines.push("");
  return lines.join("\n");
}
