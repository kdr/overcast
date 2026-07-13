// The `shipped:` ref scheme (plan 07, Stage B): catalog descriptors and profiles
// persist location-independent `shipped:<relpath>` tokens (relpath from the
// package root, e.g. `shipped:providers/senses/fal/enhance.sh`,
// `shipped:scripts/visual-db-uv.sh`) instead of resolved absolute paths — so a
// binding survives the install moving (nvm switch, binary relocation, folder
// rename). Refs resolve through shippedPath() at SPAWN time; this module is the
// one resolver + the profile-healing table for pre-ref absolute paths.

import { existsSync } from "node:fs";
import { shippedPath } from "../pkg.js";
import type { ProviderDescriptor } from "../profile.js";

export const SHIPPED_REF_PREFIX = "shipped:";

/** Raised when a `shipped:` token can't resolve in this build (e.g. a bun binary
 *  without the providers/ sidecar next to the executable). */
export class ShippedRefError extends Error {
  ref: string;
  constructor(ref: string) {
    super(
      `cannot resolve '${ref}': this build lacks the shipped provider files (providers/ sidecar missing) — ` +
        `reinstall, or rebind a provider you have (\`overcast provider setup apply --verb <verb> --choice <id> --yes\`)`,
    );
    this.name = "ShippedRefError";
    this.ref = ref;
  }
}

export function isShippedRef(token: string): boolean {
  return token.startsWith(SHIPPED_REF_PREFIX) && token.length > SHIPPED_REF_PREFIX.length;
}

/** Resolve ONE `shipped:<relpath>` token to an absolute path, or undefined when
 *  this build doesn't carry the file (or the token isn't a ref). */
export function resolveShippedRefToken(token: string): string | undefined {
  if (!isShippedRef(token)) return undefined;
  const segments = token.slice(SHIPPED_REF_PREFIX.length).split("/").filter(Boolean);
  if (!segments.length) return undefined;
  return shippedPath(...segments);
}

/** Replace every `shipped:` token in an argv with its resolved absolute path.
 *  Resolution happens POST-tokenization so a resolved path containing spaces
 *  stays one argv token. Throws ShippedRefError on an unresolvable ref. */
export function resolveShippedArgv(argv: string[]): string[] {
  return argv.map((token) => {
    if (!isShippedRef(token)) return token;
    const abs = resolveShippedRefToken(token);
    if (!abs) throw new ShippedRefError(token);
    return abs;
  });
}

/** The command-string fields a ProviderDescriptor can execute (run template +
 *  the describe/init sidecar commands). */
export function descriptorCommandStrings(desc: ProviderDescriptor | undefined): string[] {
  if (!desc) return [];
  const out: string[] = [];
  if (typeof desc.run === "string") out.push(desc.run);
  if (typeof desc.describe === "string") out.push(desc.describe);
  if (typeof desc.init === "string") out.push(desc.init);
  else if (desc.init && typeof desc.init === "object" && typeof desc.init.command === "string") out.push(desc.init.command);
  return out;
}

/** Every distinct `shipped:` ref in a descriptor mapped to its resolved absolute
 *  path (null = unresolvable in this build). Transparency for `provider setup
 *  show/plan` — the STORED descriptor keeps the ref. */
