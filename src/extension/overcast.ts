// The overcast pi extension (CLAUDE.md invariant #1: attach as a pi package, do
// not fork pi). At load it: registers the theme + banner header, registers
// Cloudglue as a pickable brain provider, injects the system prompt, and
// registers every verb in the registry as a pi tool. Keep all pi touch-points
// isolated here + in registry/to-agent-tool.ts so a pi bump has a small radius.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { VERBS } from "../registry/verbs.js";
import { toAgentTool } from "../registry/to-agent-tool.js";
import { openCase } from "../case.js";
import { loadProfile, resolveCloudglue, resolveHome } from "../profile.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { OvercastHeader, OvercastFooter, workingIndicator, opLabel, idleLabel } from "./branding.js";
import { registerSlashCommands } from "./slash.js";
import { OvercastEditor } from "./editor.js";
import { OVERCAST_VERSION } from "../version.js";

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

// pi's createTheme splits these color keys into the background map; everything
// else is a foreground color.
const BG_COLOR_KEYS = new Set([
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
]);

/**
 * Build the overcast theme as an inline `Theme` object from themes/overcast.json,
 * mirroring pi's own `createTheme` (var-ref resolution + bg/fg key split). We
 * apply it via `setTheme(theme)` instead of `setTheme("overcast")` because the
 * name lookup depends on pi's resource discovery, which registers the theme
 * AFTER `session_start` fires — so the name-based call silently failed and pi
 * kept its default theme (cyan code, gray message bg). The object form has no
 * such dependency (and also works in a compiled binary, where the file isn't on
 * a real filesystem — falls back to undefined → name-based attempt).
 */
function buildOvercastTheme(): Theme | undefined {
  try {
    const json = JSON.parse(readFileSync(THEME_PATH, "utf8")) as {
      name?: string;
      vars?: Record<string, string | number>;
      colors: Record<string, string | number>;
    };
    const vars = json.vars ?? {};
    const resolveRef = (v: string | number, seen = new Set<string>()): string | number => {
      if (typeof v === "string" && v in vars && !seen.has(v)) {
        seen.add(v);
        return resolveRef(vars[v], seen);
      }
      return v;
    };
    const fg: Record<string, string | number> = {};
    const bg: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(json.colors)) {
      (BG_COLOR_KEYS.has(k) ? bg : fg)[k] = resolveRef(v);
    }
    return new Theme(fg as never, bg as never, "truecolor", { name: json.name ?? THEME_NAME });
  } catch {
    return undefined;
  }
}

/** The terminal/tab title: "overcast — <profile>@case://<case-folder>". pi's own
 *  updateTerminalTitle() resets the title to "<app> - <cwd>" on session bind, so
 *  we re-apply this on each turn (below) to keep it. */
function desiredTitle(): string {
  const cwd = process.env.OVERCAST_CASE || process.cwd();
  const profileName = loadProfile({ profile: process.env.OVERCAST_PROFILE || undefined }).name ?? "default";
  return `overcast — ${profileName}@case://${basename(cwd)}`;
}

