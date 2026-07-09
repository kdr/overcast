// Small string/text utilities shared across the codebase.

/** Escape a literal for embedding in a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
