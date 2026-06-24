// The overcast pi extension (CLAUDE.md invariant #1: attach as a pi package, do
// not fork pi). At load it: registers the theme + banner header, registers
// Cloudglue as a pickable brain provider, injects the system prompt, and
// registers every verb in the registry as a pi tool. Keep all pi touch-points
// isolated here + in registry/to-agent-tool.ts so a pi bump has a small radius.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { VERBS } from "../registry/verbs.js";
import { toAgentTool } from "../registry/to-agent-tool.js";
import { openCase } from "../case.js";
import { loadProfile, resolveCloudglue, resolveHome } from "../profile.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { colorizeBanner, statusLine, headerText, OvercastFooter } from "./branding.js";
import { registerSlashCommands } from "./slash.js";

const PROMPTS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

/** First existing agent-context file in the cwd, for the status line. */
function contextFileLabel(cwd: string): string {
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    if (existsSync(join(cwd, f))) return `${f} loaded`;
  }
  return "";
}

const CLOUDGLUE_MODEL_ID = "tinycloud:advanced";

const HERE = dirname(fileURLToPath(import.meta.url));
// Built file lives at dist/extension/overcast.js → package root is two up,
// where themes/ and assets/ are shipped (package.json "files").
const PKG_ROOT = resolve(HERE, "..", "..");
const THEME_PATH = resolve(PKG_ROOT, "themes", "overcast.json");
const BANNER_PATH = resolve(PKG_ROOT, "assets", "banner.txt");
const THEME_NAME = "overcast";

export default async function overcastExtension(pi: ExtensionAPI): Promise<void> {
  // Read the banner once; captured by the setHeader factory. Colorize it to the
  // overcast theme (raw ASCII would render terminal-default white).
  let banner = "";
  try {
    banner = colorizeBanner(readFileSync(BANNER_PATH, "utf8"));
  } catch {
    banner = "";
  }

  // Resolve the Cloudglue config once (env or ~/.tinycloud/config.json).
  const { baseUrl, apiKey: cgKey } = resolveCloudglue();

  // --- Theme: announce the file on discovery, activate by name on start. ----
  pi.on("resources_discover", () => {
    // theme + the /ask,/brief prompt templates (prompts/*.md)
    return { themePaths: [THEME_PATH], promptPaths: [PROMPTS_PATH] };
  });

  // state verbs as TUI slash commands (/target /source /case /prebrief /view /setup)
  registerSlashCommands(pi);

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setTheme(THEME_NAME);

    const cwd = ctx.cwd ?? process.cwd();
    const caseName = basename(cwd);

    // Title: "overcast — <profile>@case://<folder>" (the case is the cwd folder;
    // the profile is the active persona, e.g. `recon`). Overrides pi's
    // "<app> - <session> - <cwd>" so the tab reads cleanly.
    const activeProfile = loadProfile({ profile: process.env.OVERCAST_PROFILE || undefined });
    const profileName = activeProfile.name ?? "default";
    ctx.ui.setTitle(`overcast — ${profileName}@case://${caseName}`);

    // Header: colorized banner + a status line (context file · verbs · model).
    // Respect an explicit `setup llm` choice in the status label too.
    const llmLabel = activeProfile.llm?.model || activeProfile.llm?.provider;
    const modelLabel = llmLabel
      ? `model: ${llmLabel}`
      : cgKey
        ? `model: ${CLOUDGLUE_MODEL_ID}`
        : "model: (set via /model)";
    if (banner) {
      const status = statusLine([
        contextFileLabel(cwd),
        `${VERBS.length} tools`,
        modelLabel,
      ]);
      const header = headerText(banner, status);
      ctx.ui.setHeader((_tui: TUI, _theme): Component => new Text(header));
    }

    // Minimal footer: case · tokens · ctx% · model · thinking.
    ctx.ui.setFooter((_tui, _theme, _data): Component => {
      return new OvercastFooter(() => {
        const usage = ctx.getContextUsage?.();
        return {
          caseName,
          tokens: usage?.tokens ?? null,
          ctxPercent: usage?.percent ?? null,
          model: ctx.model?.id ?? CLOUDGLUE_MODEL_ID,
          thinking: pi.getThinkingLevel?.() ?? "medium",
        };
      });
    });
    // Turnkey: when a Cloudglue key is available AND the user hasn't pinned
    // their own brain (`setup llm`), make Cloudglue the active model so overcast
    // works out of the box. An explicit profile llm is always respected; this is
    // still overridable via /model — never hardcoded over a user's choice.
    if (cgKey && !activeProfile.llm) {
      try {
        await pi.setModel({
          id: CLOUDGLUE_MODEL_ID,
          name: "TinyCloud Advanced",
          api: "anthropic-messages",
          provider: "cloudglue",
          baseUrl,
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000000,
          maxTokens: 32000,
        } as Parameters<typeof pi.setModel>[0]);
      } catch {
        /* best-effort; user can still /model */
      }
    }
  });

  // --- Cloudglue brain provider (anthropic-messages); never forced. ---------
  // Pass the resolved key literally when we have one (env or tinycloud config)
  // so models are available without a /login dance; fall back to the env ref.
  pi.registerProvider("cloudglue", {
    name: "Cloudglue",
    baseUrl,
    apiKey: cgKey ?? "$CLOUDGLUE_API_KEY",
    api: "anthropic-messages",
    models: [
      {
        id: CLOUDGLUE_MODEL_ID,
        name: "TinyCloud Advanced",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 32000,
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
