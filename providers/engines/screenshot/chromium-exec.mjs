// Shared Chromium-executable resolution for the screenshot engine — the ONE
// implementation behind render.mjs (launch), `screenshot.sh init` (probe), and
// `overcast doctor`'s playwright check (src/verbs/setup.ts), so layout or
// precedence fixes land in exactly one place.
//
// On managed cloud images (Claude Code on the web, some CI) a Chromium build is
// pre-installed under PLAYWRIGHT_BROWSERS_PATH with
// PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, and its revision can differ from the one
// the installed `playwright` pins — so chromium.executablePath() points at a
// revision dir that doesn't exist and the default launch fails with "executable
// doesn't exist". Precedence: an explicit OVERCAST_PLAYWRIGHT_EXECUTABLE
// override, then playwright's own default (the normal local-dev path), then
// whatever chromium build actually IS on disk under PLAYWRIGHT_BROWSERS_PATH
// (the `chromium` symlink cloud images provide, else a scan of the versioned
// dirs). Returns undefined to let playwright try its default (preserving the
// existing missing-payload error).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// Per-platform executable layouts lifted from playwright's own registry
// (EXECUTABLE_PATHS, playwright-core 1.61): the current chrome-for-testing
// dirs plus the legacy non-cft layouts older cloud-image revisions still use.
// Full-chrome layouts scan strictly BEFORE any headless_shell fallback.
const CHROME_LAYOUTS = [
  ["chrome-linux64", "chrome"], // cft linux-x64
  ["chrome-linux", "chrome"], // linux-arm64 + legacy linux
  ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
  ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
  ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"], // legacy mac
];
const HEADLESS_LAYOUTS = [
  ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  ["chrome-linux", "headless_shell"], // linux-arm64 + legacy linux
  ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
];

/** Scan PLAYWRIGHT_BROWSERS_PATH-style version dirs for a launchable build.
 *  Deterministic: full chrome beats headless_shell across ALL dirs, and within
 *  each pass NEWEST revision wins (never readdir order). */
function scanBrowsersDir(root) {
  let dirs;
  try {
    dirs = readdirSync(root)
      .map((d) => {
        const m = /^chromium(_headless_shell)?-(\d+)$/.exec(d);
        return m ? { d, rev: Number(m[2]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.rev - a.rev)
      .map((e) => e.d);
  } catch {
    return undefined; // unreadable dir — give up, launch with the default
  }
  for (const layouts of [CHROME_LAYOUTS, HEADLESS_LAYOUTS]) {
    for (const d of dirs) {
      for (const rel of layouts) {
        const bin = join(root, d, ...rel);
        if (isFile(bin)) return bin;
      }
    }
  }
  return undefined;
}

export function resolveChromiumExecutable(chromium) {
  // trim: cloud Secrets commonly append a trailing newline/space, which would
  // silently fail the file check (same normalization the DIRECT_EGRESS knob gets)
  const override = (process.env.OVERCAST_PLAYWRIGHT_EXECUTABLE ?? "").trim();
  if (override && isFile(override)) return override;
  try {
    const def = chromium.executablePath();
    if (def && existsSync(def)) return def;
  } catch {
    /* playwright present but no browser registered — fall through to the scan */
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    // Cloud images expose a stable `chromium` symlink pointing straight at the
    // pre-installed chrome binary (e.g. /opt/pw-browsers/chromium).
    const symlinked = join(root, "chromium");
    if (isFile(symlinked)) return symlinked;
    return scanBrowsersDir(root);
  }
  return undefined;
}
