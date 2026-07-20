#!/usr/bin/env bash
# overcast `screenshot` provider — render a web page (or a local .html export)
# to a PNG via headless Chromium (Playwright). Default backend for the
# `screenshot` verb AND the engine behind the `browser:` source
# (providers/sources/browser/browser.sh delegates here).
# Contract: init | describe | run --input <url|path.html> [--out <png>]
#             [--full-page] [--viewport WxH] [--wait ms] [--timeout ms] --json
#           | fetch --url <u> --out <p>       (the source capture path)
# Needs: system `node` (override: OVERCAST_NODE) + the `playwright` optional
# npm dep with the Chromium payload — `npm install --include=optional` then
# `npx playwright install chromium`. Missing deps exit 13 (needs_credentials),
# never a hard error. Private/loopback targets are refused by default
# (OVERCAST_ALLOW_PRIVATE_FETCH=1 to allow — same knob as the fetch guard).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
render="$here/render.mjs"

# node resolution: OVERCAST_NODE (path or wrapper, may carry args) else PATH.
read -r -a NODE_CMD <<< "${OVERCAST_NODE:-node}"

need_node() {
  command -v "${NODE_CMD[0]}" >/dev/null 2>&1 || {
    echo "screenshot needs node (not found on PATH; set OVERCAST_NODE to a node binary)" >&2
    exit 13
  }
}

op="${1:-run}"; shift || true
case "$op" in
  init)
    need_node
    # same probe as `overcast doctor` (setup.ts): playwright resolvable + the
    # Chromium payload on disk. Runs from the engine dir so node resolves the
    # optional dep from the package's node_modules, like render.mjs does.
    # Mirrors resolveChromiumExecutable() in render.mjs (and setup.ts doctor):
    # override → playwright default → a build actually on disk under
    # PLAYWRIGHT_BROWSERS_PATH (the cloud `chromium` symlink, else a rev scan).
    probe='const { existsSync, statSync, readdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
      try {
        const { chromium } = await import("playwright");
        let p = process.env.OVERCAST_PLAYWRIGHT_EXECUTABLE;
        if (!(p && isFile(p))) {
          p = undefined;
          try { const d = chromium.executablePath(); if (d && existsSync(d)) p = d; } catch {}
          const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
          if (!p && root && existsSync(root)) {
            if (isFile(join(root, "chromium"))) p = join(root, "chromium");
            else {
              const dirs = readdirSync(root).filter((d) => /^chromium(_headless_shell)?-\d/.test(d));
              const layouts = [
                [["chrome-linux","chrome"],["chrome-linux64","chrome"],["chrome-mac","Chromium.app","Contents","MacOS","Chromium"]],
                [["chrome-linux","headless_shell"],["chrome-mac","headless_shell"]],
              ];
              outer: for (const rels of layouts) for (const d of dirs) for (const r of rels) {
                const b = join(root, d, ...r); if (isFile(b)) { p = b; break outer; }
              }
            }
          }
        }
        if (!p) throw new Error("Chromium browser payload missing");
        console.log(p);
      } catch (e) {
        console.error(e && e.message ? e.message : String(e));
        process.exit(13);
      }'
    if ! out="$(cd "$here" && "${NODE_CMD[@]}" -e "$probe" 2>&1)"; then
      printf '%s\n' "$out" | head -1 >&2
      echo "run \`npm install --include=optional\` and \`npx playwright install chromium\`" >&2
      exit 13
    fi
    exit 0
    ;;
  describe)
    echo '{"verb":"screenshot","kind":"web.screenshot","payload":["summary","url","title","full_page","viewport"],"needs":["node","playwright","chromium"]}'
    exit 0
    ;;
  run)
    need_node
    exec "${NODE_CMD[@]}" "$render" --emit record "$@"
    ;;
  fetch)
    need_node
    exec "${NODE_CMD[@]}" "$render" --emit capture "$@"
    ;;
  *)
    echo "screenshot provider: unknown op '$op' (expected run|fetch|init|describe)" >&2
    exit 2
    ;;
esac
