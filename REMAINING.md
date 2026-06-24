# overcast — remaining work

Status as of this commit: **18 verbs, 96 unit tests + 84/84 e2e green.** Phases 0–5
+ 7 shipped; the completion push wired the previously-deferred flags, the `case`
verb, web search, `monitor --every`, and slash commands. What's left to call the
spec fully complete:

## 1. `ask --deep` + Cloudglue memory provider (Phase 5 A-spec tier-2)
- Stand up a per-case Cloudglue **collection** on `case init`/`prebrief` (tinycloud
  `library` verbs). Add each `watch`/`listen` record's media to it.
- Implement the **cloudglue memory provider** using *public tinycloud verbs only*
  (`search` / `probe` / `ask` / `library` — verify via `tinycloud commands --json`).
- Wire `ask --deep` → agentic deepsearch over the collection; fan out across local +
  cloudglue. Register the collection also as a `source` (the duality).
- **Status:** `ask --deep` is currently a no-op (local provider has no deepsearch).

## 2. Phase 6 — MCP (fully deferred)
- `src/extension/mcp-bridge.ts`: consume MCP servers from `profile.mcp[]`
  (`@modelcontextprotocol/sdk`, stdio/http), list tools, `registerTool` **lazily**.
- `mcp` verb: `add | install | enable | disable | list | tools | call`; `/mcp` slash.
- `asSource`: expose search/fetch-shaped MCP tools in the `source` registry.
- `mcp serve` (secondary): publish overcast verbs as an MCP server.
- **Test target:** `npx @cloudglue/cloudglue-mcp-server` (stdio, `CLOUDGLUE_API_KEY`).

## 3. Phase 8 — DEF CON polish
- README (install paths, the three surfaces, key matrix).
- Demo storyline: `prebrief → target → source → scan → capture → watch → ask → brief`
  + a `monitor --every` loop. Recorded fallback.
- Example case fixtures.

## 4. Test coverage to add
- Live `monitor --once`/`--every` against a **real** YouTube channel run twice
  (real seen-set diff, not fixture).
- `scan --since`, real web `fetch` (capture a page) assertions.
- Slash-command / prompt-template e2e (TUI-driven).
- `ask --deep` once the cloudglue memory provider lands.

## Notable known gaps / caveats (not blocking)
- **OCR**: `see --ocr` routes to florence-2 `/ocr` (fal) — PaddleOCR-VL isn't on any
  HF/fal serverless provider (would need self-hosting).
- **Audio enhancement**: not on HF providers; use fal (`deepfilternet3`) or
  ElevenLabs (voice isolator). Image enhance works via fal (incl. HF-token routing).
- **bun binary**: ffmpeg/yt-dlp not yet vendored into the compiled binary (dev/npm
  paths use ffmpeg-static / PATH).
- **pi pin**: bumped 0.79.10 → 0.80.1 (reviewed); CLAUDE.md updated.

## How to run
```
npm run typecheck && npm run build && npm test     # 96 unit, offline
bash test/e2e/run.sh                               # 84/84 cumulative → .dev/smoke/<UTC>/report.md
OVERCAST_E2E_LIVE=1 bash test/e2e/run.sh           # + real Cloudglue watch/listen
bash .dev/live/run.sh all                          # real provider workflows (.dev/, gitignored)
```
Keys honored (see `overcast --help`): CLOUDGLUE_API_KEY, FAL_KEY, ELEVENLABS_API_KEY,
HF_TOKEN, APIFY_TOKEN, TAVILY_API_KEY/BRAVE_API_KEY, + any pi-ai brain key.
