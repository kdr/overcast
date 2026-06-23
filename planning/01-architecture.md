# 01 — Architecture, stack & data model

## 1. Mental model: three layers

```
┌────────────────────────────────────────────────────────────────┐
│ LAYER 1 — RUNTIME (pi, unmodified)                               │
│ BYO LLM (pi-ai) · agent loop (pi-agent-core) · TUI (pi-tui)      │
│ sessions · slash commands · read/write/edit/bash/grep/find/ls   │
└────────────────────────────────────────────────────────────────┘
            ▲ overcast attaches here as a pi PACKAGE
┌────────────────────────────────────────────────────────────────┐
│ LAYER 2 — OVERCAST (the differentiator)                          │
│ senses:  watch · listen · see · enhance     view (player/timeline)│
│ osint:   scan · capture · monitor                                │
│ read:    ask · brief                                             │
│ state:   target · source · case · setup · prebrief (case wizard) │
│ glue:    record contract · provider abstraction · MCP bridge     │
└────────────────────────────────────────────────────────────────┘
            ▲ binds verbs to backends
┌────────────────────────────────────────────────────────────────┐
│ LAYER 3 — PROVIDERS (pluggable, per-verb, saved in profile)      │
│ default: tinycloud (exec)  ·  whisper/VLM  ·  http endpoint  ·   │
│ TS/Python SDK  ·  MCP servers (via bridge)                       │
└────────────────────────────────────────────────────────────────┘
```

overcast is **not a new framework**. It is (a) a pi *package* (extension +
skills + prompts + theme) that reshapes a vanilla pi agent into overcast, and
optionally (b) a `bun`-compiled binary that bundles pi + overcast for users who
don't run pi. Net-new code is the Layer-2 verbs, the provider layer, the record
store, and the MCP bridge — everything in Layer 1 is reused.

## 2. Stack

| Concern | Choice | Notes |
|---|---|---|
| LLM API | `@earendil-works/pi-ai@0.79.10` | 20+ providers, mid-session switch, abort, cost tracking, TypeBox tool schemas, split LLM/UI tool results |
| Brain provider: Cloudglue (optional) | registered via `pi.registerProvider()` | `api: "anthropic-messages"`, `provider: "cloudglue"`, `baseUrl` = `$CLOUDGLUE_BASE_URL` or `https://api.cloudglue.dev` (strip `/v1`), key = `$CLOUDGLUE_API_KEY`. Appears in `/model` alongside the BYO providers (model ids like `tinycloud:advanced`). Mirrors tinycloud's `resolveModel`. |
| Agent loop | `@earendil-works/pi-agent-core@0.79.10` | `Agent` class, events, queuing, attachments |
| TUI | `@earendil-works/pi-tui@0.79.10` | differential render; theme + branding component |
| Harness | `@earendil-works/pi-coding-agent@0.79.10` | extensions, skills, prompts, themes, sessions, RPC/JSON modes, `pi install` |
| Default perception backend | `@cloudglue/cloudglue-js` | tinycloud's SDK; reached via the tinycloud CLI (exec) by default |
| Media toolkit (internal) | `ffmpeg-static`, `ffprobe-static` | vendored; powers `enhance` + frame extraction; **not** a user-configurable provider |
| Schemas / config | `zod` (or TypeBox to match pi), `yaml` | record validation, provider descriptors |
| Language / build | TypeScript, ESM, Node ≥22; `tsup` (dev) + `bun build --compile` (binary) | mirrors tinycloud |
| Runtime for skill scripts / binary | `bun` (vendored in binary) | same pattern as tinycloud dist |

**Divergence from tinycloud:** tinycloud hardcodes `provider: "cloudglue"` in
its model resolver. overcast leaves the orchestrator LLM fully open (pi's
`/login`, `/model`, `~/.pi/agent/models.json`, `--provider/--model`). Keep the
two provider notions distinct everywhere:

