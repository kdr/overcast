// Version surface for overcast. The pinned pi version is an invariant
// (CLAUDE.md): @earendil-works/pi-* are pinned at exactly 0.80.1.

export const OVERCAST_VERSION = "0.0.6";

/** The exact pi version overcast is built against (pinned, not floated). */
export const PI_VERSION = "0.80.1";

export interface VersionInfo {
  overcast: string;
  pi: string;
  node: string;
}

export function versionInfo(): VersionInfo {
  return {
    overcast: OVERCAST_VERSION,
    pi: PI_VERSION,
    node: process.versions.node,
  };
}
