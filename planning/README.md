# overcast — planning

> Start here. This folder is the design spec for **overcast**. Point coding
> agents at it when implementation begins. Nothing here is code; it is the
> contract the code must satisfy.

## What overcast is

A portable toolkit that gives any agent **senses** (video / audio / image
understanding) and **OSINT reach** (search, capture, monitor), wired together
around an investigation **case**. It ships three ways: a **pi package** that
turns a vanilla [pi](https://github.com/earendil-works/pi) agent into overcast,
a standalone **CLI binary**, and **agent skills** that teach any harness
(Claude Code, Codex, Cowork) to drive the CLI. Built as a proof-of-concept
agent for **video-understanding-enabled OSINT** to support a DEF CON talk, and
as a reusable kit afterward.

It is modeled on **tinycloud** (which is itself a pi app) and uses tinycloud as
the **default provider** for the perception verbs.

## Core requirements

1. **BYO LLM.** The orchestrator brain is pi's unified provider layer
   (`pi-ai`): Anthropic, OpenAI, Google, xAI, Groq, OpenRouter, self-hosted,
   etc., with mid-session switching. overcast does **not** hardcode a provider
   (the deliberate divergence from tinycloud). **Cloudglue** is additionally
   registered as a pickable provider (anthropic-messages API, like tinycloud) so
   `/model` offers a turnkey option — never forced.
2. **Senses** (provider-backed verbs): `watch`, `listen`, `see`, `enhance`;
   plus a lightweight **`view`** (scrubbable player/timeline for video/audio,
   optional spectrogram; OS-open for other files).
3. **OSINT** (verbs over sources + target): `scan`, `capture`, `monitor`.
   Optional **`prebrief`** wizard sets up a case (target, sources, providers,
   tinycloud collection) — never a prerequisite.
4. **Loose, indexable record** as the output contract — not a rigid envelope.
   See [01-architecture](01-architecture.md#the-record).
5. **Case = a folder of pi sessions.** No bespoke case object; reuse pi's
   per-directory session model + a `.overcast/` store.
6. **Pluggable providers** in three classes — **sense**, **source** (scrapers),
   and **memory** (`write`/`recall`; multi-provider = A-spec, local ships first =
   B-first) — saved in a **profile**. Three transports: `exec` (bash/CLI, the
   default), `http`, `in-proc` (TS/Python SDK). Default sense binding = tinycloud.
   tinycloud is always called via its **public CLI verbs**, never internal libs.
7. **MCP client first.** overcast can **install and call** MCP servers
   (`overcast mcp install/add/call …`), which become agent tools (and optionally
   `sources`) via a pi **extension** bridge (lazy/selective), since pi has no
   built-in MCP. Exposing overcast *as* an MCP server (`mcp serve`) is a
   secondary convenience.
8. **Distribution without a CDN:** publish to npm directly (pi-package + a
   `bun build --compile` binary). No launcher/CDN dance. The **Claude Code
   marketplace plugin** is a priority surface (mirror tinycloud's
   `.claude-plugin/`).
9. **Hacker TUI:** neon-green + amber theme, ANSI-shadow `OVERCAST` wordmark
   with a play/monitor glyph. Assets drafted (`overcast-theme.json`,
   `overcast-banner.txt`).
10. **YOLO** execution for v1 (pi's default; no permission system). Isolation
    is a later conversation.

## Non-goals (v1)

- No CDN binary launcher (tinycloud's two-repo model). Single open repo.
- No custom agent loop / TUI / session format — use pi as-is.
- No permission system or sandbox (documented recommendation only).
- No sub-agents / plan mode / background bash baked in (pi philosophy: files +
  tmux + spawn-pi-via-bash).

## Pinned versions (base the design on these)

- `@earendil-works/pi-ai`, `pi-agent-core`, `pi-tui`, `pi-coding-agent` —
  **exactly `0.79.10`** (current `latest`, 2026-06-22). Treat bumps as reviewed
  changes.
- `@cloudglue/cloudglue-js` — latest stable at implementation time.
- `ffmpeg-static`, `ffprobe-static` — vendored, like tinycloud.

## Reading order

1. [01-architecture.md](01-architecture.md) — layers, stack, data model,
   provider transports, the record contract.
2. [02-cli-reference.md](02-cli-reference.md) — full man pages for every verb +
   slash command + global flags.
3. [05-providers.md](05-providers.md) — provider contract; default tinycloud
   behavior (v1); **source** providers (scrapers) and **memory** providers; and
   sample bash/TS/Python providers + registration.
4. [03-distribution.md](03-distribution.md) — pi-package, skills, Claude plugin
   & marketplace, MCP, bun binary, npm, versioning.
5. [04-implementation-plan.md](04-implementation-plan.md) — repo layout, phased
   plan with acceptance criteria, **where to start**.
6. [06-dev-workflow.md](06-dev-workflow.md) — autonomous build runbook (stacked
   Graphite PRs, real-code unit tests, additive e2e suite, time-box). This is
   what the Claude Code `/goal` condition points at.
7. [`/CLAUDE.md`](../CLAUDE.md) — agent guidance + invariants (repo root).

## Where to start (pointer for implementers)

Begin at **Phase 0 → Phase 1** in
[04-implementation-plan.md](04-implementation-plan.md#phase-0--scaffold). The
first vertical slice to prove the architecture: a pi-package extension that
loads the theme + branding, establishes a case (folder), and registers a single
working `watch` tool that emits a record via the tinycloud exec provider. Once
that round-trips end to end, fan out to the other verbs.

## Open questions (resolve as they come up, don't block on them)

- `monitor` as its own verb vs `scan --loop` (currently: own verb, sugar over
  the loop).
- `scan` returning hits to `capture` explicitly vs `scan --pull` auto-pulling
  (currently: support both).
- Whether the bun binary is required for the talk or pi-package + skills suffice
  for the demo.