export function shippedRefResolution(desc: ProviderDescriptor | undefined): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {};
  for (const cmd of descriptorCommandStrings(desc)) {
    for (const token of cmd.split(/\s+/)) {
      if (isShippedRef(token)) out[token] = resolveShippedRefToken(token) ?? null;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// ---- healing (old profiles + case policies) ---------------------------------
//
// Pre-Stage-B profiles persist RESOLVED absolute paths (the old catalog behavior)
// under the OLD `examples/providers/` layout or the Stage-A `providers/` tree.
// On load we rewrite recognized tokens to `shipped:` refs — but ONLY when the ref
// resolves in this build; anything unrecognized (user-authored custom paths)
// passes through untouched, and `doctor` flags what healing couldn't fix.

/** Stage-A move table: old `examples/providers/<sub>` → new repo-root relpath.
 *  Only entries that moved INTO the shipped providers/ tree heal to refs; the
 *  authoring demos (bash/python/ts) and intra-examples moves stay absolute. */
function mapLegacyExamplesSubpath(sub: string): string | undefined {
  // moved WITHIN examples/ (still demos, not shipped):
  if (sub === "sources/mcp-bridge.ts" || sub === "hf/enhance.py") return undefined;
  const head = sub.split("/")[0];
  if (head === "sources") return `providers/${sub}`;
  if (
    ["hf", "fal", "elevenlabs", "tinycloud", "detect", "geocode", "exif", "verify", "local", "enhance"].includes(head)
  ) {
    return `providers/senses/${sub}`;
  }
  if (head === "visual-db" || head === "audio-db" || head === "screenshot") return `providers/engines/${sub}`;
  return undefined; // bash/python/ts demos + anything unknown → untouched
}

/** Heal ONE token: an absolute path that clearly points at shipped provider code
 *  (old examples layout, the providers/ tree, or scripts/visual-db-uv.sh) becomes
 *  a `shipped:` ref when that ref resolves in this build; else pass through. */
export function healShippedToken(token: string): string {
  if (!token.startsWith("/")) return token; // only absolute paths are healed
  let rel: string | undefined;
  const legacy = token.match(/\/examples\/providers\/(.+)$/);
  if (legacy) {
    rel = mapLegacyExamplesSubpath(legacy[1]);
  } else {
    const current = token.match(/\/providers\/(sources|senses|engines)\/(.+)$/);
    if (current) rel = `providers/${current[1]}/${current[2]}`;
    else if (/\/scripts\/visual-db-uv\.sh$/.test(token)) rel = "scripts/visual-db-uv.sh";
  }
  if (!rel) return token;
  const ref = SHIPPED_REF_PREFIX + rel;
  return resolveShippedRefToken(ref) ? ref : token;
}

/** Heal a descriptor command string token-wise, preserving the original text
 *  everywhere no token healed (whitespace/quoting untouched). Replacement is
 *  whitespace-bounded so a healed path can't rewrite a longer sibling token. */
export function healCommandString(cmd: string): string {
  let healed = cmd;
  for (const token of new Set(cmd.split(/\s+/))) {
    const next = healShippedToken(token);
    if (next === token) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    healed = healed.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "g"), `$1${next}`);
  }
  return healed;
}

/** Heal a descriptor's executable command fields in place; returns the same
 *  object for chaining. Memory templates are untouched (never catalog-written). */
export function healDescriptor<T extends ProviderDescriptor>(desc: T): T {
  if (typeof desc.run === "string") desc.run = healCommandString(desc.run);
  if (typeof desc.describe === "string") desc.describe = healCommandString(desc.describe);
  if (typeof desc.init === "string") desc.init = healCommandString(desc.init);
  else if (desc.init && typeof desc.init === "object" && typeof desc.init.command === "string") {
    desc.init.command = healCommandString(desc.init.command);
  }
  return desc;
}

// ---- doctor support ----------------------------------------------------------

export interface ShippedTokenIssue {
  kind: "unresolvable_ref" | "stale_path";
  token: string;
}

/** Does an absolute path look like it points at shipped provider code (the
 *  healing patterns)? Used by doctor to tell a stale shipped path from a
 *  user-authored custom one. */
function looksLikeShippedPath(token: string): boolean {
  if (!token.startsWith("/")) return false;
  return (
    /\/examples\/providers\//.test(token) ||
    /\/providers\/(sources|senses|engines)\//.test(token) ||
    /\/scripts\/visual-db-uv\.sh$/.test(token)
  );
}

/** Scan a descriptor command string for (a) `shipped:` refs this build can't
 *  resolve and (b) stale absolute shipped-provider paths that no longer exist
 *  on disk (healing left them because the ref target didn't resolve either). */
export function findShippedTokenIssues(cmd: string): ShippedTokenIssue[] {
  const issues: ShippedTokenIssue[] = [];
  for (const token of cmd.split(/\s+/)) {
    if (isShippedRef(token)) {
      if (!resolveShippedRefToken(token)) issues.push({ kind: "unresolvable_ref", token });
    } else if (looksLikeShippedPath(token) && !existsSync(token)) {
      issues.push({ kind: "stale_path", token });
    }
  }
  return issues;
}
