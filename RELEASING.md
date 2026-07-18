# Releasing overcast

overcast ships from one source tree to four places on every release:

- **npm** — `@kdrrr/overcast` (the CLI + pi package), published from CI via **npm
  OIDC trusted publishing** (no tokens, provenance attached automatically).
- **GitHub Releases** — the standalone **bun binary**, cross-compiled for macOS
  (arm64/x64) and Linux (x64/arm64) and attached as
  `overcast-<os>-<arch>.tar.gz`.
- **VS Code Marketplace + Open VSX** — the **VS Code extension**
  (`kdrrr.overcast`), published from CI with the `VSCE_PAT` / `OVSX_PAT`
  secrets (each step skips when its secret is absent or the version is already
  live). Open VSX serves Cursor/VSCodium/Windsurf users.
- **GitHub Releases** — the same extension packaged as
  `overcast-<version>.vsix` (install via `code --install-extension …` or
  "Install from VSIX…" in the Extensions view).
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
- `vscode/package.json` + `vscode/package-lock.json` (the `.vsix` rides the
  release train, so the extension version always matches the CLI it pairs with)

(`scripts/bun-sidecar.mjs` reads `package.json` directly, so it needs no sync.)

This is wired to the npm `version` lifecycle, so **`npm version <patch|minor|x.y.z>`
bumps + syncs every surface at once** (pass `--no-git-tag-version` in the PR-based
release flow below to skip the auto commit/tag). CI also runs `node
scripts/sync-version.mjs --check` and fails on drift, so the surfaces can never
silently diverge.

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
to npm (`npm whoami` → an account that owns the `@kdrrr` scope, i.e. a member of
the `kdrrr` org with publish rights):

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

## One-time setup: VS Code Marketplace + Open VSX (maintainer, in a browser)

Unlike npm's OIDC, the Marketplace has no publish-once bootstrap requirement —
once the publisher and secret exist, CI can do the very first publish. Until
then the publish steps log a skip and the release still succeeds.

1. Create an [Azure DevOps organization](https://dev.azure.com) (the
   Marketplace authenticates through it), then create the **`kdrrr`
   publisher** on <https://marketplace.visualstudio.com/manage>. The publisher
   id must match `publisher` in `vscode/package.json` (`kdrrr` — same story as
   npm: `kdr` is already taken on the Marketplace, we ship under `kdrrr`
   everywhere).
2. Create a PAT with **Marketplace → Manage** scope and store it as the
   `VSCE_PAT` repo secret. Make it an **org-scoped** PAT — Azure DevOps
   *global* PATs retire **Dec 1 2026**. Sanity-check it without publishing:
   `npx @vscode/vsce verify-pat kdrrr`.
3. Optionally (for Cursor/VSCodium/Windsurf users): create an
   [Open VSX](https://open-vsx.org) account, sign the publisher agreement,
   create the `kdrrr` namespace (`npx ovsx create-namespace kdrrr -p <token>`),
   and store the token as the `OVSX_PAT` repo secret.

The next `v*` tag then publishes the extension automatically. To put the
listing live without waiting for a release train, publish the current release's
`.vsix` by hand: `npx @vscode/vsce publish --packagePath overcast-<v>.vsix -p
<pat>` (or upload it on the manage page). Marketplace ingestion runs a malware
scan; the listing goes live a few minutes after publish.

---

## Cutting a release (0.0.1 and onward)

`main` is protected (changes must go through a PR), so the version-bump **commit**
lands via a PR and the **tag** is pushed afterward — the tag push is what triggers
the release, and tags aren't covered by the branch rule.

**1. Bump + sync on a release branch** (no commit/tag yet):

```bash
git checkout main && git pull
git checkout -b release-vX.Y.Z
npm version X.Y.Z --no-git-tag-version   # patch / minor / major / x.y.z
node scripts/sync-version.mjs --check     # all surfaces match (should already)
```

`--no-git-tag-version` edits + syncs every surface (`package.json`,
`package-lock.json`, `src/version.ts`, both `.claude-plugin/*.json`, and the
`vscode/` package + lockfile) **without** committing or tagging.

**2. Open + merge the PR** (squash or merge — either is fine; step 3 tags `main`
*after* it lands, so the tagged commit is always whatever ends up on `main`):

```bash
git commit -am "Release vX.Y.Z"
git push -u origin release-vX.Y.Z
gh pr create --base main --fill
# …review, then merge it.
```

**3. Tag the merged commit on `main` and push the tag:**

```bash
git checkout main && git pull
git tag vX.Y.Z && git push origin vX.Y.Z
```

Pushing the `vX.Y.Z` tag triggers `release.yml`, which:

1. Verifies the tag matches `package.json` and that versions are in sync.
2. Installs ffmpeg, runs `typecheck` → `build` → `--version` smoke → unit tests.
3. **Publishes to npm** over OIDC (skipped if that version is already on npm).
4. Cross-compiles the bun binary for the four targets and attaches the tarballs
   to the GitHub Release for the tag.
5. Builds + tests the VS Code extension, attaches `overcast-<version>.vsix` to
   the same Release, and publishes it to the **VS Code Marketplace** and
   **Open VSX** (each step skips if its secret is missing or the version is
   already live there).

You can also run it manually from the Actions tab (**workflow_dispatch**) with the
version as input; in that mode the binaries are uploaded as workflow artifacts
instead of release assets.

> **Why not `npm version patch && git push --follow-tags`?** That pushes the bump
> commit straight to `main`, which the PR rule rejects (`GH013: Changes must be
> made through a pull request`) — though the tag (and thus the publish) still goes
> through, leaving `main` behind the tag. If you'd rather keep the one-liner, add
> an admin **bypass** for the `main` ruleset (Settings → Rules) instead of the PR
> flow above.

**Shipping one PR's change as a patch?** You can skip the dedicated
`release-vX.Y.Z` branch and fold the bump into that PR: run `npm version X.Y.Z
--no-git-tag-version` on the feature branch, commit it alongside the change, then
tag `main` after the PR merges (step 3 above). One PR instead of two.

---

## Verify a release

```bash
npm view @kdrrr/overcast version                 # the published version
npm i -g @kdrrr/overcast@latest && overcast --version --json
```

- Binaries: download a tarball from the release, `tar -xzf …`, run `./overcast --version`.
- VS Code extension: `npx @vscode/vsce show kdrrr.overcast` shows the published
  version (or check the
  [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=kdrrr.overcast)
  and [Open VSX](https://open-vsx.org/extension/kdrrr/overcast)). To verify the
  release asset itself: download the `.vsix`, `code --install-extension
  overcast-<version>.vsix`, open the Overcast view.
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
- **`GH013` / "Changes must be made through a pull request"** when pushing the
  version commit → `main` requires a PR. Use the PR-based flow above (the tag
  pushes fine on its own), or add an admin bypass to the `main` ruleset.
- **2FA on the bootstrap publish** → `npm publish --otp=<code>`.
- **Marketplace publish 401/403** → the PAT expired, lacks the Marketplace →
  Manage scope, or belongs to a different org than the `kdrrr` publisher.
  `npx @vscode/vsce verify-pat kdrrr` checks credentials without publishing.
- **Re-running a release tag** → safe; the npm, Marketplace, and Open VSX
  publish steps each no-op when the version is already live, and binary assets
  are overwritten.
