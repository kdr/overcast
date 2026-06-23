# CLAUDE.md

Guidance for Claude Code / pi / Codex / any agent working in this repo.
**The full design lives in [`planning/`](planning/README.md) — read it before
implementing.** This file is the quick map + the invariants you must not break.

## What this repo is

**overcast** — a portable toolkit that gives an agent *senses* (video/audio/
image understanding) and *OSINT reach* (search/capture/monitor), organized
around an investigation **case**. It is a proof-of-concept video-understanding
OSINT agent for a DEF CON talk, and a reusable kit. It is built **on top of
[pi](https://github.com/earendil-works/pi)** (the agent harness that also powers
tinycloud) and uses **tinycloud** as the default perception backend.

overcast ships as: a **pi package** (extension + skills + prompts + theme), a
**standalone bun binary**, and **agent skills** (drive the CLI from any harness).
It is also an **MCP client** — it installs and calls MCP servers
(`overcast mcp …`), which become agent tools (and optionally `sources`); serving
overcast *as* MCP is a secondary option. See [`planning/03-distribution.md`](planning/03-distribution.md).

## Stack (pinned)

- `@earendil-works/pi-ai`, `pi-agent-core`, `pi-tui`, `pi-coding-agent` —
  **exactly `0.79.10`** (current `latest`, 2026-06-22). Do not float these;
  treat upgrades as reviewed changes.
- `@cloudglue/cloudglue-js` (default sense provider, via the tinycloud CLI/exec).
  Cloudglue is **also** registered as a pickable *brain* LLM provider
  (anthropic-messages API) so it appears in `/model` — never forced.
- `ffmpeg-static` + `ffprobe-static` (internal media toolkit; vendored).
- TypeScript / ESM / Node ≥22; `tsup` (dev) + `bun build --compile` (binary).

## Invariants (do not violate)

1. **Don't fork pi.** Reuse pi's loop, TUI, sessions, base tools
   (`read/write/edit/bash/grep/find/ls`), provider layer. overcast attaches as a
   pi **package/extension** — net-new code is Layer 2 (verbs) + Layer 3
   (providers) + the record store + MCP bridge. ([architecture](planning/01-architecture.md))
2. **BYO LLM.** Never hardcode the brain provider (this is the deliberate
   divergence from tinycloud). Keep *brain provider* (pi-ai) and *sense
   providers* (tinycloud/whisper/VLM) separate everywhere.
3. **The record is loose.** Output contract = `{ id, verb, format(json|md|txt),
   payload, media?{ref,at}, meta?, error?, state? }` and nothing more. Do not
   reintroduce tinycloud's rigid envelope; map provider output to the record at
   the exec boundary. `state`/`error` are the only (optional) control fields;
   consumers treat missing `state` as `ready`. ([record](planning/01-architecture.md#4-the-record-output-contract))
4. **Case = a folder.** No bespoke case object — a case is a directory with a
   `.overcast/` store; pi's per-directory sessions are the case history. Switch
   cases by `cd` / `--case`. ([case](planning/01-architecture.md#5-case--a-folder-of-sessions))
5. **One verb spec → three surfaces.** Declare each verb once in
   `src/registry/verbs.ts`; generate the CLI subcommand, the pi AgentTool, and
   the skill doc from it. `overcast commands --json` is the source of truth —
   verify docs against it, not memory.
6. **Providers are pluggable.** Three provider classes share one machinery —
   **sense** (`watch/listen/see/enhance`), **source** (scrapers; `youtube`,
   `tiktok`), and **memory** (`write`/`recall`; multi-provider = A-spec, local
   ships first = B-first). Binding lives in the profile; transports are `exec`
   (default), `http`, `in-proc`. Default sense binding = tinycloud (exec).
   ([providers](planning/01-architecture.md#8-provider-abstraction),
   [memory](planning/05-providers.md#memory-providers))
7. **ffmpeg is internal**, not a user-configurable provider. `enhance` and frame
   extraction use it.
8. **No CDN.** Publish to npm directly (pi-package + bun binary). No launcher
   download dance.
9. **YOLO for v1.** No permission system / sandbox (pi default). Document the
   prompt-injection risk; don't build guardrails yet.
10. **MCP client first.** overcast installs/calls MCP servers (`overcast mcp …`)
    via the extension bridge (lazy/selective); installed servers persist in the
    profile and can register as `sources`. `mcp serve` is secondary.
    ([mcp](planning/01-architecture.md#9-mcp--overcast-is-an-mcp-client-first))
11. **tinycloud = public verbs only.** Call tinycloud through its CLI verbs
    (`watch/listen-equiv/search/probe/ask/library/…`, verified via `tinycloud
    commands --json`) — never import or call its internal libs. Map verb output
    to the loose record at the exec boundary.

## Verb set (the whole surface)

Senses: `watch` `listen` `see` `enhance`. Inspect: `view`. OSINT: `scan`
`capture` `monitor`. Read: `ask` `brief`. State/config: `target` `source`
`setup`/`profile` `case` `prebrief` (case wizard) `mcp`. Base (from pi, don't
reimplement): `read` `write` `edit` `bash` `grep` `find` `ls`. Full man pages:
[`planning/02-cli-reference.md`](planning/02-cli-reference.md). Default
tinycloud provider behavior + sample providers:
[`planning/05-providers.md`](planning/05-providers.md).

v1 sense notes: `watch` = shot-detection + all-modalities describe →
`content`/`transcript`/`detailed`; `listen` = speech-only describe; `see` =
**placeholder** (no tinycloud impl, bind your own). `enhance`/`view` use the
internal ffmpeg toolkit.

Slash commands (TUI): `/target` `/source` `/setup` `/case` `/prebrief` `/view`
`/mcp` (extension commands), `/ask` `/brief` (prompt templates), plus pi
built-ins (`/model` `/tree` `/session` `/resume`).

## Commands (once scaffolded)

```bash
npm run build            # tsup (dev/library build)
npm run typecheck        # tsc --noEmit
npm test                 # unit + e2e (offline; fixture provider)
npm run build:bun        # bun build --compile → dist/bin/overcast
overcast commands --json # dump the verb registry (authoritative)
overcast doctor          # preflight: pi, providers, creds, ffmpeg
```

## Where to start

[`planning/04-implementation-plan.md`](planning/04-implementation-plan.md) →
Phase 0 then Phase 1. The Phase 1 vertical slice (pi extension + theme + case +
a single working `watch` via the tinycloud exec provider, emitting a record)
proves the architecture end to end before fanning out.

## Verifying changes

Ground claims in reality: for provider/record changes, run a verb against a
fixture and inspect the emitted record JSONL. For skill/doc changes, check
against `overcast commands --json`. For TUI/theme, launch `overcast` and eyeball
the banner + colors. Keep pi touch-points isolated in `src/extension/` and
`src/registry/to-agent-tool.ts` so a pi bump has a small blast radius.
