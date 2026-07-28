// Regression probe for the screenshot engine's redirect SSRF bypass
// (CLAUDE-SECURITY-20260728-174023 finding F2).
//
// WHAT THIS PROVES, precisely:
//   1. Playwright does NOT invoke a context.route() handler for the request it
//      makes when FOLLOWING an HTTP 3xx. So a handler that validates the host and
//      then calls route.continue() — which is what render.mjs used to do — lets a
//      permitted origin redirect straight into a blocked one.
//   2. The per-hop pattern render.mjs now uses (route.fetch({maxRedirects: 0}),
//      validate each Location, then route.fulfill) catches that hop.
//   3. An ordinary 200 response still renders through the fulfil path (no
//      regression for normal pages).
//
// It substitutes a PORT-based predicate for hostBlocked(): both servers are on
// loopback, because a test cannot host a genuinely public origin. The question
// this answers is about Playwright's interception semantics, which the port
// stand-in exercises faithfully. The host-classification logic itself is covered
// by the unit tests in test/unit/security-hardening.test.ts.
//
// Run: node test/e2e/live/ssrf-redirect-probe.mjs   (exit 0 = pass)

import http from "node:http";
import { readFileSync } from "node:fs";

const PORT_OK = Number(process.env.OC_PROBE_PORT_OK ?? 8481);
const PORT_BAD = Number(process.env.OC_PROBE_PORT_BAD ?? 8482);
const SECRET = "OC-PROBE-SECRET-THAT-MUST-NOT-RENDER";
const MAX_REDIRECT_HOPS = 5;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("SKIP: playwright not resolvable");
  process.exit(0);
}

const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const ok = http.createServer((req, res) => {
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: `http://127.0.0.1:${PORT_BAD}/secret` });
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body><h1>PROBE-PUBLIC-PAGE</h1></body></html>");
});
const bad = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<html><body><h1>${SECRET}</h1></body></html>`);
});
await new Promise((r) => ok.listen(PORT_OK, "127.0.0.1", r));
await new Promise((r) => bad.listen(PORT_BAD, "127.0.0.1", r));

const blocked = (u) => {
  try {
    return new URL(u).port === String(PORT_BAD);
  } catch {
    return true;
  }
};

async function render({ perHop }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const aborted = [];
    await context.route("**/*", async (route) => {
      const u = route.request().url();
      if (blocked(u)) {
        aborted.push(u);
        return route.abort();
      }
      if (!perHop) return route.continue(); // the pre-fix shape
      let res;
      try {
        res = await route.fetch({ maxRedirects: 0 });
      } catch {
        return route.abort();
      }
      for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
        const status = res.status();
        if (status < 300 || status >= 400) break;
        const loc = res.headers()["location"];
        if (!loc) break;
        let next;
        try {
          next = new URL(loc, res.url());
        } catch {
          return route.abort();
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") return route.abort();
        if (blocked(next.href)) {
          aborted.push(next.href);
          return route.abort();
        }
        try {
          res = await route.fetch({ url: next.href, maxRedirects: 0 });
        } catch {
          return route.abort();
        }
      }
      return route.fulfill({ response: res });
    });
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${PORT_OK}/redirect`, { waitUntil: "load", timeout: 10_000 });
    } catch {
      /* a blocked hop makes goto reject — that is the success path */
    }
    const body = await page.content().catch(() => "");
    return { leaked: body.includes(SECRET), aborted };
  } finally {
    await browser.close().catch(() => {});
  }
}

console.log("ssrf-redirect-probe:");

// 1. the vulnerability is real without per-hop validation
const before = await render({ perHop: false });
check(
  "redirect.bypass_reproduces",
  before.leaked && before.aborted.length === 0,
  `plain route.continue() leaked=${before.leaked}, handler saw 0 aborts`,
);

// 2. the shipped pattern catches it
const after = await render({ perHop: true });
check(
  "redirect.per_hop_blocks",
  !after.leaked && after.aborted.length > 0,
  `leaked=${after.leaked}, aborted ${after.aborted.length} hop(s)`,
);

// 3. a normal page still renders through fulfil
{
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.route("**/*", async (route) => {
    let res;
    try {
      res = await route.fetch({ maxRedirects: 0 });
    } catch {
      return route.abort();
    }
    return route.fulfill({ response: res });
  });
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${PORT_OK}/`, { waitUntil: "load", timeout: 10_000 });
  const html = await p.content();
  check("redirect.normal_page_renders", html.includes("PROBE-PUBLIC-PAGE"), "200 page unaffected");
  await browser.close();
}

// 4. render.mjs still USES the per-hop pattern (catches a revert to route.continue)
{
  const src = readFileSync(new URL("../../../providers/engines/screenshot/render.mjs", import.meta.url), "utf8");
  check(
    "redirect.engine_uses_per_hop",
    /route\.fetch\(\{\s*maxRedirects:\s*0\s*\}\)/.test(src) && /MAX_REDIRECT_HOPS/.test(src),
    "render.mjs drives redirects itself",
  );
  check(
    "redirect.engine_rechecks_final_url",
    /refusing to capture a private\/loopback address/.test(src),
    "render.mjs re-checks the committed URL before the screenshot",
  );
}

ok.close();
bad.close();

if (failures.length) {
  console.log(`ssrf-redirect-probe: ${failures.length} FAILED (${failures.join(", ")})`);
  process.exit(1);
}
console.log("ssrf-redirect-probe: all checks passed");