- **Brain provider** — the LLM running the agent loop (pi-ai). Fully BYO. The
  extension also **registers Cloudglue** as a pi provider (anthropic-messages
  API against the Cloudglue endpoint, like tinycloud) so it is pickable via
  `/model` for users who want a turnkey option — but it is never forced.
- **Sense providers** — the backends behind `watch/listen/see/enhance` (default
  tinycloud). Configured per-verb in the overcast profile.

## 3. How overcast attaches to pi

A pi extension factory receives `ExtensionAPI` and, at load, performs:

```ts
export default async function (pi: ExtensionAPI) {
  applyTheme(pi);                       // overcast theme + ANSI banner
  await loadProfile(pi);                // llm + per-verb provider bindings
  const case_ = openCase(process.cwd());// case = this folder (see §5)
  for (const verb of OVERCAST_VERBS)    // watch, listen, see, enhance, scan...
    pi.registerTool(toAgentTool(verb, case_));
  registerStateCommands(pi, case_);     // /target /source /setup /case
  registerPromptTemplates(pi);          // /ask /brief (markdown)
  await mountMcpBridge(pi, profile);    // lazy MCP → registerTool (see §8)
  pi.setSystemPrompt(OVERCAST_SYSTEM);  // hacker persona + verb cheatsheet
}
```

The same verb definitions also back the **CLI** (`overcast watch ...`) and are
documented in the single flagship **`overcast` skill** (per-verb man pages live
in its `reference/`, generated from the registry) so non-pi harnesses can call
the CLI via bash. See §7 (verb = one spec → three surfaces).

## 4. The record (output contract)

Every verb emits one or more **records**: a loose, indexable unit that doubles
as a memory entry. Deliberately *not* tinycloud's rigid envelope.

```jsonc
{
  "id": "rec_8f2a1c",          // stable key; this IS the memory address
  "verb": "watch",             // producer
  "format": "json",            // "json" | "md" | "txt"  → how to read payload
  "payload": { ... } | "…",    // flat JSON map, OR markdown string, OR text
  "media": {                   // optional reference to source media
    "ref": "shadowport.mp4",   //   path | uri | source-id | capture-id
    "at": [134, 139]           //   optional: seconds (point) or [start,end]
  },
  "meta": {                    // optional, free-form
    "provider": "tinycloud", "model": "…", "time": "2026-06-22T…", "case": "shadowport"
  },
  "error": null,               // optional: free-string on failure
  "state": "ready"             // optional: free hint for pipelines (see below)
}
```

Rules:

- `payload` is opaque to the framework; `format` tells a consumer how to render
  or index it. JSON payloads SHOULD be a **flat map** where practical (easier to
  index/embed as memory).
- `media.at` is the **point-in-time** anchor — a single second or an
  `[start, end]` span — so any finding can be traced back to a frame.
- `state` and `error` are the *only* control fields, and both are optional/loose
  (no enum). Producers SHOULD use `state` to signal `ready | pending |
  needs_credentials | error` so `monitor` loops and `scan → capture → watch`
  chains can branch; consumers MUST treat unknown/missing `state` as "ready".
- Records serialize to JSONL and live in the case store (§5); they are the input
  to `ask`, `brief`, and memory recall.

`--format json|md|text` on any verb selects the *surface* returned to the
caller; the full record is always persisted.

## 5. Case = a folder of sessions

There is **no bespoke case object**. A case is just a directory. This maps
directly onto pi, which already stores sessions per working directory
(`~/.pi/agent/sessions/`, `--session-dir`, `/tree`, `/fork`, branching).

overcast adds one thing: a `.overcast/` store inside the case directory.

```
<case-dir>/                     # e.g. ~/cases/shadowport  ← cwd
  .overcast/
    case.json                   # id, name, created, active profile ref
    target.json                 # the standing scope (name|prompt|image refs)
    sources.json                # registered sources (where to look)
    seen.json                   # monitor's diff/seen-set
    records/                    # *.jsonl — every emitted record (the memory)
    media/                      # captured + enhanced artifacts
    index/                      # optional embeddings/index over records
  <user files, notes, exports…>
  (pi sessions live in pi's per-directory session store keyed to this dir)
```

