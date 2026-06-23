# 04 — Implementation plan

Phased, vertical-slice-first. Each phase has **deliverables** and **acceptance**
(what must be demonstrably true to call it done). Build the thinnest end-to-end
path first (Phase 1), then fan out.

## Repo layout (target)

```
overcast/
  bin/
    overcast.ts              # CLI entry → dispatch verbs or launch pi
  src/
    extension/
      overcast.ts            # pi ExtensionAPI factory (registers everything)
      system-prompt.ts       # overcast persona + verb cheatsheet
      branding.ts            # ANSI banner component (pi-tui)
      mcp-bridge.ts          # consume MCP servers → registerTool (lazy)
    registry/
      verbs.ts               # the single verb spec registry (→ CLI/tool/skill)
      to-agent-tool.ts       # spec → pi AgentTool (split results)
      to-cli.ts              # spec → argv parser + --help
    record.ts                # Record type, validate, JSONL read/write
    case.ts                  # case = folder; .overcast/ store I/O
    profile.ts               # home, profiles, provider bindings
    providers/
      resolve.ts             # verb/source → provider; transport dispatch
      exec.ts  http.ts  inproc.ts
      tinycloud/             # default sense providers (watch/listen) + see placeholder
      sources/               # source providers (scrapers): youtube (yt-dlp), tiktok (apify)
      memory/                # memory providers: local (default), cloudglue (public tinycloud verbs)
    media/
      ffmpeg.ts              # internal toolkit (frames, transcode, enhance ops)
    verbs/
      watch.ts listen.ts see.ts enhance.ts view.ts
      scan.ts capture.ts monitor.ts ask.ts brief.ts
    state/
      target.ts source.ts memory.ts prebrief.ts
  skills/                    # thin: overcast (flagship) + overcast-init (see 03)
  prompts/                   # /ask, /brief markdown templates
  examples/providers/        # bash/ ts/ python/ sources/ — runnable samples (see 05)
  docs/providers.md          # end-user provider authoring (derived from planning/05)
  themes/overcast.json       # (from overcast-theme.json)
  assets/banner.txt          # (from overcast-banner.txt)
  scripts/ build-bun.ts package.sh setup-deps.sh
  test/ unit/ e2e/ fixtures/
  planning/                  # this folder
  CLAUDE.md  README.md  package.json  tsconfig.json  tsup.config.ts
  .claude-plugin/            # plugin.json + marketplace.json (see 03 §3b)
```

SDK packages (publish later): `@overcast/provider-sdk` (TS) and an
`overcast_sdk` Python package for `in-proc` provider authors.

---

## Phase 0 — Scaffold

**Deliverables:** repo init; `package.json` with pi pinned `0.79.10`; `tsup` +
`bun build` scaffolding; `CLAUDE.md`; theme + banner moved into `themes/` +
`assets/`; empty `src/` tree; CI skeleton (typecheck, test, shellcheck).

**Acceptance:** `npm run build` and `npm run typecheck` pass on an empty shell;
`overcast --version --json` prints version + pinned pi version.

## Phase 1 — Core runtime (the vertical slice)

