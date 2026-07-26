<p align="center">
  <img src="assets/branding/logo.png" alt="overcast" width="420" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kdrrr/overcast"><img src="https://img.shields.io/npm/v/%40kdrrr%2Fovercast?logo=npm&color=cb3837" alt="npm version" /></a>
  <a href="https://github.com/kdr/overcast/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/kdr/overcast/ci.yml?branch=main&logo=githubactions&logoColor=white&label=ci" alt="ci" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license: Apache-2.0" /></a>
</p>

# overcast

**Video OSINT agent: senses + OSINT reach for any agent.**

overcast gives an agent *senses* and *recon and targeting reach*, organized
around an investigation **case**: a working directory with a local `.overcast/`
store where every result is kept. Point it at a corpus, 10 clips or 1,000, and it
turns footage into cited evidence: speech and audio with `listen`, full video
understanding with `watch`, on-screen text and objects with `see`, faces and
cross-corpus person search with `face`, and named entities with `index entities`.
Results persist as evidence-only case memory, so intelligence accumulates across
sessions instead of vanishing between runs, and `ask` answers cite the exact
record and timestamp.

Every subcommand is modular: each verb is a standalone CLI command that emits a
portable JSON record, so you can run the whole pipeline as one agent or drop a
single step into another recon/security workflow. overcast ships as a **pi
package**, a **standalone bun binary**, and **agent skills** that drive the CLI
from any harness. The brain LLM is BYO; the default perception backend is the
[Tinycloud Video Agent CLI](https://www.npmjs.com/package/@cloudglue/tinycloud).
Every verb runs over one provider contract, so you can rebind any sense to
another backend or your own script with no code changes.

---

## 📣 News

**overcast is at [DEF CON 34](https://info.defcon.org/defcon34/content/?id=66515)
Demo Labs** — *"Overcast: Video OSINT Agent. Point It at 100 Videos, Ask
Anything"*, presented by Kevin Dela Rosa. Two sessions, both in
LVCC L1, Exhibit Hall West 3 – 902 (Demo Labs Track 6):

| Session | When |
| --- | --- |
| 1 | Fri, Aug 7, 2026 · 12:00–12:45 PDT |
| 2 | Sat, Aug 8, 2026 · 16:00–16:45 PDT |

Come see it run live, or [read the abstract](https://info.defcon.org/defcon34/content/?id=66515).

---

> ### ⚠️ Responsible use & security model
>
> overcast is a **dual-use** tool. Its OSINT sources can reach personal
> information about real people (reverse-face and reverse-image search,
> skip-trace / people-search, phone, property, and license-plate lookups). Use
> it **only for lawful purposes against targets you are authorized to
> investigate.** The high-sensitivity sources are opt-in and never enabled by
> default, and each carries legal constraints (DPPA, not-an-FCRA-report,
> biometric-privacy law, third-party ToS). Read
> **[RESPONSIBLE_USE.md](RESPONSIBLE_USE.md)** before you point it at anyone.
>
> By design, overcast runs an agent with **no sandbox or permission system**
> (inherited from [pi](https://github.com/earendil-works/pi)) over **untrusted
> media and scraped web content**, which are prompt-injection vectors. Run
> investigations in an environment you're willing to expose to the material you
> collect. See **[SECURITY.md](SECURITY.md)** for the full trust model and how
> to report a vulnerability.

---

## Quickstart

```bash
npm i -g @kdrrr/overcast && overcast doctor     # install + preflight

# 1 — point a case at a target, sweep public sources, ask with citations
overcast case setup --name dock-incident \
  --target "white van at pier 9" --source web:"pier 9 dock incident" --yes
overcast scan --pull                            # enumerate sources → capture → sense each hit
overcast ask "every white van, with timestamps" # answer cites record.id + timestamp
overcast brief --export brief.html              # story-first analyst report

# 2 — or analyze a clip directly
overcast watch ./clip.mp4                        # full video understanding → a cited record
overcast listen ./clip.mp4                       # speech + audio-scene transcript
overcast face ./clip.mp4 --match ./suspect.jpg   # find this person across the clip, ranked
```

A **case is just a directory** with a `.overcast/` store — switch cases with
`cd` or `--case <dir>`. pi's per-directory sessions are the case history.

**→ Full worked examples** — person search, OSINT pulls, continuous monitoring,
visual / audio / voice DBs, the control-room wall, detection crops, and more —
live in the **[Field Manual](docs/field-manual.md)** (`docs/field-manual.md`).

---

## Install

```bash
npm i -g @kdrrr/overcast          # the CLI + pi package  →  `overcast`
overcast doctor                 # preflight: pi, ffmpeg/ffprobe, Cloudglue, providers
```

`npx @kdrrr/overcast doctor` runs any verb without a global install;
`npm i -g @kdrrr/overcast@latest` updates one. Or grab a **standalone binary**
(no Node required) for your platform from the
[latest release](https://github.com/kdr/overcast/releases/latest) —
`overcast-<os>-<arch>.tar.gz` (ships its `theme/` + `examples/` sidecars) — or
build it with `npm run build:bun` → `dist/bin/overcast`.

**Prerequisites**

- **Node.js ≥ 22** (with npm) — to install and run overcast. The compiled `bun`
  binary bundles its own runtime, but `npm i -g` needs Node 22+.
- **FFmpeg** — `ffmpeg` + `ffprobe` on your `PATH` (the internal media toolkit
  for `enhance`, frame extraction, detection crops, and `view`).
  `brew install ffmpeg` · `apt install ffmpeg` (or point `OVERCAST_FFMPEG` /
  `OVERCAST_FFPROBE` at specific binaries).
- **[tinycloud CLI](https://www.npmjs.com/package/@cloudglue/tinycloud)** +
  `CLOUDGLUE_API_KEY` — the default `watch` / `listen` / `face` / `index` backend
  (Cloudglue). Needs **≥ 0.3.12** (single-call verbatim transcripts); `face` +
  `index` need ≥ 0.3.4, the opt-in image `see` provider ≥ 0.3.7.
  `npm i -g @cloudglue/tinycloud@0.3.12` or `tinycloud update`.

Optional, feature-gated backends — each reports cleanly (`needs_credentials`)
when absent, so the rest of overcast is unaffected:

- **yt-dlp** on `PATH` — the `youtube` / `dl` sources and post-page fetches on
  `tiktok` / `x` / `instagram` / `telegram`. Install a build **with curl_cffi
  impersonation**: `pipx install "yt-dlp[default,curl-cffi]"` or a standalone
  [release binary](https://github.com/yt-dlp/yt-dlp#installation) (self-updates
  via `yt-dlp -U`). brew/apt builds lack impersonation, so TLS-fingerprinting
  hosts (e.g. domain-restricted Vimeo embeds) fail — `overcast doctor` flags
  this. `OVERCAST_YTDLP_CMD` picks a specific binary; `OVERCAST_YTDLP_ARGS`
  injects flags (e.g. `--referer` / `--impersonate`) into every call.
- **[qmd](https://github.com/tobi/qmd)** — optional local semantic case search
  (`npm install -g @tobilu/qmd`); plain `ask` does not need it.
- **ExifTool** / **c2patool** — the `exif` (metadata + GPS) and `verify` (C2PA /
  Content Credentials) forensic senses. `brew install exiftool c2patool`.
- **Playwright** — browser capture for the `screenshot` verb and `browser`
  source. `npm install --include=optional` then `npx playwright install chromium`.
- **uv-managed Python** — local face / CLIP / CLAP / audio / voice DBs and the
  split `enhance` ops (`scripts/visual-db-uv.sh`).

`overcast doctor` verifies core prerequisites and reports optional backends when
installed or configured. Full version nuances and env knobs →
[docs/configuration.md](docs/configuration.md).

---

## Use it from your agent

overcast drives any harness three ways — pick whichever fits:

**Agent skills** (Claude Code, Cursor, Codex, …) — install the bundled skills with
the CLI, or pull them straight from this repo with the harness-agnostic
[`skills`](https://github.com/vercel-labs/skills) installer:

```bash
overcast skills install --dest ~/.codex/skills # recommended for Codex/Cursor/other agents
overcast skills install                        # Claude Code default: copies into ~/.claude/skills
overcast skills install --harness claude-code  # explicit Claude Code target
npx skills add kdr/overcast                    # vercel-labs/skills; pulls skills from this repo
```

Shipped skills — `overcast` (the broad driver + `reference/verbs.md` man pages),
`overcast-init` (one-time setup), `overcast-skill-creator` (author your own), and
focused workflows:

| Skill | Trope / job |
|---|---|
| `overcast-recon-brief` | scan/monitor public sources → cited brief |
| `overcast-archive` | save media into global buckets, reuse + match across cases |
| `overcast-dork-recon` | Google-dork a domain for exposed assets → exposure brief |
| `overcast-attack-surface` | map a target's public attack surface (dork + shodan) |
| `overcast-visual-target-search` | find a person/logo/object across clips |
| `overcast-media-bug-triage` | screen recordings/audio → cited bug reports |
| `overcast-copycat-sweep` | hunt re-uploads/reskins of original video |
| `overcast-lineup` | build a face DB, run a probe through it ("the lineup") |
| `overcast-stakeout` | standing monitor + findings review + control-room wall |
| `overcast-scene-locate` | "where was this taken?" — clues → reverse-image search |
| `overcast-ocr-translate-search` | read foreign text off a frame → translate → re-search in the source language |
| `overcast-enhance-and-resolve` | "zoom in… enhance" — upscale, re-read, honestly |
| `overcast-wiretap` | diarize + audio-scene + spectrogram + voice-isolate/separate |
| `overcast-provenance` | "is this clip real?" — trace to the earliest source |
| `overcast-timeline` | reconstruct one event across multiple clips |
| `overcast-crime-board` | crops + person links + CLIP themes → CSI board + wall |
| `overcast-pinpoint` | pinpoint WHEN something happens — coarse→fine temporal search |
| `overcast-frame-grid` | triage a clip in one VLM call via a labeled frame contact sheet |
| `overcast-event-bisect` | binary-search the exact instant of a one-way state change |
| `overcast-where` | locate WHERE in a frame — detect box + VLM-verify the crop |
| `overcast-presence-window` | find the interval a person/object is on screen |
| `overcast-situation-room` | stand up the live monitoring page over the case ("monitor the situation") |
| `overcast-connect-the-dots` | build + read the case knowledge graph to link people/media/entities |
| `overcast-scanner` | police-CAD incident watch via the `dispatch` source → map + triage |
| `overcast-voiceprint` | speaker-ID lineup via the `voice-print` index |
| `overcast-camera-ballistics` | camera-fingerprint device linking via `exif` + `devices` |
| `overcast-verify-media` | "is this real?" triage — C2PA + exif + ELA |
| `overcast-skip-trace` | authorized identity dossier via username → person → phone → property |
| `overcast-audio-match` | same-recording hunt via audio fingerprints |
| `overcast-bolo` | standing face/image watchlist ("BOLO") — auto-flag matches into a triage queue |
| `overcast-canvass` | canvass public cameras near a location (OSM `overpass` + `webcam` + forward geocode) |
| `overcast-follow-the-money` | trace the public money trail — crypto tx history + SEC EDGAR filings |

Most are generated from `src/skill-gen.ts` (one source of truth); the three
newest workflow skills (`overcast-bolo`, `overcast-canvass`,
`overcast-follow-the-money`) are authored directly under `skills/`. The CSI/crime-trope
skills (`lineup`…`crime-board`) are exercised end-to-end against real media in
`test/e2e/live/cases/80`–`90`; the visual-CoT localization skills
(`pinpoint`…`presence-window`) in `test/e2e/live/cases/18_grid`.

**Claude Code plugin** (slash commands + skills as one package):

```text
/plugin marketplace add kdr/overcast
/plugin install overcast@overcast
```

**Interactive/headless overcast agent** — both `overcast` and
`overcast -p "<task>"` load the same system prompt and tool surface. The prompt
steers the agent to start with zero-config `ask`, rebuild qmd before semantic
queries, use `ask --deep` for configured semantic memory, and bind remote indexes
with `index attach` instead of note bookkeeping. Case memory is evidence-only:
setup/doctor/index/target/source/prebrief/read bookkeeping is excluded from `ask`
and `brief`. See the [Field Manual](docs/field-manual.md) for the agent's memory
model in depth.

---

## VS Code extension

**[Overcast for VS Code](vscode/README.md)** (`vscode/`, extension id
[`kdrrr.overcast`](https://marketplace.visualstudio.com/items?itemName=kdrrr.overcast)) puts
the situation room in your editor as a thin client of this CLI: right-click any
media file for the senses (watch / listen / see / faces / EXIF / …), an
activity-bar view with a command deck laid out along the intelligence cycle plus
Investigation / Sources / Records / Runs trees, evidence artifacts (map, graph,
wall, brief, situation) as editor tabs, and `@overcast` chat + `#overcast*`
language-model tools when a chat provider is installed. Every action spawns
`overcast … --json`; records land in the case and the sidebar follows the
`.overcast/` store live.

Install it from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kdrrr.overcast)
(search "Overcast", or `ext install kdrrr.overcast`), or install the
`overcast-<version>.vsix` attached to the
[latest release](https://github.com/kdr/overcast/releases) (`code
--install-extension overcast-<version>.vsix`, or "Install from VSIX…" in the
Extensions view), or build it from source:

```bash
cd vscode && npm install && npm run build && npm run package
code --install-extension ../.dev/overcast-*.vsix
```

---

## Live control room

overcast runs as a live operation, not just a batch tool:

- **Man in the chair** — remote-drive the running TUI session from your phone
  (`/chair on tailnet`, or launch with `overcast --chair`): a live assistant
  stream, steer / follow-up / ABORT prompts (typed or spoken via the browser's
  speech recognition), and a read-only case glance, over a token-authed
  localhost/tailnet HTTP+SSE bridge (pair with Tailscale or an SSH tunnel).
- **Situation room** — `situation` serves a self-updating monitoring page (wall
  tiles + reverse-chron scan/monitor feed + live GPS map + refreshing
  webcam/browser stills), auto-picked from the case's sources; `/situation on`
  runs the same page in-process, bound to the session.
- **Reports** — `brief` answers "what does the evidence say?" (story-first,
  short by default), `case status` is the mission board ("where is this case?"),
  and `case records` is the append-only audit log ("what exactly happened?"). The
  `/debrief` prompt drives the analyst loop over them.

Full setup, secure-origin voice, fallbacks, and the report anatomy →
**[Field Manual](docs/field-manual.md)**.

---

## Verbs

overcast is ~40 verbs across four groups; each is a standalone CLI command that
emits a portable JSON **record**:

- **Senses** (media → records) — `watch` `listen` `see` `face` `image` `audio`
  `voice` `cluster` `similar` `exif` `verify` `screenshot` `enhance`
  `reconstruct` `chronolocate`
- **Inspect** (look at the evidence) — `view` `crop` `grid` `wall` `situation`
  `map` `geofence` `devices` `graph`
- **OSINT** (search / capture / monitor) — `scan` `capture` `monitor` `index`
  `archive` `target` `source` `note` `finding` `prebrief`
- **Read** (synthesize the case) — `ask` `brief` `case`

Plus pi's base verbs (`read` `write` `edit` `bash` `grep` `find` `ls`).

**Full per-verb reference + every built-in source ref →
[docs/verbs.md](docs/verbs.md).** The authoritative registry is
`overcast commands --json`; `overcast <verb> --help` is a man page for any verb,
and `overcast --help` shows the full surface + env vars.

---

## Providers & configuration

Every verb runs over one provider contract, so you can rebind any sense to
another backend — or your own script — with **no code changes**:

```bash
overcast provider setup apply --verb see --choice fal --yes     # e.g. fal.ai for `see`
overcast provider create myfeed --kind source                    # scaffold your own source
overcast provider install ./myfeed --yes                         # register it — no fork
```

Shipped providers carry a `provider.json` manifest and are scanned at runtime;
bindings reference scripts as location-independent `shipped:` refs, so profiles
survive the install moving. A source package makes a new `scan`/`monitor` type; a
sense package a new `--choice`.

- **Bind backends, profiles, findings tuning, local visual/audio/voice DBs, and
  the full environment-variable surface** → **[docs/configuration.md](docs/configuration.md)**
- **Author your own provider** (manifest schema, `provider install`) →
  **[docs/providers.md](docs/providers.md)**

---

## Documentation

| Doc | What's in it |
| --- | --- |
| [docs/field-manual.md](docs/field-manual.md) | **Field Manual** — the operational playbook: the quickstart cookbook + end-to-end investigation flows (scan → capture → sense → ask/brief), the live control room, and the case memory model. |
| [docs/verbs.md](docs/verbs.md) | Verb & source reference — every verb and built-in source ref. |
| [docs/configuration.md](docs/configuration.md) | Binding backends, the profile system, findings tuning, local DBs, and environment variables. |
| [docs/providers.md](docs/providers.md) | Authoring your own provider — manifests, `provider install`, the binding model. |
| [RESPONSIBLE_USE.md](RESPONSIBLE_USE.md) | Dual-use / acceptable-use policy and per-source legal constraints. |
| [SECURITY.md](SECURITY.md) | Trust model and vulnerability disclosure. |
| [CLAUDE.md](CLAUDE.md) | Architecture guide (written for agents, accurate for humans) — invariants, stack, verb surface. |

Authoritative, always-current: `overcast commands --json` (the verb registry),
`overcast <verb> --help` (a man page), `overcast doctor` (what's installed).

---

## Distribution

Three surfaces from one source of truth (`src/registry/verbs.ts`):

- **pi package** (`@kdrrr/overcast`) — `tsup` bundles `dist/{bin,index,extension}.js`; pi + ffmpeg/ffprobe stay external (pinned / runtime-resolved). A `postinstall` brands the pinned pi host as "overcast" without moving `~/.pi`.
- **standalone binary** — `bun build --compile` → a single executable (+ a sidecar `package.json` for branding).
- **agent skills + Claude Code plugin** — `skills generate` renders `skills/overcast/{SKILL.md, reference/verbs.md}` from the registry; `skills install --dest <dir>` copies them into any agent skills directory, while bare `skills install` targets Claude Code.

---

## Development

```bash
npm run build       # tsup (dev/library build)
npm run typecheck   # tsc --noEmit
npm test            # unit tests (offline; fixtures)
npm run test:e2e    # offline e2e (fixture providers, no creds)
npm run test:e2e:live  # live real-data e2e (builds the bun binary, sources .env)
E2E_VERBOSE=1 npm run test:e2e  # include exact commands + output snippets in report.md
npm run build:bun   # bun build --compile → dist/bin/overcast
npm run pack:check  # verify synced versions + fresh dist/bin/overcast.js before npm pack
overcast commands --json   # the authoritative verb registry
overcast doctor            # preflight
```

`npm pack` runs `npm run pack:check` first. Build with `npm run build` before
packing; if the ignored `dist/` tree is missing or stale, the pack fails with a
message showing the version or command-registry drift.

---

## Contributing & community

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — dev setup, the architecture
  invariants, how to add a provider, and the PR checklist.
- **[RESPONSIBLE_USE.md](RESPONSIBLE_USE.md)** — the dual-use / acceptable-use
  policy and per-source legal notes. Read this before using the OSINT sources.
- **[SECURITY.md](SECURITY.md)** — the trust model and how to report a
  vulnerability (privately, via GitHub Security Advisories).
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — how we treat each other.
- **[SUPPORT.md](SUPPORT.md)** — where to get help.
- Questions and ideas → [Discussions](https://github.com/kdr/overcast/discussions);
  bugs and features → [Issues](https://github.com/kdr/overcast/issues/new/choose).

## License

Licensed under the [Apache License 2.0](LICENSE). Built on top of
[pi](https://github.com/earendil-works/pi). You are responsible for how you use
this tool and for complying with all applicable laws and the terms of any
third-party services you configure — see [RESPONSIBLE_USE.md](RESPONSIBLE_USE.md).

## Credits

Created by **[Kevin Dela Rosa](https://github.com/kdr)** — co-founder & CTO of
[Cloudglue](https://cloudglue.dev/) and creator of
[Tinycloud](https://www.tinycloud.sh/), the default perception backend here.

<p align="center">
  <a href="https://github.com/kdr"><img src="https://img.shields.io/badge/GitHub-kdr-181717?logo=github&logoColor=white" alt="GitHub @kdr" /></a>
  <a href="https://kevindelarosa.com/"><img src="https://img.shields.io/badge/Portfolio-kevindelarosa.com-0A66C2?logo=googlechrome&logoColor=white" alt="Portfolio" /></a>
  <a href="https://x.com/kdrwins"><img src="https://img.shields.io/badge/X-%40kdrwins-000000?logo=x&logoColor=white" alt="X @kdrwins" /></a>
  <a href="https://www.linkedin.com/in/kdrwins/"><img src="https://img.shields.io/badge/LinkedIn-kdrwins-0A66C2?logo=linkedin&logoColor=white" alt="LinkedIn" /></a>
  <a href="https://scholar.google.com/citations?user=8Pc5MiUAAAAJ&hl=en"><img src="https://img.shields.io/badge/Google%20Scholar-publications-4285F4?logo=googlescholar&logoColor=white" alt="Google Scholar" /></a>
</p>
