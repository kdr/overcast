// overcast screenshot engine — headless Chromium page render via Playwright.
// The ONE renderer behind both browser-capture surfaces: the `screenshot` verb
// (screenshot.sh run) and the `browser:` source (browser.sh fetch). Runs under
// system `node` (never inside the bun binary): `playwright` is an OPTIONAL npm
// dep resolved from this script's own location, so a missing install degrades
// to exit 13 (the exec-contract "missing deps" code → needs_credentials).
//
//   node render.mjs --emit record  --input <url|path.html> [--out <png>]
//                   [--full-page] [--viewport WxH] [--wait ms] [--timeout ms]
//   node render.mjs --emit capture --url <u> --out <png>   (source fetch path)
//
// --emit record  → a full overcast screenshot record (verb run path)
// --emit capture → the raw {kind,path,source,url} object fetchSource maps
//
// SSRF guard: pages here can originate in scraped OSINT refs (CLAUDE.md
// invariant #10, untrusted), and a headless browser bypasses the fetch-side
// assertFetchHostAllowed guard entirely — so this script re-implements the same
// policy (ported predicates from src/media/fetch.ts): block localhost, private/
// loopback/link-local/CGNAT IPv4 in every inet_aton encoding, IPv6 ULA/link-
// local/embedded-v4, and hostnames that RESOLVE to any of those. The check runs
// before navigation AND per request via route interception (a page can meta-
// refresh / JS-redirect / <img> to 169.254.169.254). Opt out only with an
// affirmative OVERCAST_ALLOW_PRIVATE_FETCH (1/true/yes/on) — same knob, same
// semantics, same accepted DNS-rebind TOCTOU residual as the fetch guard.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";

