# Contributing to overcast

Thanks for your interest in improving overcast! This guide covers how to get set
up, the conventions that keep the project coherent, and what we look for in a
pull request. Please also read our [Code of Conduct](CODE_OF_CONDUCT.md) and
[Responsible Use](RESPONSIBLE_USE.md) policy.

## Ways to contribute

- **Report a bug** or **request a feature** via
  [issues](https://github.com/kdr/overcast/issues) (templates provided).
- **Ask a question** or share an idea in
  [Discussions](https://github.com/kdr/overcast/discussions).
- **Report a security issue** privately — see [SECURITY.md](SECURITY.md). Do not
  file security reports as public issues.
- **Open a pull request** — small, focused PRs are easiest to review.

## Development setup

Prerequisites: **Node.js ≥ 22** (with npm), plus the runtime tools overcast
shells out to when you exercise the relevant verbs — **FFmpeg/ffprobe**, and
optionally **tinycloud**, **ExifTool**, **c2patool**, **yt-dlp**, and a
**uv**-managed Python for the local visual/audio DBs. See the README
"Prerequisites" section for the full list. `bun` is only needed to build the
compiled binary.

```bash
git clone https://github.com/kdr/overcast.git
cd overcast
npm ci                 # install (postinstall brands the pi base)
npm run build          # tsup (dev build) + web consoles
npm run typecheck      # tsc --noEmit for src + web/chair + web/situation
npm test               # unit tests (offline, fixtures — no creds/network)
npm run dev -- --help  # run the CLI from source (tsx)
```

Offline end-to-end tests use fixture providers and need no credentials:

```bash
npm run test:e2e       # offline e2e (bash test/e2e/run.sh)
```

The **live** suite (`npm run test:e2e:live`) hits real backends and needs keys —
see [`test/e2e/README.md`](test/e2e/README.md) and copy `.env.example` to `.env`
first. Never commit a real `.env` (it's git-ignored).

## Architecture invariants — please don't break these

overcast is built **on top of [pi](https://github.com/earendil-works/pi)** and is
organized around a single source of truth. [`CLAUDE.md`](CLAUDE.md) is the
detailed architecture guide (written for AI agents but accurate for humans) — the
invariants that matter most for contributors:

1. **Don't fork pi.** Reuse pi's loop, TUI, sessions, base tools, and provider
   layer. overcast attaches as a pi **package/extension**; net-new code is the
   verbs, providers, and record store.
2. **One verb spec → three surfaces.** Declare each verb **once** in
   `src/registry/verbs.ts`; the CLI subcommand, the pi AgentTool, and the skill
   doc are generated from it. `overcast commands --json` is the authoritative
   registry — verify against it, not memory.
3. **`skills/` is generated.** If you change the verb registry, regenerate with
   `overcast skills generate` and commit the result. CI fails if `skills/` is out
   of sync.
4. **Pinned dependencies stay pinned.** `@earendil-works/pi-*` are fixed at
   **exactly `0.82.1`**. Don't float them; a pi bump is a deliberate, reviewed
   change (Dependabot is configured to ignore them).
5. **The record is loose.** The output contract is
   `{ id, verb, format, payload, media?, meta?, error?, state? }` and nothing
   more. Map provider output to the record at the exec boundary; don't
   reintroduce a rigid envelope.
6. **BYO LLM.** Never hardcode the brain provider. Keep the *brain* provider and
   the *sense* providers separate.
7. **Providers are pluggable via manifests.** Add a source/sense by authoring a
   `provider.json` manifest, not by hand-listing it — see
   [`docs/providers.md`](docs/providers.md). ffmpeg is internal, not a provider.

When in doubt, match the surrounding code and keep pi touch-points isolated in
`src/extension/` and `src/registry/to-agent-tool.ts` so a pi bump has a small
blast radius.

## Security-sensitive code

Some areas carry hardening that has regression tests
(`test/unit/audit-hardening.test.ts`) — please keep them green and add cases when
you touch:

- **Outbound fetches** must go through `assertFetchHostAllowed` / the SSRF guard
  (`src/media/fetch.ts`). Don't add a new `fetch`/`curl`/`yt-dlp` path that skips
  it.
- **Spawning binaries** must pass arguments as an **argv array** (never a shell
  string; no `shell: true`). Assume filenames/URLs/refs are attacker-controlled.
- **Anything user-facing** (records, reports, logs, consoles) that can contain
  provider output must go through `redactSecrets`.
- **Untrusted content** (scraped, media) is a prompt-injection vector — see
  invariant #10 in CLAUDE.md.

## Adding a new source or sense provider

Providers live in the top-level `providers/` tree, each with a `provider.json`
manifest that the catalog scans at runtime. A new **OSINT source that reaches
PII** must be **opt-in and never a default binding**, and must be documented in
[`RESPONSIBLE_USE.md`](RESPONSIBLE_USE.md) with its legal constraints. See
[`docs/providers.md`](docs/providers.md) for the authoring walkthrough and
`overcast provider create` to scaffold one.

## Pull request checklist

Before opening a PR, please make sure:

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes (and `npm run test:e2e` if you touched providers/records).
- [ ] `skills/` is regenerated if you changed the verb registry.
- [ ] You didn't bump the pinned `@earendil-works/*` versions.
- [ ] New env vars/providers are documented in `.env.example` and the README.
- [ ] New PII-reaching sources are opt-in and noted in `RESPONSIBLE_USE.md`.
- [ ] Commits are signed off (see below).

CI runs typecheck, unit tests, offline e2e, the `skills/`-in-sync check, the
VS Code extension checks, and `shellcheck -S warning` on shell providers.

## Sign-off (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/).
Certify that you wrote (or have the right to submit) your contribution by adding a
`Signed-off-by` line to each commit:

```bash
git commit -s -m "your message"
```

## License

By contributing, you agree that your contributions will be licensed under the
project's [Apache-2.0 license](LICENSE).
