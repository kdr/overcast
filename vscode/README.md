# Overcast for VS Code

**The situation room in your editor: senses on your media, OSINT on your
sources, a wall to monitor the situation.**

[overcast](https://github.com/kdr/overcast#readme) turns footage into cited
evidence: it watches,
listens to, and reads your media, scans OSINT sources, and keeps everything
in an investigation case where every answer cites the exact record and
timestamp. This extension puts that power where your media already lives —
right-click a clip in the Explorer, and the case builds itself in the sidebar.

## Right-click any media file

Select a video, image, or audio file in the Explorer — or open one in the
editor — and the **Overcast** menu puts senses on it:

- **Watch** — describe a video scene by scene: what happens, what's said,
  what's on screen.
- **Listen** — transcribe the speech out of audio or video.
- **See** — describe an image and read the text in it.
- **Detect Faces** — find the people in a frame or clip.
- **EXIF Metadata** — GPS, capture time, and the camera fingerprint that ties
  photos to a device.
- **Chronolocate** — check a photo's claimed time against the sun and shadows.
- **Enhance** — denoise, upscale, forensic overlays.
- **Find Similar / Audio Fingerprint / Voice Match** — search the case's local
  image, sound, and speaker databases.
- **View / Grid** — an instant media player; a timestamped frame board for
  skimming an hour of footage at a glance.

Multi-select and **Analyze All Selected** runs the right sense per file across
a whole folder of footage. Every result lands in the case as an evidence
record with an id — citable, reviewable, permanent.

## The investigation view

The **Overcast** view in the activity bar is the case's living crime board,
laid out along the intelligence cycle:

- **Case deck** — the case name (click it to switch case folders), a CLI
  status dot, and one-press actions grouped by phase: *Prepare* (Case Setup,
  Add Source), *Collect* (Scan), *Process* (Analyze Media), *Analyze* (New
  Note, Map, Graph), *Present* (Brief, Wall, Situation) — plus the agent
  terminal.
- **Sources & Monitors** — the standing OSINT watch (YouTube, X, Telegram,
  webcams, police dispatch, flights, …) with per-source freshness. Expand a
  source to see the media it grabbed; the **Analyzed media** folder rolls up
  everything a sense has touched, and **Indexes** lists the case's search
  databases. Right-click a source to scan it now, or a media item to analyze
  it.
- **Records** — the evidence trail, newest first, one click from any record's
  full payload (media plays alongside it; notes render as markdown).
- **Investigation** — your lines of investigation, each with its linked
  evidence, and a *Notes & leads* queue where machine-suggested leads (a face
  match, a matched frame, a target phrase) wait with inline ✓ accept / ✗
  dismiss — nothing becomes evidence until you say so.
- **Runs** — every CLI run as a job: spinner + elapsed + inline cancel while
  it works, result deep-link when it's done.

Artifacts open as editor tabs: the **Map** plots every GPS-carrying record,
the **Graph** connects the dots between people, places, findings, and media,
the **Wall** loops case video at its evidence moments, the **Brief** is the
mission report, and the **Situation** panel is a live, self-refreshing
control room over the case's feeds.

The extension is a thin client of the `overcast` CLI: reads ride
`case status --json` / `case records --json` plus fs-watching the `.overcast/`
store, and every action spawns `overcast …` — the CLI and its record contract
stay the single source of truth.

## Chat

When a chat provider (e.g. GitHub Copilot) is installed, Overcast adds two
chat surfaces — both thin clients of the CLI, producing ordinary case records:

- **`@overcast` chat participant**: free text (or `/ask`) answers a question
  over the case's evidence, with citations; `/scan` scans the configured OSINT
  sources for new material, `/capture <scan-hit id | url>` pulls a scan hit or
  URL into the case, `/sense <verb> <file>` analyzes a media file (watch,
  listen, see, faces, EXIF), `/note <text>` records an analyst observation,
  `/status` shows lines of investigation + suggested leads + source freshness,
  `/brief` renders the mission brief. Answers stream as markdown with
  **Open Record** buttons for every produced or cited record id.
- **Six language-model tools** for agent mode: `#overcastStatus`,
  `#overcastAsk`, `#overcastScan`, `#overcastCapture`, `#overcastSense`,
  `#overcastNote` — or let the model pick them itself.

**Network + confirmation.** Scan and capture reach the network. Every
language-model tool invocation shows a confirmation dialog carrying the exact
`overcast …` command line before anything runs; ask and status are read-only.
A `needs_credentials` failure is relayed verbatim so the model can tell you
what to configure.

## Requirements

- The `overcast` CLI: `npm install -g @kdrrr/overcast`, or point the
  `overcast.path` setting at a binary or a built `dist/bin/overcast.js`
  (a `.js` path runs on the extension host's own Node).
- A case folder in the workspace (or run "Overcast: Initialize Case Here").

## Install

Install the packaged `.vsix`.

**From a GitHub release** (recommended): every
[overcast release](https://github.com/kdr/overcast/releases) attaches
`overcast-vscode-<version>.vsix`. Download it, then either run

```bash
code --install-extension overcast-vscode-<version>.vsix
```

or, in VS Code: **Extensions** view → `···` menu → **Install from VSIX…** and
pick the downloaded file.

**From source:**

```bash
cd vscode
npm install
npm run build         # tsup (host → dist/extension.cjs) + vite (SPA → dist/webview)
npm run package       # @vscode/vsce → ../.dev/overcast-vscode-<version>.vsix
code --install-extension ../.dev/overcast-vscode-*.vsix
```