export default async function overcastExtension(pi: ExtensionAPI): Promise<void> {
  // Read the raw banner once; captured by the setHeader factory. OvercastHeader
  // colorizes + animates it (raw ASCII would render terminal-default white).
  let bannerRaw = "";
  try {
    bannerRaw = readFileSync(BANNER_PATH, "utf8");
  } catch {
    bannerRaw = "";
  }

  // Resolve the Cloudglue config once (env or ~/.tinycloud/config.json).
  const { baseUrl, apiKey: cgKey } = resolveCloudglue();

  // --- Theme: register the file for discovery, but activate it as an inline
  // object (the name-based path registers too late — see buildOvercastTheme). --
  const overcastTheme = buildOvercastTheme();
  pi.on("resources_discover", () => {
    // theme + the /ask,/brief prompt templates (prompts/*.md)
    return { themePaths: [THEME_PATH], promptPaths: [PROMPTS_PATH] };
  });

  // state verbs as TUI slash commands (/target /source /case /prebrief /view /setup)
  registerSlashCommands(pi);

  // Themed busy *label* ("verbs"): name the actual op while a verb runs
  // ("scanning sources…", "watching the footage…"), and a themed generic while
  // the agent reasons between tools — replacing pi's default "Working…". The
  // spinner *glyph* is set separately per-session (setWorkingIndicator).
  pi.on("agent_start", (_e, ctx) => ctx.ui?.setWorkingMessage?.(idleLabel()));
  pi.on("turn_start", (_e, ctx) => ctx.ui?.setWorkingMessage?.(idleLabel()));
  pi.on("tool_execution_start", (e, ctx) => ctx.ui?.setWorkingMessage?.(opLabel(e.toolName)));
  pi.on("tool_execution_end", (_e, ctx) => ctx.ui?.setWorkingMessage?.(idleLabel()));
  pi.on("agent_end", (_e, ctx) => ctx.ui?.setWorkingMessage?.(undefined));

  pi.on("session_start", async (_event, ctx) => {
    // apply the inline Theme object; fall back to the registered name if the
    // file couldn't be read (e.g. an unexpected packaging layout).
    const applied = overcastTheme ? ctx.ui.setTheme(overcastTheme) : undefined;
    if (!applied?.success) ctx.ui.setTheme(THEME_NAME);

    // custom editor: yellow ❯ prompt + green block cursor (best-effort).
    try {
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new OvercastEditor(tui, theme, keybindings));
    } catch {
      /* keep pi's default editor if the API shape changed */
    }

    // the case dir follows --case (surfaced via OVERCAST_CASE), matching the
    // agent tools — so the UI labels the case actually being processed.
    const cwd = process.env.OVERCAST_CASE || ctx.cwd || process.cwd();
    const caseName = basename(cwd);

    // Title: "overcast — <profile>@case://<folder>" (the case is the cwd folder;
    // the profile is the active persona, e.g. `recon`). Overrides pi's
    // "<app> - <session> - <cwd>" so the tab reads cleanly.
    const activeProfile = loadProfile({ profile: process.env.OVERCAST_PROFILE || undefined });
    ctx.ui.setTitle(desiredTitle());
    // pi resets the terminal title to "<app> - <cwd>" on session bind (after this
    // handler) — re-apply ours just after the synchronous init settles.
    setTimeout(() => { try { ctx.ui.setTitle(desiredTitle()); } catch { /* ignore */ } }, 50);

    // Header: the animated recording-deck banner (gradient wordmark + REC HUD +
    // centered tagline + bracket status). Respect an explicit `setup llm` choice.
    const llmLabel = activeProfile.llm?.model || activeProfile.llm?.provider;
    const modelId = llmLabel || (cgKey ? CLOUDGLUE_MODEL_ID : "(set via /model)");
    if (bannerRaw) {
      const contextFile = contextFileLabel(cwd).replace(" loaded", "");
      ctx.ui.setHeader(
        (tui: TUI, _theme): Component =>
          new OvercastHeader(tui, {
            banner: bannerRaw,
            version: OVERCAST_VERSION,
            contextFile,
            tools: VERBS.length,
            model: modelId,
          }),
      );
    }

    // Themed "busy" spinner: a magenta/cyan scan-bar sweep instead of the default
    // braille dots (frames render verbatim, so we color them ourselves).
    try {
      ctx.ui.setWorkingIndicator?.(workingIndicator());
    } catch {
      /* keep pi's default spinner if the API shape changed */
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

  // Keep our terminal title: pi's updateTerminalTitle() resets it to "<app> - <cwd>"
  // on session bind, so re-assert "overcast — <profile>@case://<case>" each turn.
  const reapplyTitle = (_event: unknown, ctx: { ui: { setTitle(t: string): void } }) => {
    try { ctx.ui.setTitle(desiredTitle()); } catch { /* ignore */ }
  };
  pi.on("turn_start", reapplyTitle as never);
  pi.on("turn_end", reapplyTitle as never);

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