- `setup`/`profile` = **how you work** (LLM + provider bindings), global,
  reusable across cases.
- `target`/`case` = **what you're working on**, local to the directory.
- "Switch case" = `cd` to another directory (and `--case <dir>` for headless).

## 6. State objects

| Object | Lives in | Set by | Read by |
|---|---|---|---|
| **target** | `.overcast/target.json` | `target` / `/target` | `scan`, `monitor` (query seed; image targets route through `see`) |
| **source** | `.overcast/sources.json` | `source` / `/source` | `scan`, `monitor`, `capture` |
| **record** | `.overcast/records/*.jsonl` | every verb | `ask`, `brief`, memory recall |
| **seen-set** | `.overcast/seen.json` | `monitor` | `monitor` (diff for new items) |
| **memory** | bound memory provider(s) over records | automatic `write` per verb | `ask`, `brief`, recall |
| **profile** | `~/.overcast/profiles/*` | `setup` | everything (llm + provider bindings) |

## 7. Verb = one spec → three surfaces

Each verb is declared once (name, summary, args, flags, output `kind`, provider
key) in a small registry. From that single declaration generate:

1. **CLI subcommand** — argv parsing + `--help` (the man page in
   [02-cli-reference](02-cli-reference.md)).
2. **pi AgentTool** — TypeBox params + `execute()` that returns a split result
   (compact summary to the LLM, full record in `details`).
