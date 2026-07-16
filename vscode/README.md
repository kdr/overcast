# Overcast for VS Code

The case viewer + verb invoker for [overcast](../README.md), as a VS Code
extension. One loop: **invoke** (a command deck of labeled buttons; right-click media →
sense verbs; registry-driven "Run Verb…" / "Search Source…" quick-picks) →
records land in the case → **view** (investigation sidebar with its notes &
leads queue, artifact tabs for view/grid/map/graph/wall/brief, live situation
panel).

The extension is a thin client of the `overcast` CLI: reads ride
`case status --json` / `case records --json` + fs-watching the `.overcast/`
store; every action spawns `overcast …` (never a library import). See the
repo-root CLAUDE.md invariants.

## Requirements

- The `overcast` CLI: `npm install -g @kdrrr/overcast`, or point the
  `overcast.path` setting at a binary or a built `dist/bin/overcast.js`
  (a `.js` path runs on the extension host's own Node).
- A case folder in the workspace (or run "Overcast: Initialize Case Here").

## Build & sideload

```bash
cd vscode
npm install
npm run build         # tsup (host → dist/extension.cjs) + vite (SPA → dist/webview)
npm run package       # @vscode/vsce → ../.dev/overcast-vscode-<version>.vsix
code --install-extension ../.dev/overcast-vscode-*.vsix
```

## Development

```bash
# from the repo root: build the CLI the fixture uses
npm run build
# seed the offline demo case (fixture providers, no creds)
bash vscode/scripts/seed-dev-case.sh
# then open vscode/ in VS Code and F5 ("Run Extension (fixture case)")
```

The seed script writes `.dev/vscode-fixture/.vscode/settings.json` pinning
`overcast.path` (your fresh build), `overcast.home` (the isolated fixture
home), and `overcast.profile`, plus a case-dir `.env` with the fixture source
binding — so scan/watch in the dev host run fully offline. `npm run typecheck`
covers host + webview;
`npm test` runs the pure-logic units (html rewriting, argv assembly, CLI
output parsing) with plain `node --test` — no VS Code required.

## Surfaces

- **Activity bar → Overcast**: a **Case** command deck pinned at the top
  (labeled buttons — New Note, Scan…, Run Verb…, Status Report, Map, Graph,
  Wall, Situation, Agent Terminal; case name + CLI status dot; Initialize/Select
  when there's no case) over three trees — Investigation (lines of investigation
  + a "Notes & leads" group: suggested findings with inline ✓/✗ and your notes,
  triage badge count on the view), Sources & Monitors (freshness), Records
  (trail).
- **Editor tabs**: artifact panels (view player, grid board, map, graph, wall,
  brief export — the CLI's own self-contained HTML, CSP/file:// rewritten for
  webviews), record detail, scan results.
- **Bottom panel → Situation**: the live situation page in an iframe; the
  extension owns an `overcast situation serve` child with a pinned token
  (`OVERCAST_SITUATION_TOKEN`).
- **Explorer right-click → Overcast**: watch/listen/see/face/exif/grid/… per
  media type; multi-select batch sensing. The same Overcast menu sits on media
  **editor tabs** (title-bar button + tab right-click) when an image/video/audio
  file is open in the built-in preview.

## Future: registry-generated contributions

`contributes.commands`/`menus` for the curated context verbs are hand-written
today. When the surface stabilizes, generate them from
`overcast commands --json` the same way `skills/` is generated from the verb
registry (src/skill-gen.ts), with an identical CI no-diff regen gate — making
this the registry's fourth surface (CLI, agent tool, skills, VS Code).
