// The `shipped:` ref scheme (plan 07, Stage B): catalog descriptors and profiles
// persist location-independent `shipped:<relpath>` tokens (relpath from the
// package root, e.g. `shipped:providers/senses/fal/enhance.sh`,
// `shipped:scripts/visual-db-uv.sh`) instead of resolved absolute paths — so a
// binding survives the install moving (nvm switch, binary relocation, folder
// rename). Refs resolve through shippedPath() at SPAWN time; this module is the
// one resolver + the profile-healing table for pre-ref absolute paths.

import { existsSync, realpathSync } from "node:fs";
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

/** A flat (pre-reshuffle) source-script relpath → its per-directory home:
 *  `providers/sources/tiktok.sh` → `providers/sources/tiktok/tiktok.sh`. Any
 *  other relpath (already nested, senses/engines, non-.sh) passes through. The
 *  source scripts moved into per-type dirs with the provider.json manifests, so
 *  old persisted refs / OVERCAST_SOURCE_*_CMD values must remap to still resolve. */
function nestFlatSourceRelpath(rel: string): string {
  const m = rel.match(/^providers\/sources\/([^/]+)\.sh$/);
  return m ? `providers/sources/${m[1]}/${m[1]}.sh` : rel;
}

/** Resolve ONE `shipped:<relpath>` token to an absolute path, or undefined when
 *  this build doesn't carry the file (or the token isn't a ref). A flat
 *  pre-reshuffle source ref that no longer resolves is retried at its nested home. */
export function resolveShippedRefToken(token: string): string | undefined {
  if (!isShippedRef(token)) return undefined;
  const rel = token.slice(SHIPPED_REF_PREFIX.length);
  const segments = rel.split("/").filter(Boolean);
  if (!segments.length) return undefined;
  const direct = shippedPath(...segments);
  if (direct) return direct;
  const nested = nestFlatSourceRelpath(rel);
  if (nested !== rel) return shippedPath(...nested.split("/").filter(Boolean));
  return undefined;
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
// Pre-Stage-B profiles/case policies persist RESOLVED absolute paths (the old
// catalog behavior) under the OLD `examples/providers/` layout or the Stage-A
// `providers/` tree. On load we rewrite them to `shipped:` refs — but only when
// the rewrite can't change which file runs: the ref must resolve here AND either
// point at the very same file (a pure portability upgrade) or be an
// overcast-specific shape we can't confuse with a user fork (the removed legacy
// `examples/providers/` layout, `scripts/visual-db-uv.sh`). Everything else —
// user-authored custom paths, a user fork reusing the `providers/<class>/`
// layout — passes through untouched; `doctor` flags what healing couldn't fix.

/** Stage-A move table: old `examples/providers/<sub>` → new repo-root relpath.
 *  Only entries that moved INTO the shipped providers/ tree heal to refs; the
 *  authoring demos (bash/python/ts) and intra-examples moves stay absolute. */
function mapLegacyExamplesSubpath(sub: string): string | undefined {
  // moved WITHIN examples/ (still demos, not shipped):
  if (sub === "sources/mcp-bridge.ts" || sub === "hf/enhance.py") return undefined;
  const head = sub.split("/")[0];
  if (head === "sources") return nestFlatSourceRelpath(`providers/${sub}`);
  if (
    ["hf", "fal", "elevenlabs", "tinycloud", "detect", "geocode", "exif", "verify", "local", "enhance"].includes(head)
  ) {
    return `providers/senses/${sub}`;
  }
  if (head === "visual-db" || head === "audio-db" || head === "screenshot") return `providers/engines/${sub}`;
  return undefined; // bash/python/ts demos + anything unknown → untouched
}

/** The `shipped:` ref an absolute path WOULD map to if it points at overcast's
 *  shipped provider layout — the removed legacy `examples/providers/`, the current
 *  `providers/{sources,senses,engines}/` tree, or `scripts/visual-db-uv.sh`.
 *  Undefined for anything else. Pure mapping — does NOT check whether the ref
 *  resolves in this build (callers decide that). One place both healing and the
 *  doctor stale-path check agree on "is this one of ours". */
function shippedRefCandidate(token: string): string | undefined {
  if (!token.startsWith("/")) return undefined; // only absolute paths
  const legacy = token.match(/\/examples\/providers\/(.+)$/);
  if (legacy) {
    const rel = mapLegacyExamplesSubpath(legacy[1]);
    return rel ? SHIPPED_REF_PREFIX + rel : undefined;
  }
  const current = token.match(/\/providers\/(sources|senses|engines)\/(.+)$/);
  if (current) return `${SHIPPED_REF_PREFIX}${nestFlatSourceRelpath(`providers/${current[1]}/${current[2]}`)}`;
  if (/\/scripts\/visual-db-uv\.sh$/.test(token)) return `${SHIPPED_REF_PREFIX}scripts/visual-db-uv.sh`;
  return undefined;
}

/** True when two paths resolve (through symlinks) to the same real file. */
function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** An absolute path shaped like overcast's OWN install (not something a user
 *  would plausibly reuse for a fork): the removed legacy `examples/providers/`
 *  layout, or the top-level `scripts/visual-db-uv.sh`. The current
 *  `providers/{sources,senses,engines}/` layout is deliberately NOT here — a user
 *  fork can reuse it, so those heal only as a same-file rewrite (below). */
