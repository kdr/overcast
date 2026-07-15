// Overcast home-directory resolution — extracted into a dependency-free module so
// the provider-manifest scanner (src/providers/manifests.ts) can resolve the
// installed-package root without importing profile.ts (which imports
// shipped-ref.ts, which the manifest layer also touches — the extraction breaks
// that cycle). profile.ts re-exports these for backward compatibility.

import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_ENV = "OVERCAST_HOME";

export interface HomeOptions {
  home?: string;
  profile?: string;
}

/** Resolve the overcast home directory (where profiles + installed provider
 *  packages live). Precedence: explicit --home > $OVERCAST_HOME > ~/.overcast.
 *  Spawn-time callers pass no opts, so `cli.ts` exports $OVERCAST_HOME from
 *  --home before dispatch to keep this in agreement with ctx.home. */
export function resolveHome(opts: HomeOptions = {}): string {
  if (opts.home) return opts.home;
  if (process.env[HOME_ENV]) return process.env[HOME_ENV] as string;
  return join(homedir(), ".overcast");
}

export function profilesDir(home: string): string {
  return join(home, "profiles");
}

export function profilePath(home: string, name: string): string {
  return join(profilesDir(home), `${name}.json`);
}
