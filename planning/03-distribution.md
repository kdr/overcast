# 03 — Skills & plugin distribution

overcast ships through **four surfaces** from **one open repo**, no CDN. Each
serves a different way a user might "inject overcast into the harness of their
choice":

| Surface | For whom | Install |
|---|---|---|
| **pi package** | pi users | `pi install npm:@overcast/cli` |
| **standalone binary** | non-pi users | `npm i -g @overcast/cli` (or `bun build` artifact) |
| **agent skills** | Claude Code / Codex / Cowork / any agentskills.io harness | `overcast skills install` |
| **Claude plugin (marketplace)** | Claude Code users | add marketplace → install the `overcast` plugin |
| **MCP server** | MCP-native harnesses | `overcast mcp serve` |

The CLI is the common denominator. Surfaces 1, 3, 4 are thin wrappers that point
an agent at the same CLI/verb registry.

---

## 1. pi package (primary surface)

A pi package bundles extensions, skills, prompts, and themes and is shared via
npm or git. overcast's `package.json` declares:

```jsonc
{
  "name": "@overcast/cli",
  "keywords": ["pi-package"],
  "bin": { "overcast": "dist/bin/overcast.js" },
  "pi": {
    "extensions": ["./dist/extension/overcast.js"],
    "skills":     ["./skills"],
    "prompts":    ["./prompts"],
    "themes":     ["./themes"]
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.79.10",
    "@earendil-works/pi-ai":         "0.79.10",
    "@earendil-works/pi-tui":        "0.79.10",
    "@cloudglue/cloudglue-js":       "^x.y.z",
    "ffmpeg-static": "…", "ffprobe-static": "…"
  }
}
```

