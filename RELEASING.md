# Releasing overcast

overcast ships from one source tree to three places on every release:

- **npm** — `@kdrrr/overcast` (the CLI + pi package), published from CI via **npm
  OIDC trusted publishing** (no tokens, provenance attached automatically).
- **GitHub Releases** — the standalone **bun binary**, cross-compiled for macOS
  (arm64/x64) and Linux (x64/arm64) and attached as
  `overcast-<os>-<arch>.tar.gz`.
- **Claude plugin + agent skills** — the `.claude-plugin/` manifests and
  `skills/` are read straight from the repo (GitHub), so they go live when the
  release commit lands on the default branch.

The whole thing is driven by **pushing a `v*` tag**. The workflow is
[`.github/workflows/release.yml`](.github/workflows/release.yml).

---

## Versioning is single-sourced

`package.json` `version` is the source of truth. `scripts/sync-version.mjs`
propagates it into the files that hard-code a version:

- `src/version.ts` (`OVERCAST_VERSION`)
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json` (`metadata.version` + every `plugins[].version`)

(`scripts/bun-sidecar.mjs` reads `package.json` directly, so it needs no sync.)

This is wired to the npm `version` lifecycle, so **`npm version <patch|minor|x.y.z>`
bumps everything at once** and stages it into the version commit. CI also runs
`node scripts/sync-version.mjs --check` and fails on drift, so the surfaces can
never silently diverge.

---

## One-time setup: npm Trusted Publisher (maintainer, in a browser)

Trusted publishing can only be configured **after the package's first version
exists on npm** (chicken-and-egg). So the very first publish is manual (below);
after that, configure OIDC once and CI takes over.

On <https://www.npmjs.com/package/@kdrrr/overcast/access> → **Trusted Publisher** →
**GitHub Actions**, enter:

| Field             | Value              |
| ----------------- | ------------------ |
| Organization/user | `kdr`              |
| Repository        | `overcast`         |
| Workflow filename | `release.yml`      |
| Environment       | _(leave blank)_    |

No `NPM_TOKEN` secret is needed in GitHub — OIDC mints a short-lived credential
per run. The repo is public, so npm provenance is generated automatically.

---

## First publish (bootstrap 0.0.0) — manual, one time only

OIDC isn't available yet, so publish the initial version from a machine logged in
to npm (`npm whoami` → an account with write access to the `@kdr` scope):

```bash
npm run build                 # produce dist/ (prepublishOnly also runs this)
npm pack --dry-run            # sanity-check the tarball contents + the @kdrrr/overcast name
npm publish                   # publishConfig sets access:public (provenance is CI-only)
```

Then configure the Trusted Publisher (section above), and cut the matching tag so
the binaries + GitHub Release get built by CI:

```bash
git tag v0.0.0 && git push origin v0.0.0
```

The `release.yml` run for `v0.0.0` will **skip the npm publish** (0.0.0 already
exists — the publish step is idempotent) and just build + attach the binaries.

---

## Cutting a release (0.0.1 and onward)

From a clean default branch:

```bash
npm version patch             # or: minor / major / 0.3.0  → bumps + syncs + commits + tags vX.Y.Z
git push --follow-tags        # push the commit and the tag together
```

Pushing the `vX.Y.Z` tag triggers `release.yml`, which:

1. Verifies the tag matches `package.json` and that versions are in sync.
2. Installs ffmpeg, runs `typecheck` → `build` → `--version` smoke → unit tests.
3. **Publishes to npm** over OIDC (skipped if that version is already on npm).
4. Cross-compiles the bun binary for the four targets and attaches the tarballs
   to the GitHub Release for the tag.

You can also run it manually from the Actions tab (**workflow_dispatch**) with the
version as input; in that mode the binaries are uploaded as workflow artifacts
instead of release assets.

---

## Verify a release

```bash
npm view @kdrrr/overcast version                 # the published version
npm i -g @kdrrr/overcast@latest && overcast --version --json
```

- Binaries: download a tarball from the release, `tar -xzf …`, run `./overcast --version`.
- Provenance: the npm package page shows a "Provenance" panel linking back to the run.
- Plugin/skills: `/plugin marketplace add kdr/overcast` then `/plugin install overcast@overcast`,
  or `npx skills add kdr/overcast`.

---

## Troubleshooting

- **`npm publish` 403 / "you must be logged in"** on a normal release → the
  Trusted Publisher isn't configured (or the workflow filename/repo doesn't match
  what's registered on npm). Re-check the table above.
- **`E404` configuring the Trusted Publisher** → the package doesn't exist yet; do
  the manual bootstrap publish first.
- **Version-drift CI failure** → run `npm run sync-version` and commit.
- **2FA on the bootstrap publish** → `npm publish --otp=<code>`.
- **Re-running a release tag** → safe; the publish step no-ops when the version is
  already on npm, and binary assets are overwritten.
