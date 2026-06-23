// Profile = how you work (LLM brain + per-verb provider bindings), global and
// reusable across cases. Lives in ~/.overcast/ (override via --home /
// $OVERCAST_HOME). Resolution precedence mirrors tinycloud:
//   --home > --profile > $OVERCAST_HOME > default profile > ~/.overcast
//
// BYO LLM invariant (CLAUDE.md #2): the brain provider is never hardcoded. We
// keep brain provider (pi-ai) and sense providers (tinycloud/...) separate.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_ENV = "OVERCAST_HOME";

/** A provider binding descriptor (per verb or source). Loose by design. */
export interface ProviderDescriptor {
  type: "exec" | "http" | "inproc";
  /** exec: command template, e.g. "tinycloud watch {{input}} --json" */
  run?: string;
  /** init step: a shell command or a skill reference */
  init?: string | { skill?: string; command?: string; ensure?: boolean };
  describe?: string;
  /** http transport */
  endpoint?: string;
  /** inproc transport */
  module?: string;
}

export interface Profile {
  name: string;
  /** brain LLM (pi-ai). Never forced; cloudglue is one pickable option. */
  llm?: { provider?: string; model?: string };
  /** per-verb sense-provider bindings */
  providers?: Record<string, ProviderDescriptor>;
  /** memory provider specs (local always implicit) */
  memory?: ProviderDescriptor[];
  /** MCP server configs */
  mcp?: unknown[];
  preferences?: Record<string, unknown>;
}

export interface HomeOptions {
  home?: string;
  profile?: string;
}

/** Resolve the overcast home directory (where profiles live). */
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

/** The built-in default profile: tinycloud exec binding for watch, BYO brain. */
export function defaultProfile(name = "default"): Profile {
  return {
    name,
    // brain LLM left unset → BYO. Cloudglue is registered as a pickable option
    // by the extension but never forced here.
    providers: {
      watch: {
        type: "exec",
        run: "tinycloud watch {{input}} --json",
        init: { skill: "tinycloud-init", ensure: true },
        describe: "tinycloud commands --json",
      },
    },
  };
}

/** Load a profile by name; falls back to the built-in default if missing. */
export function loadProfile(opts: HomeOptions = {}): Profile {
  const home = resolveHome(opts);
  const name = opts.profile ?? "default";
  const path = profilePath(home, name);
  if (existsSync(path)) {
    const p = JSON.parse(readFileSync(path, "utf8")) as Profile;
    p.name = p.name ?? name;
    return p;
  }
  return defaultProfile(name);
}

/** Persist a profile to the home store (creates dirs). */
export function saveProfile(profile: Profile, opts: HomeOptions = {}): string {
  const home = resolveHome(opts);
  mkdirSync(profilesDir(home), { recursive: true });
  const path = profilePath(home, profile.name);
  writeFileSync(path, JSON.stringify(profile, null, 2) + "\n", "utf8");
  return path;
}

// --- Cloudglue (brain provider) credential resolution ------------------------

export interface CloudglueConfig {
  apiKey?: string;
  baseUrl: string;
}

/**
 * Resolve the Cloudglue config for the brain provider. Key precedence:
 *   $CLOUDGLUE_API_KEY > ~/.tinycloud/config.json (services/apiKeys.cloudglue).
 * baseUrl: $CLOUDGLUE_BASE_URL || https://api.cloudglue.dev (strip trailing /v1).
 */
export function resolveCloudglue(): CloudglueConfig {
  let apiKey = process.env.CLOUDGLUE_API_KEY;
  if (!apiKey) {
    apiKey = readTinycloudKey();
  }
  const rawBase =
    process.env.CLOUDGLUE_BASE_URL || "https://api.cloudglue.dev";
  const baseUrl = rawBase.replace(/\/v1\/?$/, "");
  return { apiKey, baseUrl };
}

/** Best-effort read of the Cloudglue key from the tinycloud CLI config. */
export function readTinycloudKey(): string | undefined {
  try {
    const cfgPath = join(homedir(), ".tinycloud", "config.json");
    if (!existsSync(cfgPath)) return undefined;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      services?: { cloudglue?: string };
      apiKeys?: { cloudglue?: string };
    };
    return cfg.services?.cloudglue ?? cfg.apiKeys?.cloudglue;
  } catch {
    return undefined;
  }
}