**Deliverables:** the pi-package extension that applies theme + branding,
registers **Cloudglue as a pickable pi provider** (anthropic-messages, so it
shows in `/model`), loads a profile, opens a case (cwd `.overcast/`), defines the
`Record` type + JSONL store, and registers **one** working verb — `watch` — via
the tinycloud **exec** provider (the simplest bash-wrapper form, see
[05](05-providers.md#default-tinycloud-providers)). CLI form (`overcast watch
<f>`) and agent-tool form both work and write a record.

**Acceptance:** in a fresh dir, `overcast watch ./fixture.mp4 --json` emits a
valid `video.analysis` record and persists it to `.overcast/records/`; launching
`overcast` shows the green/amber TUI with the banner; the agent can call the
`watch` tool and cite the resulting record. **This proves the whole
architecture** — providers, record, case, dual surface.

## Phase 2 — Senses & view

**Deliverables:** `listen` (v1 tinycloud **speech-only** describe), `see` (v1
**placeholder** — no tinycloud impl; returns guidance until a provider is bound),
`enhance` (internal ffmpeg); flesh out `watch` v1 post-processing
(`content`/`transcript`/`detailed` from shot-detection + all-modalities describe,
[05](05-providers.md#default-tinycloud-providers)); internal ffmpeg toolkit
(frame extraction, transcode, deterministic enhance ops); frame references
(`frame://rec@sec`); split-result formatting. Plus `view` — lightweight HTML
player/timeline for video/audio (optional spectrogram), OS-open for other files.

**Acceptance:** `watch` emits the three-key payload; `listen` transcribes; `see`
reports the placeholder state cleanly; `enhance | see` and `scan | watch` piping
works; `view ./x.mp4 --at` opens a scrubbable player; `commands --json` lists the
senses + `view`.

## Phase 3 — OSINT

**Deliverables:** `source` registry (incl. `tinycloud-collection` source type) +
**default source providers**: `youtube` (yt-dlp) and `tiktok` (Apify
`clockworks/tiktok-scraper`, `APIFY_TOKEN` via `provider init`), each enumerating
by **keyword search or user/channel/playlist**; `target` (incl. image→`see
--embed` seed); `scan`; `capture` (yt-dlp + screenshot + scrape); `monitor`
(enumerate + diff seen-set + `--pipe` + `--once` + `--brief`); and `prebrief`
(case kickoff wizard: name → target → sources → profile → optional tinycloud
media-description collection). Wire `watch` to populate the case collection so
video-target `scan`/`capture` can query it.

**Acceptance:** `prebrief` stands up a case end to end; `target add` + `source
add` + `scan --pull` round-trips into records; a watched video is queryable via
the collection source; `monitor --once` detects a new fixture item, captures it,
runs `watch`, and updates `seen.json`.

## Phase 4 — Read side

**Deliverables:** the **memory-provider interface + `ask` fan-out** (A-spec) with
the **local memory provider** implemented (B-first: `.overcast/records` + a
lightweight keyword/embedding index); `case memory` routing to it; `ask`
(retrieve + cite), `brief` (report + `--export`). `/ask`, `/brief` prompt
templates.

**Acceptance:** after a populated case, `ask "…"` returns an answer citing
`record.id`+`media.at` from the local provider; the fan-out interface accepts >1
provider even though only `local` is wired; `brief --export` writes a readable
html/md report.

## Phase 5 — Provider SDK & setup

**Deliverables:** `setup` wizard (brain LLM + per-verb bindings); provider
descriptor format; `exec`/`http`/`in-proc` transports; `@overcast/provider-sdk`
(TS) + Python `overcast_sdk` with `init/run/describe`; **`provider init` as
command-or-skill** (overcast loads a skill if missing then runs it; tinycloud
providers use the `tinycloud-init` skill) + `doctor` readiness checks; the
**runnable sample providers** in `examples/providers/{bash,ts,python}` and
`docs/providers.md` ([05](05-providers.md)).

Plus the **cloudglue memory provider** (A-spec second tier) — collection +
recall via **public tinycloud verbs only** (`search`/`probe`/`ask`/`library`,
verified against `tinycloud commands --json`; no internal libs) — registered also
as a `source`; enable **multi-provider `ask` fan-out**; and document **pi-memory**
as the recommended global agent-notes companion (reuse the package).

**Acceptance:** rebinding `listen` to the sample Python provider and `see` to the
sample TS/http provider works without code changes to overcast; each sample runs
from the repo; `setup` persists a reusable profile; `ask --deep` answers over the
cloudglue collection with cited timestamps and `ask` fans out across local +
cloudglue.

## Phase 6 — MCP

**Deliverables:** `mcp-bridge.ts` (consume, lazy/selective); `overcast mcp
serve` (expose verbs as MCP); profile `mcp[]` config.

**Acceptance:** an example MCP OSINT server's tools appear as agent tools only
when enabled; `overcast mcp serve` is callable by an MCP client and returns
records.

## Phase 7 — Distribution

**Deliverables:** thin skills — flagship `overcast` (with generated
`reference/verbs.md`) + `overcast-init` (no per-verb skills); `overcast-skill.json`
⇄ `preflight.sh` sync; `overcast skills install`; **`.claude-plugin/` marketplace
plugin** (`plugin.json` + `marketplace.json`, mirroring tinycloud — see
[03 §3b](03-distribution.md#3b-claude-code-plugin--marketplace-priority-surface));
`bun build` binary with vendored ffmpeg/bun; `npm publish` of `@overcast/cli`.

**Acceptance:** `pi install npm:@overcast/cli` reshapes a vanilla pi into
overcast; the plugin passes `claude plugin validate .` and is installable from a
marketplace; `overcast skills install --harness claude-code` lets Claude Code
drive `overcast watch` via bash; extracted binary passes smoke tests (`--version
--json`, `commands --json`, `watch` fixture) offline.

## Phase 8 — DEF CON polish

**Deliverables:** the demo storyline (target → scan → capture → watch → brief,
+ a `monitor` loop), recorded fallback, README + talk-aligned docs, example
case fixtures.

**Acceptance:** the end-to-end OSINT demo runs from a clean machine via a single
documented install path.

---

## Start here (first concrete tasks for a coding agent)

1. Phase 0 scaffold + pin pi `0.79.10`; wire `tsup` and a no-op `overcast
   --version --json`.
2. Implement `record.ts` (type + JSONL store) and `case.ts` (`.overcast/`),
   exactly per [01 §4–§5](01-architecture.md#4-the-record-output-contract).
3. Build `registry/verbs.ts` with a single entry (`watch`) and the two
   generators (`to-cli`, `to-agent-tool`).
4. Implement the `exec` transport + the tinycloud `watch` descriptor; make
   `overcast watch` emit + persist a record.
5. Write `src/extension/overcast.ts` to register the `watch` tool, theme, and
   banner; verify in the pi TUI.

Then proceed Phase 2→.

## Risks / watch-items

- **pi version drift** — pi releases fast and breaks APIs; pin exact, isolate pi
  touch-points behind `src/extension/` + `registry/to-agent-tool.ts`.
- **Provider contract leakage** — keep the record loose; don't let tinycloud's
  envelope shape bleed into `record.ts` (map it at the exec boundary).
- **MCP context bloat** — enforce lazy/selective registration; default MCP off.
- **Prompt injection** (OSINT ingests hostile media/web) — documented YOLO risk
  for v1; revisit isolation later (the talk can foreground this).
- **ffmpeg/bun vendoring size** — accept tinycloud-scale (~40–50 MB) binaries.
