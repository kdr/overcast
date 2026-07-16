// The `installed:` ref scheme (manifests plan, Stage B). Third-party provider
// packages installed by `overcast provider install` live under
// `<home>/providers/<pkg>/` and their descriptors carry
// `installed:<pkg>/<relpath>` tokens, resolved at spawn against the process home
// — the sibling of the `shipped:` scheme for the shipped tree.
//
// Resolution is process-scoped (resolveHome({})): the spawn seam
// (resolveShippedArgv) has no --home context, so cli.ts exports $OVERCAST_HOME
// from --home before dispatch to keep this in agreement with ctx.home.
//
// `installed:` refs are NEVER produced by healing (locked decision 4) — they are
// authored by the install command. Healing (shipped-ref.ts) only rewrites
// absolute paths toward `shipped:` refs and leaves non-absolute tokens untouched.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveHome } from "../home.js";
import { ProviderRefError } from "./ref-error.js";

export const INSTALLED_REF_PREFIX = "installed:";

/** Root dir where installed provider packages live: `<home>/providers/`. */
export function installedProvidersRoot(): string {
  return join(resolveHome(), "providers");
}

export class InstalledRefError extends ProviderRefError {
  constructor(ref: string) {
    const pkg = ref.slice(INSTALLED_REF_PREFIX.length).split("/")[0] || "?";
    super(
      `cannot resolve '${ref}': provider package '${pkg}' is not installed or was removed — ` +
        `reinstall it (\`overcast provider install <path>\`) or rebind the verb to another provider`,
      ref,
      "InstalledRefError",
    );
  }
}

export function isInstalledRef(token: string): boolean {
  return token.startsWith(INSTALLED_REF_PREFIX) && token.length > INSTALLED_REF_PREFIX.length;
}

/** Resolve ONE `installed:<pkg>/<relpath>` token to an absolute path, or undefined
 *  when the package/file isn't present (or the token isn't an installed ref).
 *  Refuses `..` traversal outside the package dir. */
export function resolveInstalledRefToken(token: string): string | undefined {
  if (!isInstalledRef(token)) return undefined;
  const segments = token.slice(INSTALLED_REF_PREFIX.length).split("/").filter(Boolean);
  if (segments.length < 2) return undefined; // need <pkg>/<relpath>
  if (segments.includes("..")) return undefined;
  const abs = join(installedProvidersRoot(), ...segments);
  return existsSync(abs) ? abs : undefined;
}