function isOvercastSpecificPath(token: string): boolean {
  return /\/examples\/providers\//.test(token) || /\/scripts\/visual-db-uv\.sh$/.test(token);
}

/** Heal ONE token: an absolute path that points at shipped provider code becomes
 *  a portable `shipped:` ref — but ONLY when the rewrite can't change which file
 *  runs. If the path still exists we heal only when the ref resolves to the SAME
 *  file (a pure portability upgrade), so a user fork that happens to reuse the
 *  `providers/<class>/` layout but lives elsewhere is left untouched. If the path
 *  is gone we heal only overcast-specific shapes (the removed legacy
 *  `examples/providers/` layout, `scripts/visual-db-uv.sh`); a missing
 *  current-layout `providers/<class>/` path is ambiguous (could be a user's moved
 *  fork), so it's left for doctor to flag. */
export function healShippedToken(token: string): string {
  const ref = shippedRefCandidate(token);
  if (!ref) return token;
  const resolved = resolveShippedRefToken(ref);
  if (!resolved) return token; // ref not shipped in this build → nothing to heal to
  if (existsSync(token)) return sameFile(token, resolved) ? ref : token;
  return isOvercastSpecificPath(token) ? ref : token;
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
  kind: "unresolvable_ref" | "stale_path" | "missing_script";
  token: string;
}

/** True for a token that is unambiguously a script FILE path (absolute, ending in
 *  a known interpreter suffix) — not a PATH-resolved command (`tinycloud`,
 *  `python3`), a flag, or a `{{input}}` placeholder. Used to decide whether a
 *  non-existent token is a broken binding worth flagging vs. something we can't
 *  judge. Absolute only: a relative path is cwd-dependent, so its (non-)existence
 *  here says nothing reliable. */
function looksLikeScriptPath(token: string): boolean {
  return token.startsWith("/") && /\.(sh|py|mjs|cjs|js|ts)$/.test(token);
}

/** Scan a descriptor command string for (a) `shipped:` refs this build can't
 *  resolve, (b) stale absolute shipped-provider paths — a path that maps to a
 *  shipped ref which DOES resolve here, but the path itself is gone (install
 *  moved / old layout) — and (c) any other absolute script path that simply
 *  doesn't exist (a moved/renamed demo like examples/providers/hf/enhance.py ->
 *  python/enhance.py, or a deleted fork). (a)/(b) are re-applied away with
 *  `provider setup apply`; (c) isn't ours to heal (no shipped ref — it may be a
 *  user's own provider), but it WILL fail at spawn, so we surface it rather than
 *  let it break silently. A non-existent NON-script token (a bare command, a
 *  relative path) is still left alone, mirroring healShippedToken's conservatism. */
export function findShippedTokenIssues(cmd: string): ShippedTokenIssue[] {
  const issues: ShippedTokenIssue[] = [];
  for (const token of cmd.split(/\s+/)) {
    if (isShippedRef(token)) {
      if (!resolveShippedRefToken(token)) issues.push({ kind: "unresolvable_ref", token });
      continue;
    }
    if (existsSync(token)) continue; // present path — healing would (or already did) handle it
    const ref = shippedRefCandidate(token);
    if (ref && resolveShippedRefToken(ref)) {
      issues.push({ kind: "stale_path", token });
      continue;
    }
    if (looksLikeScriptPath(token)) issues.push({ kind: "missing_script", token });
  }
  return issues;
}
