# 02 — CLI reference (man pages)

Authoritative spec for the `overcast` CLI. Every verb here is also a pi
AgentTool and a skill (see [01 §7](01-architecture.md#7-verb--one-spec--three-surfaces)).
`overcast commands --json` dumps this registry; docs must be verified against it,
not memory.

Conventions: `<required>` · `[optional]` · `a|b` choice · `--flag` boolean ·
`--opt <v>` value. All verbs accept the **global flags** and emit **records**
([01 §4](01-architecture.md#4-the-record-output-contract)).

---

## Global

```
overcast [global-flags] <command> [args]
overcast                       # launch interactive TUI (pi + overcast package)
overcast -p "<prompt>"         # headless one-shot (pi print mode)
```

### Global flags

| Flag | Description |
|---|---|
| `--home <dir>` | Override overcast home (`$OVERCAST_HOME`, default `~/.overcast`). |
| `--profile <name>` | Use a named profile (LLM + provider bindings). |
| `--case <dir>` | Operate on this case directory (default: cwd). |
| `--json` | Emit raw record(s) as JSONL on stdout. |
| `--format json\|md\|text` | Surface returned to the caller (record always persisted). |
| `--provider <name>` | Override the brain LLM provider for this run (pi passthrough). |
| `--model <pattern>` | Override the brain model (pi passthrough). |
| `--no-record` | Do not persist to the case store (ephemeral). |
| `-q, --quiet` | Suppress stderr logs. |
| `-h, --help` | Show help for the command. |
| `-v, --version` | Print version + pinned pi version + feature flags. |

### Meta commands

| Command | Description |
|---|---|
| `overcast commands --json` | Dump the verb registry (names, args, flags, output kinds). |
| `overcast doctor` | Preflight: pi present, providers reachable, creds, ffmpeg. |
| `overcast mcp …` | Install/call MCP servers (and optionally serve) — see [`overcast mcp`](#overcast-mcp). |
| `overcast skills install [--harness …]` | Install skills into a harness (see [03](03-distribution.md)). |

---

# Senses

## `overcast watch`

**NAME** — `watch` — understand a video.

**SYNOPSIS**

```
overcast watch <source> [--at <span>] [--prompt <text>] [--schema <name>]
                        [--frames] [--provider <name>] [--format <fmt>]
```

**DESCRIPTION** — Analyze a video file/URL/capture-id and emit a
`video.analysis` record: summary, scenes, transcript, on-screen text, detected
objects/faces, and findings with `media.at` time anchors. Backed by the `watch`
provider (default tinycloud, exec). Large media is frame-sampled via the
internal ffmpeg toolkit before provider calls.

**ARGUMENTS** — `<source>`: path, URL, or `capture-id` from the case.

**OPTIONS**

| Option | Description |
|---|---|
| `--at <span>` | Limit to a time span, `SS` or `START-END` (seconds or `mm:ss`). |
| `--prompt <text>` | Free-form question to focus the analysis. |
| `--schema <name>` | Extraction schema for structured `payload` (e.g. `plates`, `faces`). |
| `--frames` | Also persist sampled key frames to `.overcast/media/`. |
| `--provider <name>` | Override the bound watch provider. |
| `--format json\|md\|text` | Output surface. |

**OUTPUT** — record `kind=video.analysis`, `media.ref=<source>`, `payload` flat
map. **v1 (tinycloud):** a shot-detection describe across *all* modalities,
post-processed into `content` (markdown of the describe output), `transcript`
(speech VTT rendered as markdown), and `detailed` (the full `describe` JSON with
`include shots` + `include thumbnails`). Later: target-driven `extract` and
face-detection jobs run in parallel (see
[05-providers](05-providers.md#default-tinycloud-providers)).

**EXAMPLES**

```
overcast watch ./shadowport.mp4 --prompt "flag any license plates" --schema plates
overcast watch https://youtu.be/… --at 02:10-02:30 --frames
overcast scan --pull | overcast watch -    # pipe captured hits in
```

---

## `overcast listen`

**NAME** — `listen` — understand audio.

**SYNOPSIS**

```
overcast listen <source> [--at <span>] [--diarize] [--lang <code>]
                         [--prompt <text>] [--provider <name>] [--format <fmt>]
```

**DESCRIPTION** — Transcribe and analyze audio (or a video's audio track),
emitting an `audio.analysis` record: transcript, speaker diarization, language,
events/keywords, findings with `media.at`. Default provider tinycloud; swappable
to e.g. a local whisper (`http`/`in-proc`).

**OPTIONS**

| Option | Description |
|---|---|
| `--at <span>` | Limit to a time span. |
| `--diarize` | Attribute speech to distinct speakers. |
| `--lang <code>` | Hint/force source language (e.g. `en`, `es`). |
| `--prompt <text>` | Focus the analysis. |
| `--provider <name>` / `--format <fmt>` | As above. |

**OUTPUT** — record `kind=audio.analysis` (`transcript`, `segments[]` with
`speaker` + `at`, `language`, `findings[]`). **v1 (tinycloud):** a speech-only
describe.

**EXAMPLES**

```
overcast listen ./call.m4a --diarize --lang en
overcast listen ./shadowport.mp4 --at 0-60 --prompt "names or addresses mentioned"
```

---

## `overcast see`

**NAME** — `see` — understand an image (or a single video frame).

**SYNOPSIS**

```
overcast see <source> [--ocr] [--detect <classes>] [--prompt <text>]
                      [--embed] [--provider <name>] [--format <fmt>]
```

**DESCRIPTION** — Describe an image: caption, OCR text, detected objects/faces,
and optional embedding. Also used internally to turn an **image target** into a
visual query seed for `scan`/`monitor`.

**OPTIONS**

| Option | Description |
|---|---|
| `--ocr` | Extract on-image text. |
| `--detect <classes>` | Comma list of classes to detect (e.g. `face,plate,logo`). |
| `--prompt <text>` | Focus the description. |
| `--embed` | Persist a visual embedding (used as query seed). |
| `--provider <name>` / `--format <fmt>` | As above. |

**OUTPUT** — record `kind=image.analysis` (`caption`, `ocr`, `detections[]`,
optional `embedding`). **v1:** no tinycloud implementation — ships as a
**placeholder**; bind a provider (VLM / http / SDK) via `setup provider see …`.

**EXAMPLES**

```
overcast see ./suspect.jpg --ocr --detect face,plate
overcast see frame://rec_8f2a@134      # a frame referenced by a prior record
```

---

## `overcast enhance`

**NAME** — `enhance` — improve media before a sense (modality-dispatched).

**SYNOPSIS**

```
overcast enhance <source> [--ops <list>] [--at <span>] [--out <path>]
                          [--provider <name>] [--format <fmt>]
```

**DESCRIPTION** — Produce *better media* (not analysis). Dispatches on modality:
image → denoise/upscale/deblur/deskew; audio → denoise/voice-isolate/normalize;
video → stabilize/frame-upscale/deflicker. Deterministic ops run on the internal
ffmpeg toolkit; model-based ops (Real-ESRGAN, source separation) run via a
swappable provider.

**OPTIONS**

| Option | Description |
|---|---|
| `--ops <list>` | Explicit ops, else sensible defaults per modality. |
| `--at <span>` | Limit to a span (video/audio). |
| `--out <path>` | Output path (default `.overcast/media/`). |
| `--provider <name>` / `--format <fmt>` | As above. |

**OUTPUT** — record `kind=media.enhanced`, `media.ref=<output path>` (chain into
`watch`/`listen`/`see`).

**EXAMPLES**

```
overcast enhance ./grainy.jpg --ops denoise,upscale | overcast see - --ocr
overcast enhance ./call.m4a --ops voice-isolate,normalize
```

---

## `overcast view`

**NAME** — `view` — open media in a lightweight local viewer.

**SYNOPSIS**

```
overcast view <ref> [--at <span>] [--spectrogram] [--no-open]
```

**DESCRIPTION** — A quick, lightweight way to *look at* media. For **video**,
generates a self-contained HTML player with a scrubbable timeline (and marker
pins for any `media.at` findings on the referenced record) and opens it. For
**audio**, a similar player, optionally with a `--spectrogram`. For **any other
file**, just hands off to the OS open command (`open` / `xdg-open` /
`start`). Intended for the human at the TUI, not the model; emits no analysis.

**ARGUMENTS** — `<ref>`: a path, a `capture-id`, or a `record-id` (jumps the
player to that record's `media.at`).

**OPTIONS**

| Option | Description |
|---|---|
| `--at <span>` | Start the player at `SS` or seek a `START-END` span. |
| `--spectrogram` | (audio) also render a spectrogram view. |
| `--no-open` | Write the viewer file but don't launch it (prints the path). |

**OUTPUT** — opens a viewer; emits a small `view` record only when `--no-open`
(with the generated file path). Built on the internal ffmpeg toolkit; no provider.

**EXAMPLES**

```
overcast view ./shadowport.mp4 --at 02:14
overcast view rec_8f2a               # jump to that finding's timestamp
overcast view ./call.m4a --spectrogram
overcast view ./dossier.pdf          # → OS open
```

---

# OSINT

## `overcast scan`

**NAME** — `scan` — sweep registered sources for the target(s).

**SYNOPSIS**

```
overcast scan [--target <ref>] [--query <kw>] [--source <ids>] [--since <when>]
              [--limit <n>] [--pull] [--format <fmt>]
```

**DESCRIPTION** — Query the case's enabled **sources** for the active
**target** (name / prompt / image-seed) and emit `scan.hits` records (one per
hit: title, url, source, timestamp, snippet/thumbnail). With `--pull`, each hit
is immediately `capture`d and routed to the matching sense (one-shot recon).

**OPTIONS**

| Option | Description |
|---|---|
| `--target <ref>` | Override the active target for this scan. |
| `--query <kw>` | Ad-hoc keyword search across sources (no target needed). Sources can also enumerate by their bound user/channel/playlist/hashtag ref. |
| `--source <ids>` | Restrict to specific source ids (default: all enabled). |
| `--since <when>` | Only items newer than e.g. `24h`, `2026-06-01`. |
| `--limit <n>` | Max hits per source. |
| `--pull` | Auto-capture + sense each hit (emit downstream records too). |
| `--format json\|md\|text` | Output surface. |

**OUTPUT** — records `kind=scan.hit` (`{title,url,source,published,snippet,media?}`).

**EXAMPLES**

```
overcast scan --since 24h
overcast scan --source youtube:pier9,web --limit 20 --pull
```

---

## `overcast capture`

**NAME** — `capture` — fetch a resource into the case.

**SYNOPSIS**

```
overcast capture <ref> [--index] [--screenshot] [--out <path>] [--format <fmt>]
```

**DESCRIPTION** — Acquire media/content into `.overcast/media/`: download a
video (yt-dlp), screenshot a page, or scrape content. Emits a `capture` record
with a `capture-id` usable by the senses. `--index` also embeds the artifact
into the case index for recall.

**ARGUMENTS** — `<ref>`: a URL, a `scan.hit` id, or `-` to read hits from stdin.

**OPTIONS**

| Option | Description |
|---|---|
| `--index` | Embed into the case index after capture. |
| `--screenshot` | Capture a rendered screenshot (pages). |
| `--out <path>` | Output location override. |
| `--format <fmt>` | Output surface. |

**OUTPUT** — record `kind=capture` (`{capture_id, path, kind, source}`,
`media.ref=<path>`).

**EXAMPLES**

```
overcast capture https://youtu.be/… --index
overcast scan --since 24h | overcast capture -      # capture every fresh hit
```

---

## `overcast monitor`

**NAME** — `monitor` — `scan` on a loop; diff; pipe new items into a sense.

**SYNOPSIS**

```
overcast monitor [--target <ref>] [--source <ids>] [--every <interval>]
                 [--pipe <verb>] [--brief] [--once] [--alert <sink>]
```

**DESCRIPTION** — Enumerate sources on a cadence, diff against the case
**seen-set**, and for each *new* item run a pipeline (default `capture` →
`--pipe` sense). Optionally `--brief` the new findings and emit an alert.
Long-running; intended to be run under tmux or a scheduler (cron / the host's
scheduled tasks). `--once` runs a single diff pass and exits (for schedulers).

**OPTIONS**

| Option | Description |
|---|---|
| `--target <ref>` / `--source <ids>` | Scope (default: active target, all sources). |
| `--every <interval>` | Cadence, e.g. `15m`, `6h`. Ignored with `--once`. |
| `--pipe <verb>` | Sense to run on new items (`watch`\|`listen`\|`see`). |
| `--brief` | Summarize the batch of new findings into a `brief` record. |
| `--once` | Single diff pass then exit (scheduler-friendly). |
| `--alert <sink>` | Where to notify (`stdout`, file, or an MCP/webhook sink). |

**OUTPUT** — streams records for new items (`scan.hit`, `capture`, sense kinds)
plus an optional `brief` record per batch; updates `seen.json`.

**EXAMPLES**

```
overcast monitor --source youtube:pier9 --every 6h --pipe watch --brief
overcast monitor --once --pipe watch --alert ./alerts.jsonl   # in a cron job
```

---

# Read (query the case)

> Inside the TUI these are slash commands (`/ask`, `/brief`). The CLI forms
> below are for headless/scriptable use.

## `overcast ask`

**NAME** — `ask` — natural-language query over the case.

**SYNOPSIS** — `overcast ask "<question>" [--deep] [--memory <ids>] [--since <when>] [--verb <kind>] [--format <fmt>]`

**DESCRIPTION** — Retrieve over the case's **memory** (the bound memory
providers) and answer in natural language with citations to `record.id` +
`media.at`. The inward twin of `scan` (external sources). By default it **fans
out** across all bound memory providers and merges, preferring grounded/cited
results; the always-on **local** provider covers the record store, and a
**cloudglue** provider (when bound) adds agentic deep search over the case
collection. `--deep` forces agentic deepsearch (`tinycloud probe`/`ask`).

**OPTIONS** — `--deep` (agentic semantic search) · `--memory <ids>` (restrict to
specific memory providers) · `--since` (time filter) · `--verb <kind>` (restrict
to record kinds) · `--format`.

**OUTPUT** — record `kind=answer` (`{text, citations[]}`).

**EXAMPLE** — `overcast ask "every appearance of the white van, with timestamps"`

---

## `overcast brief`

**NAME** — `brief` — synthesize the case into a report.

**SYNOPSIS** — `overcast brief [--scope <filter>] [--template <name>] [--export <path>] [--format <fmt>]`

**DESCRIPTION** — Produce a structured report from accumulated records (timeline,
entities, findings, media thumbnails with time anchors). `--export` writes a
shareable artifact (md/html); this subsumes the dropped `share` verb.

**OPTIONS** — `--scope <filter>` (e.g. `--scope since:24h`) · `--template <name>`
· `--export <path>` · `--format`.

**OUTPUT** — record `kind=brief` + optional exported file.

**EXAMPLE** — `overcast brief --scope since:7d --export ./shadowport-brief.html`

---

# State & configuration

## `overcast target`

**NAME** — `target` — define/refine the standing scope (persistent).

**SYNOPSIS**

```
overcast target add  <name|prompt> | --image <path>
overcast target list
overcast target rm   <id>
overcast target show
```

**DESCRIPTION** — Manage the case watchlist — what `scan`/`monitor` look for. A
target is a name, a free-text prompt, or a reference image/clip; image targets
are routed through `see --embed` to produce a visual query seed. Persisted to
`.overcast/target.json`. In the TUI this is `/target`.

**EXAMPLES**

```
overcast target add "@pier9_logistics"
overcast target add --image ./suspect.jpg
```

---

## `overcast source`

**NAME** — `source` — register where to look.

**SYNOPSIS**

```
overcast source add <type>:<ref> [--name <n>] [--auth <ref>]
overcast source list
overcast source enable|disable <id>
overcast source rm <id>
```

**DESCRIPTION** — Manage the source registry queried by `scan`/`monitor` and
pulled by `capture`. Each type is backed by a **source provider** (a scraper) —
the OSINT twin of a sense provider; see
[05-providers](05-providers.md#source-providers-scrapers). Built-in types:
`youtube` (yt-dlp, no key), `tiktok` (Apify `clockworks/tiktok-scraper`, needs
`APIFY_TOKEN`), `web`, `rss`, `folder`, `social`, and any MCP-backed source
(`--as-source`). There is **no separate `scrape` verb** — binding a source *is*
the scraper; `scan`/`monitor` enumerate it and `capture` fetches. Persisted to
`.overcast/sources.json`. Run `overcast provider init <type>` for sources that
need credentials.

**EXAMPLES**

```
overcast source add youtube:@pier9_logistics       # channel/handle
overcast source add youtube:search:"pier 9 dock"   # keyword search
overcast source add tiktok:@pier9                   # user  (then: overcast provider init tiktok  → APIFY_TOKEN)
overcast source add tiktok:#pier9                   # hashtag
overcast source add rss:https://example.com/feed.xml --name pier9-news
overcast source add folder:./dropbox-dump
```

---

## `overcast setup` (alias `profile`)

**NAME** — `setup` — pick LLM + per-verb providers; manage profiles.

**SYNOPSIS**

```
overcast setup                          # interactive wizard
overcast setup llm                      # choose brain provider/model (pi)
overcast setup provider <verb> <spec>   # bind a verb to a provider
overcast setup memory add|list|rm <spec># bind memory provider(s); local is implicit
overcast profile create|use|list|rm <name> [--copy-from <p>]
overcast provider init <verb>           # run a provider's init hook
```

**DESCRIPTION** — Configure and persist profiles under `~/.overcast/profiles/`.
A profile = brain `{provider, model}` + per-verb provider bindings
(exec/http/in-proc descriptors) + **memory bindings** (`memory[]`, local
implicit) + MCP servers + preferences. `provider init`
runs a provider's setup step — a **command** or a **skill** (overcast loads the
skill locally if missing, then runs it; the tinycloud providers use the
`tinycloud-init` skill). See
[05-providers](05-providers.md#provider-init--commands-or-skills). In the TUI
this is `/setup`.

**EXAMPLES**

```
overcast setup provider listen ./providers/whisper.py
overcast setup provider see http://localhost:8088
overcast profile create recon --copy-from default --default
```

---

## `overcast case`

**NAME** — `case` — inspect/manage the current case.

**SYNOPSIS**

```
overcast case init [<dir>] [--name <n>]
overcast case info
overcast case records [--verb <kind>] [--since <when>]
overcast case memory <list|get|add|search> [args]
```

**DESCRIPTION** — Initialize a `.overcast/` store, show case state, and
inspect/seed memory. `case memory` routes to the **bound memory providers**
(`list`/`get`/`add` over the local record store; `search` uses provider
`query`/`deepsearch`); records are written to memory automatically by every verb.
In the TUI this is `/case`. (Switching cases = `cd` / `--case <dir>`.)

**EXAMPLES**

```
overcast case init ~/cases/shadowport --name shadowport
overcast case records --verb video.analysis --since 24h
overcast case memory search "white van"
```

---

## `overcast prebrief`

**NAME** — `prebrief` — interactive wizard to set up a case (optional).

**SYNOPSIS**

```
overcast prebrief [--name <n>] [--profile <p>] [--non-interactive]
```

**DESCRIPTION** — A guided kickoff for a new investigation. Walks through the
common things you'd otherwise do ad hoc: name + `case init`, pick/confirm the
**profile** (brain LLM + provider bindings), define the first **target(s)**,
register **sources** (incl. installing OSINT MCP servers `--as-source`), and —
when the tinycloud provider is in play — stand up the case's **media-description
collection** so watched videos become a queryable source
([05-providers](05-providers.md#default-tinycloud-providers)). Entirely optional:
nothing here is a prerequisite, every step can be done later with `target`,
`source`, `setup`, `mcp`, `case`. The bookend to `brief` (the closing report).
In the TUI this is `/prebrief`.

**OPTIONS** — `--name <n>` (case name) · `--profile <p>` (profile to bind) ·
`--non-interactive` (apply defaults, no prompts — for scripting).

**OUTPUT** — writes `.overcast/` (`case.json`, `target.json`, `sources.json`),
may create a tinycloud collection, and prints a summary.

**EXAMPLE**

```
overcast prebrief --name shadowport --profile recon
```

---

## `overcast mcp`

**NAME** — `mcp` — install, manage, and call MCP servers (and optionally serve).

**SYNOPSIS**

```
overcast mcp add <id> <spec> [--transport stdio|http] [--env K=V…] [--as-source]
overcast mcp install <pkg> [--id <id>] [--as-source]   # fetch (npm/uvx/binary) + register
overcast mcp list                                       # configured servers + enabled state
overcast mcp tools [<id>]                               # tools a server exposes
overcast mcp enable|disable|rm <id>
overcast mcp call <id> <tool> [--args <json>] [--format <fmt>]
overcast mcp serve [--transport stdio|http] [--port <n>]   # (secondary) expose overcast verbs
```

**DESCRIPTION** — overcast is an **MCP client first**: installed servers' tools
become agent tools (registered lazily via the bridge,
[01 §9](01-architecture.md#9-mcp--overcast-is-an-mcp-client-first)) and, when
search/fetch-shaped, can be surfaced as **sources** for `scan`/`monitor`/
`capture` (`--as-source`). `install` fetches a known server package and
registers it; `add` registers an already-available command or URL. Servers
persist in the active profile so they travel with `setup`/`--profile`. `call` is
a scriptable, headless way to invoke a single MCP tool and capture its output as
a record. `serve` (secondary) publishes overcast's own verbs as an MCP server
for MCP-native harnesses.

**ARGUMENTS** — `<spec>`: for stdio, a command + args (e.g. `uvx shodan-mcp`);
for http, a URL. `<pkg>`: an installable server reference (npm/uvx/binary).

**OPTIONS**

| Option | Description |
|---|---|
| `--transport stdio\|http` | Connection type (default inferred from spec). |
| `--env K=V` | Env vars passed to the server (supports `${env:NAME}`). |
| `--as-source` | Also register the server in the `source` registry. |
| `--id <id>` | Explicit id (else derived from the package). |
| `--args <json>` | JSON arguments for `mcp call`. |
| `--lazy` / `--eager` | Register tools on demand (default) vs at startup. |
| `--format json\|md\|text` | Output surface for `call`/`list`/`tools`. |

**OUTPUT** — management commands print server/tool tables; `mcp call` emits a
record (`kind=mcp.<server>.<tool>`, loose `payload`). Installed servers are
written to `profile.mcp[]`.

**EXAMPLES**

```
overcast mcp install uvx:shodan-mcp --as-source        # OSINT MCP → also a source
overcast mcp add yt-osint "node ./servers/yt.js" --env API_KEY=${env:YT_KEY}
overcast mcp list
overcast mcp call shodan host_search --args '{"query":"pier9"}'
overcast mcp disable shodan
overcast mcp serve --transport http --port 7777        # expose overcast itself
```

---

# Slash commands (TUI)

Implemented as pi prompt templates (orchestration-only) or extension commands
(stateful). See [03 §pi-package](03-distribution.md).

| Slash | Backed by | Maps to |
|---|---|---|
| `/target …` | extension command | `target add/list/rm/show` |
| `/source …` | extension command | `source add/list/...` |
| `/setup` | extension command | `setup` wizard |
| `/case` | extension command | `case info/records/memory` |
| `/prebrief` | extension command | case kickoff wizard |
| `/view <ref>` | extension command | open media in the local viewer |
| `/mcp` | extension command | `mcp list/install/enable/disable` |
| `/ask <q>` | prompt template | retrieve over records + answer |
| `/brief [scope]` | prompt template | synthesize report |
| `/session`, `/model`, `/tree`, `/resume` | pi built-ins | pi session/model mgmt |

Senses + OSINT verbs (`watch`/`listen`/`see`/`enhance`/`scan`/`capture`/
`monitor`) are **agent tools**, not slash commands — the model calls them
directly; users can also run them as CLI subcommands.
