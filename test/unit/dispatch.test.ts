// Unit coverage for the `dispatch` source (police CAD / calls-for-service on the
// Socrata SODA API — PR #100). Two design decisions drove the tests:
//   1. media.ref is a STABLE per-row SODA deep link (?<idcol>=… or ?$where=:id='…'),
//      keyed on the row's Socrata :id / id column — NOT the array position, so the
//      monitor seen-set dedups a row the same way no matter where it lands in a page.
//   2. --since crosses the shared `normalizeSince` seam before reaching the shell
//      provider, so a CLI-valid ISO datetime becomes a form dispatch.sh's parser
//      accepts (rather than tripping its fail-closed error).
// The ref→domain/dataset tokenization itself lives in the shell script
// (providers/sources/dispatch.sh) and is exercised end-to-end by the live
// 20_sources dispatch block; here we cover the TS seams the source crosses:
// the built-in descriptor, the normalizeSince rewrite, and the enumerate→record
// mapping boundary (media.ref stability + top-level gps).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinDescriptor,
  enumerateSource,
  normalizeSince,
  APIFY_RUN_SYNC_TIMEOUT_MS,
} from "../../src/providers/sources/index.ts";

// ---- built-in descriptor ------------------------------------------------------

test("builtinDescriptor resolves the shipped dispatch source (keyless, default budget)", () => {
  const d = builtinDescriptor("dispatch");
  assert.ok(d, "dispatch descriptor present in dev");
  assert.match(d!.base.join(" "), /dispatch\.sh$/);
  assert.equal(d!.base[0], "bash");
  // dispatch is a keyless Socrata source — its `needs` must say so (optional
  // SOCRATA_APP_TOKEN only raises rate limits), never claim a required key.
  assert.match(d!.needs ?? "", /Socrata|SODA/);
  assert.match(d!.needs ?? "", /SOCRATA_APP_TOKEN/);
  // a fast HTTP source → the DEFAULT (undefined) exec budget, not the Apify
  // run-sync one (a wrong budget would 300s-block or prematurely kill it).
  assert.equal(d!.timeoutMs, undefined);
  assert.notEqual(d!.timeoutMs, APIFY_RUN_SYNC_TIMEOUT_MS);
});

test("builtinDescriptor: OVERCAST_SOURCE_DISPATCH_CMD rebinds the command, keeps type semantics", () => {
  process.env.OVERCAST_SOURCE_DISPATCH_CMD = 'bash "/x y/dispatch.sh"';
  try {
    const d = builtinDescriptor("dispatch");
    assert.ok(d);
    assert.equal(d!.type, "dispatch");
    // quote-aware tokenization of the override (a spaced path stays one arg)
    assert.deepEqual(d!.base, ["bash", "/x y/dispatch.sh"]);
    // the rebind keeps the built-in (default) budget — dispatch has none
    assert.equal(d!.timeoutMs, undefined);
  } finally {
    delete process.env.OVERCAST_SOURCE_DISPATCH_CMD;
  }
});

// ---- --since normalization (the enumerate seam) -------------------------------

test("normalizeSince: the forms dispatch.sh accepts survive; a surplus datetime is narrowed into that grammar", () => {
  // dispatch.sh's `--since` parser accepts exactly Ns/Nm/Nh/Nd/Nw and YYYY-MM-DD.
  const dispatchGrammar = /^(\d+[smhdw]|\d{4}-\d{2}-\d{2})$/;
  for (const s of ["30s", "45m", "12h", "2d", "1w", "2026-06-01"]) {
    assert.equal(normalizeSince(s), s, `contract form ${s} must reach dispatch.sh unchanged`);
    assert.match(normalizeSince(s), dispatchGrammar);
  }
  // a CLI-valid ISO datetime would trip dispatch.sh's fail-closed `--since` error;
  // normalizeSince rewrites it to a coarse relative duration IN that grammar
  // (widening-only), so the source sees a form it can parse.
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  for (const ms of [20 * 60e3, 5 * 3600e3, 3 * 86400e3]) {
    const out = normalizeSince(iso(ms));
    assert.match(out, dispatchGrammar, `normalized ISO (${ms}ms ago) → dispatch grammar, got '${out}'`);
  }
  assert.match(normalizeSince(iso(3 * 86400e3)), /^\d+d$/, "a multi-day cutoff must travel as Nd");
});