const NAV_TIMEOUT_DEFAULT = 30_000;
const NAV_TIMEOUT_MAX = 120_000;
const WAIT_MAX = 15_000;
// Overall self-imposed ceiling. The parent (runExecProvider/fetchSource) SIGKILLs
// this process when its budget (≥180s) expires — and SIGKILL can't run the
// finally that closes Chromium, orphaning the browser. So bound our own runtime
// comfortably UNDER that: finish or force-kill the browser and exit first. Capped
// at 165s (< the 180s verb budget); normally sized to nav+wait+slack per render.
const HARD_CAP_MAX = 165_000;
const VIEWPORT_DEFAULT = { width: 1280, height: 800 };
const VIEWPORT_MIN = 320;
const VIEWPORT_MAX = 4096;

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// Resolve the Chromium binary to launch. On managed cloud images (Claude Code on
// the web, some CI) a Chromium build is pre-installed under PLAYWRIGHT_BROWSERS_PATH
// with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, and its revision can differ from the one
// the installed `playwright` pins — so chromium.executablePath() points at a
// revision dir that doesn't exist and the default launch fails with "executable
// doesn't exist". Precedence: an explicit OVERCAST_PLAYWRIGHT_EXECUTABLE override,
// then playwright's own default (the normal local-dev path), then whatever chromium
// build actually IS on disk under PLAYWRIGHT_BROWSERS_PATH (the `chromium` symlink
// cloud images provide, else a scan of chromium-<rev>/ dirs). Returns undefined to
// let playwright try its default (preserving the existing missing-payload error).
function resolveChromiumExecutable(chromium) {
  const override = process.env.OVERCAST_PLAYWRIGHT_EXECUTABLE;
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
    // Otherwise scan the versioned browser dirs for a usable chrome build,
    // preferring full chrome over the headless shell. Two passes over ALL dirs
    // (full-chrome layouts first, headless_shell only as the fallback) so a full
    // chrome in any dir wins even when a chromium_headless_shell-<rev> dir sorts
    // earlier in readdir order.
    try {
      const dirs = readdirSync(root).filter((d) => /^chromium(_headless_shell)?-\d/.test(d));
      const layouts = [
        [
          ["chrome-linux", "chrome"],
          ["chrome-linux64", "chrome"],
          ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
        ],
        [
          ["chrome-linux", "headless_shell"],
          ["chrome-mac", "headless_shell"],
        ],
      ];
      for (const rels of layouts) {
        for (const d of dirs) {
          for (const rel of rels) {
            const bin = join(root, d, ...rel);
            if (isFile(bin)) return bin;
          }
        }
      }
    } catch {
      /* unreadable dir — give up, launch with the default */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// arg parsing (long flags only, mirroring the shipped provider scripts)

function parseArgs(argv) {
  const args = { emit: "record" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--emit": args.emit = next() ?? "record"; break;
      case "--input": args.input = next(); break;
      case "--url": args.input = next(); break; // fetch-path spelling
      case "--out": args.out = next(); break;
      case "--full-page": args.fullPage = true; break;
      case "--viewport": args.viewport = next(); break;
      case "--wait": args.wait = Number(next()); break;
      case "--timeout": args.timeout = Number(next()); break;
      case "--json": break; // output is always JSON
      default: break; // ignore unknown flags (forward-compat: --selector/--video later)
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// SSRF predicates — ported from src/media/fetch.ts (keep in sync)

/** Parse an IPv4 host in ANY inet_aton form (dotted/decimal/hex/octal, 1–4
 *  parts) into a 32-bit int, or null if it isn't an IPv4 literal. */
function parseLooseIPv4(host) {
  let h = host;
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "") return null;
  const parts = h.split(".");
  if (parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isInteger(n)) return null;
    nums.push(n);
  }
  const maxLast = [0, 0xffffffff, 0xffffff, 0xffff, 0xff][nums.length];
  if (nums[nums.length - 1] > maxLast) return null;
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 0xff) return null;
  let ip = 0;
  for (let i = 0; i < nums.length - 1; i++) ip = (ip | (nums[i] << (8 * (3 - i)))) >>> 0;
  return (ip | nums[nums.length - 1]) >>> 0;
}

/** Loopback / private / link-local (incl. cloud metadata) / CGNAT IPv4? */
function isBlockedIPv4(ip) {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  const c = (ip >>> 8) & 0xff;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4 (incl. broadcast)
  return false;
}

/** Expand an IPv6 literal (compressed / full / embedded-IPv4 tail) to 16 bytes. */
function ipv6ToBytes(host) {
  let s = host.toLowerCase().replace(/%.*$/, "");
  const v4m = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4m) {
    const v4 = parseLooseIPv4(v4m[2]);
    if (v4 === null) return null;
    s = `${v4m[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part) => {
    if (part === "") return [];
    const out = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  if (head === null) return null;
  let groups;
  if (halves.length === 2) {
    const tail = toGroups(halves[1]);
    if (tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >>> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

/** Loopback / unspecified / unique-local / link-local / blocked embedded-v4? */
function isBlockedIPv6(b) {
  let allZero = true;
  for (let i = 0; i < 15; i++) if (b[i] !== 0) { allZero = false; break; }
  if (allZero && (b[15] === 1 || b[15] === 0)) return true;
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
  let first10Zero = true;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) { first10Zero = false; break; }
  if (first10Zero && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    const v4 = ((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0;
    if (v4 !== 0 && isBlockedIPv4(v4)) return true;
  }
  return false;
}

function isBlockedHostLiteral(host) {
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const ip = parseLooseIPv4(h);
  if (ip !== null) return isBlockedIPv4(ip);
  const v6 = ipv6ToBytes(h);
  if (v6) return isBlockedIPv6(v6);
  return false;
}

function isIpLiteralHost(host) {
  const h = host.replace(/^\[/, "").replace(/\]$/, "");
  return parseLooseIPv4(h) !== null || ipv6ToBytes(h) !== null;
}

function allowPrivate() {
  const v = (process.env.OVERCAST_ALLOW_PRIVATE_FETCH ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** true = blocked. Resolves real hostnames (all A/AAAA) and fails CLOSED on a
 *  resolution error — the browser resolves independently and could still reach
 *  a private address.
 *
 *  NO verdict is cached — each call resolves fresh, exactly like
 *  assertFetchHostAllowed in fetch.ts. Caching an ALLOW would widen the
 *  DNS-rebind window (a host that rebinds public→private would skip re-check);
 *  caching a BLOCK is worse, because the fail-closed branch treats a TRANSIENT
 *  resolver glitch (NXDOMAIN/timeout) as blocked — caching that would wedge an
 *  otherwise-public host for the rest of the render. So fail closed PER ATTEMPT
 *  only. (The OS resolver caches real lookups, so re-resolving is cheap.) */
async function hostBlocked(host) {
  if (allowPrivate()) return false;
  if (isBlockedHostLiteral(host)) return true; // deterministic literal, no DNS
  if (isIpLiteralHost(host)) return false; // vetted public IP literal
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some(({ address }) => isBlockedHostLiteral(address));
  } catch {
    return true; // fail closed for THIS attempt only (never remembered)
  }
}

/** Is a file: URL confined to the local input's directory subtree? Blocks a local
 *  .html from reading absolute file:// paths (/etc/passwd, a sibling case's media,
 *  …) into the render. Resolves symlinks so a link inside the dir can't escape it. */
function fileWithinLocalDir(parsedUrl, localDirReal) {
  if (!localDirReal) return false; // not a local input → no file: allowed
  let p;
  try {
    p = fileURLToPath(parsedUrl);
  } catch {
    return false;
  }
  let real;
  try {
    real = realpathSync(p); // follow symlinks where the target exists
  } catch {
    real = resolve(p); // nonexistent target → lexical (will 404, but stays contained)
  }
  return real === localDirReal || real.startsWith(localDirReal + sep);
}

// ---------------------------------------------------------------------------
// Browser lifecycle: track the live browser so we can kill it even on paths that
// don't unwind through the `finally` — a catchable signal (SIGTERM/SIGHUP/SIGINT
// from the parent or a Ctrl-C) or the self-watchdog. SIGKILL can't be caught, so
// the watchdog exiting BEFORE the parent's budget is what prevents that orphan.

let activeBrowser = null;

/** Synchronously kill the browser PROCESS (not a graceful async close — usable
 *  from a signal handler / just before process.exit, where awaiting isn't safe). */
function killBrowserSync() {
  const b = activeBrowser;
  activeBrowser = null;
  try {
    b?.process()?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

for (const s of ["SIGTERM", "SIGHUP", "SIGINT"]) {
  process.on(s, () => {
    killBrowserSync();
    process.exit(1);
  });
}

function fail(msg, code = 1) {
  killBrowserSync();
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function parseViewport(spec) {
  if (!spec) return { ...VIEWPORT_DEFAULT };
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(spec.trim());
  if (!m) return null;
  const clamp = (n) => Math.min(Math.max(n, VIEWPORT_MIN), VIEWPORT_MAX);
  return { width: clamp(Number(m[1])), height: clamp(Number(m[2])) };
}

/** Default output path when --out is omitted (the verb run path): a stable,
 *  flag-aware name in the case media dir, like fetchMediaToCase's url-<sha>. */
function defaultOutPath(input, fullPage, viewport) {
  const mediaDir = process.env.OVERCAST_MEDIA_DIR;
  if (!mediaDir) fail("render.mjs: no --out and no OVERCAST_MEDIA_DIR — cannot pick an output path");
  const sig = createHash("sha1")
    .update(`${input}|${fullPage ? "full" : "vp"}|${viewport.width}x${viewport.height}`)
    .digest("hex")
    .slice(0, 12);
  return join(mediaDir, `shot-${sig}.png`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.emit !== "record" && args.emit !== "capture") fail(`render.mjs: unknown --emit '${args.emit}' (record|capture)`);
  if (!args.input) fail("render.mjs: --input <url|path.html> (or --url) is required");

  const viewport = parseViewport(args.viewport);
  if (!viewport) fail(`render.mjs: bad --viewport '${args.viewport}' (expected WxH, e.g. 1280x800)`);
  const wait = Number.isFinite(args.wait) && args.wait > 0 ? Math.min(args.wait, WAIT_MAX) : 0;
  const timeout = Number.isFinite(args.timeout) && args.timeout > 0
    ? Math.min(args.timeout, NAV_TIMEOUT_MAX)
    : NAV_TIMEOUT_DEFAULT;

  // Resolve the target: an http(s) URL, or a LOCAL .html file (a wall/map/brief
  // export) rendered via file://. Anything else is refused — the engine renders
  // pages, it does not open arbitrary local files in a browser.
  const isHttp = /^https?:\/\//i.test(args.input);
  let target;
  let localInput = false;
  let localDirReal = null; // realpath'd dir the local .html lives in — the file: sandbox root
  if (isHttp) {
    let parsed;
    try {
      parsed = new URL(args.input);
    } catch {
      fail(`render.mjs: not a valid URL: ${args.input}`);
    }
    if (await hostBlocked(parsed.hostname)) {
      fail(`refusing to render a private/loopback address (${parsed.hostname}); set OVERCAST_ALLOW_PRIVATE_FETCH=1 to allow: ${args.input}`);
    }
    target = parsed.href;
  } else {
    const p = isAbsolute(args.input) ? args.input : resolve(args.input);
    if (!existsSync(p)) fail(`render.mjs: file not found: ${p}`);
    if (!/\.x?html?$/i.test(extname(p))) fail(`render.mjs: local input must be an .html file (got ${basename(p)})`);
    // realpath so the containment check on file: subresources can't be escaped
    // via a symlinked input dir; the .html's directory is the ONLY subtree its
    // file:// assets may read from (see the route handler).
    const real = realpathSync(p);
    localDirReal = dirname(real);
    target = pathToFileURL(real).href;
    localInput = true;
  }

  // Always a PNG → force a .png extension. The source fetch path passes an
  // EXTENSIONLESS --out (or one whose "extension" is a URL host TLD like `.com`,
  // which fetchSource's ensureMediaExtension then can't fix), which would leave a
  // PNG under a non-image name and defeat isImage()/auto-sense. Writing to a .png
  // path and reporting it lets fetchSource prefer the correct file.
  const rawOut = args.out ?? defaultOutPath(args.input, !!args.fullPage, viewport);
  const out = /\.png$/i.test(rawOut) ? rawOut : `${rawOut}.png`;
  mkdirSync(dirname(out), { recursive: true });

  // Self-watchdog: bound the whole render to nav+wait+slack (capped at HARD_CAP_MAX,
  // < the parent budget) so we force-kill the browser and exit before the parent
  // can SIGKILL us and orphan Chromium. fail() runs killBrowserSync().
  const hardCap = Math.min(timeout + wait + 20_000, HARD_CAP_MAX);
  const watchdog = setTimeout(() => fail(`screenshot: render exceeded ${hardCap}ms — aborted`, 1), hardCap);

  // Playwright is optional (package.json optionalDependencies) — resolved from
  // this script's location (the package's node_modules). Missing install →
  // exit 13, the exec-contract missing-deps code (→ needs_credentials record).
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail(
      "screenshot needs Playwright + Chromium (optional dep): run `npm install --include=optional` and `npx playwright install chromium`",
      13,
    );
  }

  let browser;
  try {
    try {
      const executablePath = resolveChromiumExecutable(chromium);
      browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      activeBrowser = browser; // now killable by the watchdog / signal handlers
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      // playwright installed but the browser payload missing → same setup-gap code
      if (/executable doesn't exist|browserType.launch/i.test(msg)) {
        fail(`screenshot: Chromium payload missing — run \`npx playwright install chromium\` (${msg.split("\n")[0]})`, 13);
      }
      throw e;
    }
    // Block service workers: they bypass route interception, which is the
    // per-request half of the SSRF guard.
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    // Per-request guard: navigation redirects, meta-refresh, JS redirects, and
    // subresources all pass through here. Other schemes (data:, blob:, about:) are
    // inert for SSRF purposes.
    await context.route("**/*", async (route) => {
      const u = route.request().url();
      let parsed;
      try {
        parsed = new URL(u);
      } catch {
        return route.abort();
      }
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        if (await hostBlocked(parsed.hostname)) return route.abort();
        return route.continue();
      }
      // file:// only for a local .html input, and ONLY within that file's own
      // directory subtree — an untrusted export must not pull `file:///etc/passwd`
      // or other absolute paths into the render (and thus the PNG evidence).
      if (parsed.protocol === "file:") return fileWithinLocalDir(parsed, localDirReal) ? route.continue() : route.abort();
      return route.continue();
    });
    // WebSocket guard: context.route above does NOT intercept ws/wss — a rendered
    // (untrusted, invariant #10) page could otherwise open a socket straight to a
    // private/internal host, bypassing the HTTP guard. Route every WebSocket:
    // connect through to the server ONLY for an allowed host; a blocked host is
    // closed and never reaches the real server (connectToServer is never called).
    await context.routeWebSocket(/.*/, async (ws) => {
      let host;
      try {
        host = new URL(ws.url()).hostname;
      } catch {
        return ws.close({ code: 1008, reason: "blocked" });
      }
      if (await hostBlocked(host)) return ws.close({ code: 1008, reason: "blocked" });
      ws.connectToServer();
    });

    const page = await context.newPage();
    let settled = true;
    try {
      await page.goto(target, { waitUntil: "networkidle", timeout });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      // networkidle can time out on pages that poll forever — the loaded state
      // is still the evidence, so capture it. A hard nav failure is an error.
      if (/Timeout.*exceeded/i.test(msg) && !page.url().startsWith("about:")) {
        settled = false;
      } else {
        // THROW rather than fail() here: fail() calls process.exit(), which skips
        // the enclosing `finally` and would leak the headless Chromium process on
        // a hard nav error. Throwing runs the finally (browser.close) and is
        // reported by main().catch → fail() with the same exit 1 / error record.
        throw new Error(`could not load ${args.input}: ${msg.split("\n")[0]}`);
      }
    }
    if (wait > 0) await page.waitForTimeout(wait);
    // type:"png" explicit so Playwright never infers it from the extension — the
    // source fetch path (--emit capture) passes an EXTENSIONLESS --out that
    // fetchSource sniffs + renames to .png afterward, and extension inference
    // would otherwise throw "unsupported mime type" on it.
    await page.screenshot({ path: out, type: "png", fullPage: !!args.fullPage });
    const title = (await page.title().catch(() => "")) || "";

    const vp = `${viewport.width}x${viewport.height}`;
    if (args.emit === "capture") {
      // the raw object fetchSource maps into a capture record
      process.stdout.write(`${JSON.stringify({ kind: "image", path: out, source: "browser", url: args.input, title })}\n`);
    } else {
      const mode = args.fullPage ? "full page" : `${vp} viewport`;
      const summary = `${title ? `${title} — ` : ""}${args.input} (${mode}${settled ? "" : ", capture before settle"})`;
      process.stdout.write(
        `${JSON.stringify({
          verb: "screenshot",
          format: "json",
          payload: {
            summary,
            url: args.input,
            title: title || null,
            kind: "image",
            source: "browser",
            full_page: !!args.fullPage,
            viewport: vp,
            ...(wait > 0 ? { wait } : {}),
            ...(settled ? {} : { settled: false }),
          },
          media: { ref: out },
          meta: { provider: "playwright" },
          state: "ready",
        })}\n`,
      );
    }
  } finally {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
    activeBrowser = null;
  }
}

main().catch((e) => fail(`screenshot render failed: ${String(e && e.message ? e.message : e).split("\n")[0]}`));
