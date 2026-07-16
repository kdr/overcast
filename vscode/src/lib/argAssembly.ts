// PURE argv assembly from a VerbSpecJSON + collected values. NO vscode imports
// — exercised by node --test (see ../../test/argAssembly.test.ts).
import type { VerbSpecJSON } from "../types.ts";

export interface CollectedValues {
  /** positional values keyed by ArgSpec.name (string, or string[] for variadic) */
  args: Record<string, string | string[] | undefined>;
  /** flag values keyed by FlagSpec.name; booleans emit bare --flag when true */
  flags: Record<string, string | number | boolean | undefined>;
}

/**
 * Build the CLI argv (verb first; --case/--json are appended by CliBridge).
 *
 * Positionals bind in spec order, so a value after an omitted optional
 * positional would silently shift — that's an error here, not a guess.
 * Flags: undefined/empty-string skipped, values strictly equal to the spec
 * default skipped, boolean true → bare --flag, false → omitted.
 */
export function assembleArgs(spec: VerbSpecJSON, values: CollectedValues): string[] {
  const argv: string[] = [spec.name];
  let omitted: string | undefined;
  for (const a of spec.args) {
    const v = values.args[a.name];
    const empty = v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (a.required) {
        throw new Error(`overcast ${spec.name}: missing required argument <${a.name}>`);
      }
      omitted = omitted ?? a.name;
      continue;
    }
    if (omitted) {
      throw new Error(
        `overcast ${spec.name}: <${a.name}> given after omitted <${omitted}> — positionals bind in order`,
      );
    }
    if (Array.isArray(v)) argv.push(...v);
    else argv.push(v);
  }
  for (const f of spec.flags) {
    const v = values.flags[f.name];
    if (v === undefined || v === "") continue;
    if (f.default !== undefined && v === f.default) continue;
    if (f.type === "boolean") {
      if (v === true) argv.push(`--${f.name}`);
      continue;
    }
    argv.push(`--${f.name}`, String(v));
  }
  return argv;
}
