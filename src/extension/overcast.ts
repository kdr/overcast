// The overcast pi extension (CLAUDE.md invariant #1: attach as a pi package, do
// not fork pi). At load it: registers the theme + banner header, registers
// Cloudglue as a pickable brain provider, injects the system prompt, and
// registers every verb in the registry as a pi tool. Keep all pi touch-points
// isolated here + in registry/to-agent-tool.ts so a pi bump has a small radius.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { VERBS } from "../registry/verbs.js";
import { toAgentTool } from "../registry/to-agent-tool.js";
import { openCase } from "../case.js";
import { loadProfile, resolveCloudglue, resolveHome } from "../profile.js";
import { buildSystemPrompt } from "./system-prompt.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Built file lives at dist/extension/overcast.js → package root is two up,
// where themes/ and assets/ are shipped (package.json "files").
const PKG_ROOT = resolve(HERE, "..", "..");
const THEME_PATH = resolve(PKG_ROOT, "themes", "overcast.json");
const BANNER_PATH = resolve(PKG_ROOT, "assets", "banner.txt");
const THEME_NAME = "overcast";

export default async function overcastExtension(pi: ExtensionAPI): Promise<void> {
  // Read the banner once; captured by the setHeader factory.
  let banner = "";
  try {
    banner = readFileSync(BANNER_PATH, "utf8");
  } catch {
    banner = "";
  }

  // --- Theme: announce the file on discovery, activate by name on start. ----
  pi.on("resources_discover", () => {
    return { themePaths: [THEME_PATH] };
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setTheme(THEME_NAME);
    if (banner) {
      ctx.ui.setHeader((_tui: TUI, _theme): Component => new Text(banner));
    }
  });

  // --- Cloudglue brain provider (anthropic-messages); never forced. ---------
  const { baseUrl } = resolveCloudglue();
  pi.registerProvider("cloudglue", {
    name: "Cloudglue",
    baseUrl,
    apiKey: "$CLOUDGLUE_API_KEY",
    api: "anthropic-messages",
    models: [
      {
        id: "tinycloud:advanced",
        name: "TinyCloud Advanced",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
    ],
  });

  // --- System prompt (persona + verb cheatsheet). --------------------------
  const systemPrompt = buildSystemPrompt();
  pi.on("before_agent_start", () => ({ systemPrompt }));

  // --- Register every verb as a pi tool, bound to the session case + profile.
  // The launcher surfaces --case/--profile/--home via env so the agent tools
  // operate on the same case/profile/home the CLI session was started with.
  const deps = {
    getCase: () => openCase(process.env.OVERCAST_CASE || process.cwd()),
    getProfile: () => loadProfile({ profile: process.env.OVERCAST_PROFILE || undefined }),
    getHome: () => resolveHome(),
    getProfileName: () => process.env.OVERCAST_PROFILE || "default",
  };
  for (const spec of VERBS) {
    pi.registerTool(toAgentTool(spec, deps));
  }
}
