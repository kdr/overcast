# 06 — Autonomous build runbook

The procedure an agent follows to implement overcast. Designed to be driven by
Claude Code's built-in **`/goal`** (the completion condition references this
file). Read `./CLAUDE.md` and `./planning/README.md` first — they hold the
invariants and override anything you remember.

## Read the spec before coding

In order: `CLAUDE.md` → `planning/README.md` → `01-architecture.md` →
`02-cli-reference.md` → `05-providers.md` → `03-distribution.md` →
`04-implementation-plan.md` (the **phase plan you execute**; phases = PR
boundaries).

**Context repos (READ-ONLY, patterns only — never depend on them at runtime):**
- `/Users/kdr/dev/github/makeyolo/tinycloud` — tinycloud SOURCE (a pi app):
  mirror how it builds the pi extension, tools, TUI/branding, profiles/home,
  ffmpeg tool, and maps provider output → record. **Invariant: call tinycloud
  only via its public CLI verbs (`tinycloud commands --json`); never import/call
  its internal libs.**
- `/Users/kdr/dev/github/cloudglue/tinycloud` — tinycloud public DIST: reference
  for `skills/`, `.claude-plugin/` (plugin.json + marketplace.json), the
  installer/launcher, and the public verb surface.
- `/Users/kdr/dev/github/autonomous-video-hunter` — prior art for video-OSINT
  (`face_matcher.py`, `image_matcher.py`, `zeroshot_detect.py`); reference for
  FUTURE extract/face/target work, not v1.
- pi upstream: https://github.com/earendil-works/pi (`packages/coding-agent/docs/`).
  Pin `@earendil-works/pi-*` at **exactly 0.79.10**.

## Preflight (once)

- `cd /Users/kdr/dev/github/overcast`; confirm clean git state and that `gt`
  (Graphite) works (`gt --version`, `gt log`).
- **LLM = Cloudglue.** Read the key from `~/.tinycloud/config.json`
  (`services.cloudglue` or `apiKeys.cloudglue`); `export CLOUDGLUE_API_KEY=…` and
  configure overcast's brain provider as Cloudglue (anthropic-messages API,
  Cloudglue endpoint) so `/model` can use it.
- **Test media** is in `~/test-video/`. List it; pick the **smallest** clips for
  smoke tests to control time + Cloudglue cost.
- Ensure `./.dev/` is git-ignored; use it for all run artifacts. Maintain
  `./.dev/STATUS.md` (current state + resume command) and `./.dev/devlog.md`.
- If a prerequisite is missing (no `gt`, no creds, no test videos, pi 0.79.10
  unavailable): record it in `./.dev/STATUS.md`, do what's possible offline
  (fixture-provider unit tests), and pause for the human — don't guess.

## Per-phase loop — ONE phase = ONE stacked branch

For each phase in `planning/04-implementation-plan.md`:

1. **Branch** — `gt create` a branch stacked on the previous phase's branch
   (`phase-N-<slug>`). Phases stack; never squash them together.
2. **Implement** that phase's deliverables per the plan + man pages, honoring
   every `CLAUDE.md` invariant.
3. **Unit tests — real code, NO behavior mocking.** Exercise the actual modules
   (record store, verb registry, provider resolve/exec transport, ffmpeg toolkit
   against a real tiny video). Fakes only at true external boundaries (a real
   fixture provider script, a fixture source) — never mock overcast's own logic.
   Unit tests must run **offline**.
4. **Extend the e2e suite (committed runnable scripts).** The suite lives at
   `test/e2e/` — an entrypoint (e.g. `test/e2e/run.sh [phase]`) that runs the
   full cumulative set, plus per-verb/per-phase case scripts. Each phase ADDS
   cases. It checks CLI-observable behavior two ways:
   - overcast CLI verbs with `--json` (e.g. `overcast watch <clip> --json`),
     parsed + asserted; and
   - **overcast in AGENT MODE, headless + JSON** (pi headless: `overcast -p
     "<task>" --mode json` / equivalent) to inspect what the agent emits —
     overcast's own headless JSON, not Claude Code's.
   Use real clips from `~/test-video` + the Cloudglue LLM; keep cloud calls small.
5. **Each run is timestamped + reported (uncommitted).** `run.sh` creates a fresh
   `./.dev/smoke/<UTC-timestamp>/` per run (never overwrite) containing every
   case's raw JSON **and** a generated `report.md` with: timestamp + phase + git
   SHA, **what was tested** (cases/commands), **results** (per-case pass/fail +
   key assertions), and a **summary** (counts, failures, observations). Only the
   `test/e2e/` scripts are committed; `./.dev/smoke/*` stays uncommitted.
6. **Review** — run `/review` on the branch diff; for phases touching
   capture/scrape, provider exec, or MCP also `/security-review`. Address
   findings; re-run unit + e2e until green.
7. **Submit** — commit via gt, `gt submit` the stacked PR, verify with `gt log`.
   Update `./.dev/STATUS.md` + `./.dev/devlog.md`. Commit frequently within a
   phase for recovery points. Then start the next phase, stacked on top.

## Testing philosophy (hard rules)

- Real library code, not behavior mocking. Unit tests offline; e2e may hit
  Cloudglue + real video (costs credits — keep small/few).
- The e2e suite is **append-only**: every phase keeps all prior cases green plus
  its new ones.
- `overcast commands --json` is the source of truth for the verb surface — assert
  against it, not memory.

## Time-box + stop conditions

- Default budget **6 hours**. `date` at start; check elapsed before each phase.
- At ~90% of budget: STOP new work — stabilize the current branch (all tests
  green), `gt submit` the stack, finalize `./.dev/STATUS.md` (phases done, PRs in
  stack, what's next, and the exact resume condition).
- Stop early if: budget hit, all phases complete, or blocked needing a human.
  Document and pause — never hack around an invariant. Prefer fewer fully-green,
  reviewed phases over many half-done ones.

## Definition of done (what `/goal` evaluates)

You are done when — having either completed all phases **or** reached the time
budget — **all** of the following hold and are shown in your output:
1. the Graphite stack is submitted (`gt log` shows the phase branches/PRs),
2. all unit tests and the full `test/e2e` suite pass (paste the passing run),
3. each completed phase had a `/review` round, and
4. `./.dev/STATUS.md` is finalized with the resume command.

## Resuming

Re-run the goal; the runbook + `./.dev/STATUS.md` tell you the next phase. Start
a new stacked branch from there.