3. **Reference entry** — a generated man page in the flagship `overcast` skill's
   `reference/verbs.md` (progressive disclosure) so non-pi harnesses learn to
   call the CLI. There is **no skill per verb** — see
   [03 §3](03-distribution.md#3-agent-skills).

This is tinycloud's `CommandSpec` registry pattern, kept lightweight. `overcast
commands --json` dumps the registry for discovery, and the skill reference is
generated from it.

## 8. Provider abstraction

A verb resolves to a provider via the active profile. One **wire contract** (the
record), three **transports**:

- **exec** (default) — provider is a command. Invoked `… --input <x> --json`,
  writes a record (or JSONL) to stdout, logs to stderr, `state`→exit-code hint.
  An `init` step handles setup (deps, creds, model pull). The default `watch`
  provider is a thin descriptor over `tinycloud watch … --json`.
- **http** — provider is an endpoint. overcast POSTs `{verb, input, opts}`,
  reads a record back. Covers "locally running model server".
- **in-proc** — a TS or Python provider class, run as a subprocess conforming to
  the exec contract, or imported directly when the harness language matches.

Provider descriptor (per verb, in profile or `providers/`):

```jsonc
{ "verb": "watch", "type": "exec",
  "run": "tinycloud watch {{input}} --json",
  "init": { "skill": "tinycloud-init", "ensure": true },  // command OR skill
  "describe": "tinycloud watch --schema --json" }
```

Every provider has an **init** step (run by `overcast provider init <verb>`,
auto-invoked by `prebrief`/`setup`). It can be a **command** or a **skill** —
when it's a skill, overcast loads it locally if missing then runs it (the
tinycloud providers use `tinycloud-init`). See
[05-providers](05-providers.md#provider-init--commands-or-skills).

**Three provider classes, one machinery.** The same transports/descriptor/init
serve **sense providers** (`watch/listen/see/enhance`), **source providers**
(scrapers), and **memory providers** (store + recall).

- *Source providers* implement `enumerate(target|query) -> scan.hit records` and
  `fetch(item) -> capture/media`; `scan` calls `enumerate`, `capture`/`monitor`
  call `fetch`. Defaults: **`youtube`** (yt-dlp, no key) and **`tiktok`** (Apify
  `clockworks/tiktok-scraper`, needs `APIFY_TOKEN`). So **"scraping" is not a
  separate verb** — it's a source provider. See
  [05-providers](05-providers.md#source-providers-scrapers).
- *Memory providers* implement `write(record)`, `query/recall`, and optionally
  `answer`/`deepsearch`; every verb's record is written to the bound memory, and
  `ask`/`brief` read from it (fan-out across bound providers — **A-spec**, with a
  single local provider shipping first — **B-first**). See
  [05-providers](05-providers.md#memory-providers). Note the **duality**: a
  Cloudglue collection is both a memory provider (inward `ask`/deepsearch) and a
  `source` (outward `scan`) — same backend, two entry points.

SDK shape (TS / Python) provided for overrides — `init()`, `run(input,ctx) ->
record`, `describe()`. The default **tinycloud** provider behavior (v1) and
**sample bash / TypeScript / Python providers + how to register them** live in
[05-providers](05-providers.md). See also [02-cli-reference](02-cli-reference.md)
`setup` and [04-implementation-plan](04-implementation-plan.md) Phase 5.

A provider may also register a **source**: the default tinycloud provider, when
used in a case, can stand up a **media-description collection** so videos watched
during the investigation become a queryable source for `scan`/`capture` against
video targets ([05-providers](05-providers.md#default-tinycloud-providers)).

## 9. MCP — overcast is an MCP client first

The primary MCP story is **inbound**: overcast can install and call MCP servers,
so OSINT/tooling MCPs become first-class capabilities of the agent. Exposing
overcast's own verbs as an MCP server is a secondary, optional convenience.

pi has no built-in MCP by design; the sanctioned path is an extension that
registers tools. overcast ships an `overcast-mcp` bridge that:

1. reads installed MCP servers from the profile (`profile.mcp[]`),
2. connects (stdio/http) and lists each server's tools,
3. registers them as pi tools via `pi.registerTool()` — **lazily/selectively**
   (only enabled servers; prefer on-demand registration) to avoid the
   context-bloat that motivated pi's no-MCP stance.

**Installing** a server is a managed action, not hand-edited JSON: `overcast mcp
add|install|enable|disable|rm|list|tools|call` (see
[02-cli-reference](02-cli-reference.md#overcast-mcp)). `install` can fetch a
known server package (npm / uvx / binary) and register it; `add` registers an
already-available command/url. Installed servers persist in the active profile so
they travel with `setup`/`--profile`.

```jsonc
// profile.mcp[]
{ "id": "shodan", "transport": "stdio", "command": "uvx", "args": ["shodan-mcp"],
  "env": { "SHODAN_API_KEY": "${env:SHODAN_API_KEY}" },
  "enabled": true, "lazy": true, "asSource": true }
```

**MCP servers as sources.** When a server's tools are search/fetch-shaped, mark
`asSource: true` and overcast also exposes it in the `source` registry, so `scan`
/ `monitor` / `capture` can query it like any other source — MCP becomes an OSINT
reach extension, not just extra agent tools.

**Outside pi** (the bun binary still embeds pi, so the bridge path is the same);
`mcporter` remains a fallback for wrapping an MCP server as a plain CLI.

**Serving (optional, secondary).** `overcast mcp serve` publishes overcast's own
verbs as an MCP server for MCP-native harnesses — schemas generated from the same
verb registry; results are records. See [03-distribution](03-distribution.md).

## 10. Config & home

- `~/.overcast/` — global home: `profiles/`, credentials, provider descriptors,
  cached provider binaries. Override with `--home` / `$OVERCAST_HOME`.
- Profile = `{ llm: {provider, model}, providers: { watch, listen, see, enhance,
  scan, capture }, memory: [...], mcp: [...], preferences }`. Select with
  `--profile` / `setup use <name>`.
- Per-case config in `.overcast/case.json` may pin a profile.
- Resolution precedence (mirror tinycloud): `--home` > `--profile` >
  `$OVERCAST_HOME` > default profile > `~/.overcast`.
