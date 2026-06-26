// Shared CLI-flag validators, reused across verbs so the rules can't drift between
// hand-rolled copies (the inline-`Number()` divergence that let `--offset=` slip
// through as 0 in one verb but not another).

/**
 * Validate a numeric flag. Returns an error string, or undefined when the flag is
 * absent or valid. Rejects:
 *  - a provided-but-blank value (`--flag=` → `Number("")` is 0, which would
 *    otherwise silently satisfy an inclusive lower bound like `>= 0`),
 *  - non-finite values (NaN / Infinity),
 *  - anything failing `ok` (the caller's bounds).
 * `expect` describes the valid range for the message (e.g. "a positive number").
 */
export function badNumber(
  opts: Record<string, unknown>,
  name: string,
  ok: (n: number) => boolean,
  expect: string,
): string | undefined {
  const raw = opts[name];
  if (raw == null) return undefined;
  if (typeof raw === "string" && !raw.trim()) return `invalid --${name}: (empty) (expected ${expect})`;
  const n = Number(raw);
  if (!Number.isFinite(n) || !ok(n)) return `invalid --${name}: ${raw} (expected ${expect})`;
  return undefined;
}

/** Coerce a validated numeric flag to a number (or undefined if absent). Pair with
 *  badNumber — call badNumber first to reject bad input, then this to read it. */
export function numFlag(opts: Record<string, unknown>, name: string): number | undefined {
  return opts[name] != null ? Number(opts[name]) : undefined;
}