// ---- enumerate → record mapping (media.ref stability + top-level gps) ----------

/** A deterministic dispatch-shaped enumerate fixture: three rows, each carrying a
 *  stable per-row SODA deep-link media.ref, top-level gps (except a sensitive call
 *  with no location), and the surrounding CAD fields. Two orderings share the same
 *  row identities so the SAME row keeps the SAME ref regardless of position. */
function dispatchHits(order: "A" | "B"): unknown[] {
  const rows = {
    r1: {
      title: "Traffic Stop",
      url: "https://data.sfgov.org/resource/gnap-fj3t.json?cad_number=241234567",
      source: "dispatch",
      published: "2026-07-10T22:15:00-07:00",
      created: "2026-07-10T22:15:00-07:00",
      snippet: "100 block of Market St · A · SFPD",
      dataset: "data.sfgov.org/gnap-fj3t",
      row_id: "241234567",
      gps: { lat: 37.7936, lng: -122.3965 },
      media: { ref: "https://data.sfgov.org/resource/gnap-fj3t.json?cad_number=241234567" },
    },
    r2: {
      title: "gnap-fj3t row #7",
      // a :system-field deep link (no real id column) → ?$where=:id='row-…', URI-encoded
      url: "https://data.example.gov/resource/abcd-1234.json?%24where=%3Aid%3D%27row-9fe2%27",
      source: "dispatch",
      published: "2026-07-10T21:59:00Z",
      created: "2026-07-10T21:59:00Z",
      snippet: "Mission District",
      dataset: "data.example.gov/abcd-1234",
      row_id: "row-9fe2",
      gps: { lat: 37.7599, lng: -122.4148 },
      media: { ref: "https://data.example.gov/resource/abcd-1234.json?%24where=%3Aid%3D%27row-9fe2%27" },
    },
    // a sensitive call legitimately carries NO location — still a hit, no gps
    r3: {
      title: "Welfare Check",
      url: "https://data.sfgov.org/resource/gnap-fj3t.json?cad_number=241234999",
      source: "dispatch",
      published: "2026-07-10T21:40:00-07:00",
      created: "2026-07-10T21:40:00-07:00",
      snippet: "SFPD",
      dataset: "data.sfgov.org/gnap-fj3t",
      row_id: "241234999",
      media: { ref: "https://data.sfgov.org/resource/gnap-fj3t.json?cad_number=241234999" },
    },
  };
  return order === "A" ? [rows.r1, rows.r2, rows.r3] : [rows.r3, rows.r1, rows.r2];
}

function writeFixture(dir: string, name: string, hits: unknown[]): string {
  const script = join(dir, name);
  // single-quoted heredoc → the JSON is emitted verbatim (no shell interpolation);
  // the enumerate op/args the source appends are ignored (a fixed feed).
  writeFileSync(script, `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(hits)}\nJSON\n`);
  return script;
}