`pi install npm:@overcast/cli` drops it into `~/.pi/agent/npm/` (or `.pi/npm/`
with `-l`). On next launch pi loads the extension, which (see
[01 §3](01-architecture.md#3-how-overcast-attaches-to-pi)):

- applies the overcast **theme** + ANSI **branding**,
- loads the active **profile** (brain LLM + per-verb provider bindings),
- opens the **case** (cwd) and its `.overcast/` store,
- **registers the verb tools** (`watch`, `listen`, `see`, `enhance`, `scan`,
  `capture`, `monitor`) via `pi.registerTool()`,
- registers stateful **slash commands** (`/target`, `/source`, `/setup`,
  `/case`) via `pi.registerCommand()` and ships `/ask`, `/brief` as **prompt
  templates**,
- mounts the **MCP bridge** (§4),
- sets the overcast **system prompt** (hacker persona + verb cheatsheet).

> Security note (carry into README): pi packages run with full system access;
> extensions execute arbitrary code. This is acceptable for v1 (YOLO), but the
> README must say so plainly.

**Recommended companion:** [`pi-memory`](https://github.com/jayzeng/pi-memory)
(install via `pi install npm:pi-memory`) for global, cross-case investigator
notes/scratchpad. overcast owns the per-case record + media-semantic memory tiers
([05 §Memory providers](05-providers.md#memory-providers)); pi-memory covers agent
notes. It's recommended, not bundled.

---

## 2. Standalone binary

For users who don't run pi. `bun build --compile` produces a single executable
that bundles pi + overcast; ffmpeg/ffprobe/bun are vendored **next to** the
binary (not inside it), exactly like tinycloud's dist:

```
dist/bin/
  overcast            # compiled (pi + overcast)
  bin/ ffmpeg ffprobe bun
  skills/ …           # bundled skills
  themes/ overcast.json
```

Published to npm as `@overcast/cli` with a `bin` entry. No CDN, no launcher
download dance — `npm i -g @overcast/cli` is the whole story. (A `curl | sh`
convenience installer is optional, like pi's.)

Build pipeline mirrors tinycloud: `tsup` for dev/library build, `scripts/build-
bun.ts` for the compiled binary (compile entry, vendor ffmpeg/ffprobe/bun, copy
`skills/` + `themes/`, bundle any skill scripts to `.js`).

---

## 3. Agent skills

So **non-pi** harnesses (Claude Code, Codex, Cowork, anything agentskills.io)
can drive overcast by reading a `SKILL.md` and calling the CLI via bash —
progressive disclosure, pi's recommended alternative to MCP.

Keep the skill surface **thin**. There is **no skill per verb** — the flagship
`overcast` skill teaches both *when* to use overcast and *how to call every
verb*, with per-verb detail pushed into `reference/` and loaded on demand. Two
skills ship by default; add a workflow skill only if it clearly earns its place.

```
skills/
  overcast/                  # flagship: the one entry point
    SKILL.md                 #   thin top; when to use it + links into reference/
    reference/
      verbs.md               #   per-verb man pages (generated from the registry)
      record.md              #   the record / output contract
      sources-providers.md   #   sources, provider transports, profiles
      mcp.md                 #   installing & calling MCP servers
    scripts/preflight.sh     #   one actionable line; exit 0/10/11/12/13
    overcast-skill.json      #   compat manifest: min_version, supported_range, required_features
  overcast-init/             # guided first-time setup (setup + first case + a provider)
    SKILL.md

  # optional, ONLY if warranted (never per-verb):
  #   overcast-investigation/  end-to-end OSINT playbook (target→scan→capture→watch→brief)
```

`reference/verbs.md` is generated from `overcast commands --json`, so the
flagship skill never drifts from the CLI.

> Separate from overcast's own skills: a **provider's init step may load a
> third-party skill on demand** — the default tinycloud providers init via
> tinycloud's `tinycloud-init` skill, which overcast installs/loads if missing
> then runs. See [05 §Provider init](05-providers.md#provider-init--commands-or-skills).

**Invariants** (borrowed from tinycloud, verified against `npx skills add`):

- The skill **directory** is the unit of distribution — installing one copies
  only that folder. A skill may only reference files inside its own folder; any
  cross-skill mention is conditional prose ("if the `overcast` skill is
  installed…"), never a relative path.
- `preflight.sh` prints exactly **one** actionable line. Exit codes: `0` ok /
  `10` binary missing / `11` version too low / `12` missing features / `13`
  missing credentials. Its required-features list must equal
  `overcast-skill.json` (CI diffs them).
- SKILL.md frontmatter follows the agentskills.io standard
  (`name`, `description`, `autoload`, `argument-hint`).

**Installer** — `overcast skills install [--harness <ids>] [--skill <names>]
[--global] [--dir <path>]`. Harness table (each at `<configDir>/skills`):
`claude-code`→`.claude`, `agents`→`.agents`, `codex`→`.codex`, `cursor`→
`.cursor`. Interactive menu in a TTY (detected dirs preselected); `--yes`
installs into every detected dir (default `.claude`). Reuse tinycloud's
`resolveTargets` (pure, unit-testable) / `promptForTargets` split.

---

## 3b. Claude Code plugin & marketplace (priority surface)

The Claude Code marketplace is an **explicit target** — an important place to be
discoverable. Mirror tinycloud's `.claude-plugin/` shape exactly: two manifests
at the repo root, plugin source `"./"`, skills auto-discovered from `skills/`.

```jsonc
// .claude-plugin/plugin.json
{ "name": "overcast",
  "displayName": "Overcast — video-OSINT",
  "description": "Give your agent senses (video/audio/image understanding) and OSINT reach (scan/capture/monitor) via the overcast CLI.",
  "version": "0.1.0",
  "author": { "name": "…", "url": "…" },
  "homepage": "…", "repository": "https://github.com/…/overcast",
  "license": "…",
  "keywords": ["video","osint","audio","image","investigation","cloudglue"] }
```

```jsonc
// .claude-plugin/marketplace.json
{ "name": "overcast",
  "owner": { "name": "…", "url": "…" },
  "metadata": { "description": "Video-understanding OSINT toolkit.", "version": "0.1.0" },
  "plugins": [ {
    "name": "overcast", "source": "./",
    "description": "watch/listen/see + scan/capture/monitor over an investigation case, driven by the overcast CLI.",
    "version": "0.1.0", "category": "media",
    "tags": ["video","osint","investigation","cloudglue"], "strict": true } ] }
```

The plugin ships the **thin skill set** (flagship `overcast` + `overcast-init`).
Installing the plugin makes those skills available in Claude Code; they call the
`overcast` CLI via bash. Validate in CI with `claude plugin validate .`.

---

## 4. MCP — client first

The headline capability is **consuming/installing** MCP servers into overcast;
serving overcast as MCP is a secondary convenience.

**Install & consume (primary).** `overcast mcp install|add|enable|disable|rm|
list|tools|call` manages servers, persisted in the active profile's
`profile.mcp[]` (so they travel with `setup`/`--profile`). The pi extension
bridge `mountMcpBridge(pi, profile)` connects each **enabled** server, lists its
tools, and registers them via `pi.registerTool()` — **lazily/selectively**
(prefer on-demand) to avoid context bloat. Servers marked `asSource` are also
added to the `source` registry so `scan`/`monitor`/`capture` can query them.
Full command spec: [02 `overcast mcp`](02-cli-reference.md#overcast-mcp).

```jsonc
"mcp": [ { "id": "shodan", "transport": "stdio", "command": "uvx",
           "args": ["shodan-mcp"], "env": { "SHODAN_API_KEY": "${env:SHODAN_API_KEY}" },
           "enabled": true, "lazy": true, "asSource": true } ]
```

Fallback for non-pi contexts: wrap an MCP server as a CLI with `mcporter`.

**Serve (secondary).** `overcast mcp serve` publishes the overcast verbs as an
MCP server (stdio/http) so MCP-native harnesses use overcast without pi. Tool
schemas are generated from the same verb registry
([01 §7](01-architecture.md#7-verb--one-spec--three-surfaces)); results are
records.

---

## 5. Versioning & release

- **CLI version == binary version**, 1:1. The pi packages are pinned **exactly**
  to `0.79.10` (treat bumps as reviewed changes; mirror pi's own supply-chain
  pinning — `save-exact`, lockfile as ground truth).
- `overcast --version --json` reports `version`, pinned `pi_version`,
  `record_schema`, and `features[]` (e.g. `provider.exec`, `provider.http`,
  `mcp.bridge`). Skills assert against this.
- Release = build (`tsup` + `bun build`) → smoke test extracted binary
  (`--version --json`, `commands --json`, run `watch` against a fixture) →
  `npm publish`. No CDN manifest tooling needed.
- CI gates: unit + e2e (offline, fixture provider), shellcheck on
  `preflight.sh`/installers, plugin/skill metadata sync (`overcast-skill.json`
  ⇄ `preflight.sh`), `claude plugin validate .`.