test("enumerateSource(dispatch): every hit maps to a stable per-row SODA deep-link media.ref + top-level gps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-dispatch-"));
  try {
    const script = writeFixture(dir, "sf.sh", dispatchHits("A"));
    const recs = await enumerateSource({ type: "dispatch", base: ["bash", script] }, { query: "sf" });
    assert.equal(recs.length, 3);
    assert.ok(recs.every((r) => r.state === "ready"), "all dispatch hits are ready records");

    for (const r of recs) {
      const p = r.payload as Record<string, unknown>;
      assert.equal(p.source, "dispatch");
      // media.ref is the row's SODA deep link — a per-row QUERY link (?<col>=… /
      // ?$where=:id='…'), never a fragment (curl drops #… → fetch would pull the
      // whole dataset). This is the dedup-stability contract from PR #100.
      const ref = r.media?.ref ?? "";
      assert.match(ref, /\/resource\/[A-Za-z0-9_-]+\.json\?/, "ref is a per-row query deep link");
      assert.ok(!ref.includes("#"), `ref must not carry a fragment (got ${ref})`);
      // the ref rode in from the row's media.ref, and payload.url is the same link
      assert.equal(ref, p.url, "media.ref === payload.url (the stable per-row link)");
    }

    // top-level gps rides through the loose payload (so records plot on `map`)
    const p0 = recs[0].payload as Record<string, unknown>;
    assert.deepEqual(p0.gps, { lat: 37.7936, lng: -122.3965 });
    // the CAD context fields ride along too (not an allowlist)
    assert.equal(p0.row_id, "241234567");
    assert.equal(p0.dataset, "data.sfgov.org/gnap-fj3t");
    // preset call times keep their explicit offset (map/situation read zone-less as UTC)
    assert.equal(p0.published, "2026-07-10T22:15:00-07:00");

    // a sensitive call with no location is still a ready hit — just without gps
    const sensitive = recs.find((r) => (r.payload as Record<string, unknown>).row_id === "241234999");
    assert.ok(sensitive, "the location-less call is still a hit");
    assert.equal((sensitive!.payload as Record<string, unknown>).gps, undefined);

    // distinct rows → distinct refs (the monitor seen-set keys on the link)
    const refs = recs.map((r) => r.media?.ref);
    assert.equal(new Set(refs).size, refs.length, "each row has a distinct dedup ref");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enumerateSource(dispatch): a row's media.ref is stable across page position (not derived from row order)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-dispatch-order-"));
  try {
    const recsA = await enumerateSource(
      { type: "dispatch", base: ["bash", writeFixture(dir, "orderA.sh", dispatchHits("A"))] },
      { query: "sf" },
    );
    const recsB = await enumerateSource(
      { type: "dispatch", base: ["bash", writeFixture(dir, "orderB.sh", dispatchHits("B"))] },
      { query: "sf" },
    );
    const refFor = (recs: typeof recsA, rowId: string) =>
      recs.find((r) => (r.payload as Record<string, unknown>).row_id === rowId)?.media?.ref;
    // the SAME row (same Socrata id) resolves to the SAME deep link regardless of
    // where it appears in the returned page — dedup is keyed on the row, not order.
    for (const rowId of ["241234567", "row-9fe2", "241234999"]) {
      assert.equal(refFor(recsA, rowId), refFor(recsB, rowId), `ref stable across order for row ${rowId}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enumerateSource(dispatch): a malformed feed surfaces as an error record, not a fake-clean empty scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-dispatch-bad-"));
  try {
    // exit 0 but non-JSON on stdout (a Socrata error page / HTML) → error state,
    // never a silent zero-hit "clean" scan.
    const bad = join(dir, "bad.sh");
    writeFileSync(bad, `#!/usr/bin/env bash\necho "<html>rate limited</html>"\nexit 0\n`);
    const [rec] = await enumerateSource({ type: "dispatch", base: ["bash", bad] }, { query: "sf" });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /no parseable JSON/);

    // exit 13 = a setup/credential gap (exec contract) → needs_credentials, a soft
    // gap the scan surfaces rather than a hard failure.
    const gap = join(dir, "gap.sh");
    writeFileSync(gap, `#!/usr/bin/env bash\necho "needs setup" 1>&2\nexit 13\n`);
    const [gapRec] = await enumerateSource({ type: "dispatch", base: ["bash", gap] }, { query: "sf" });
    assert.equal(gapRec.state, "needs_credentials");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
