// Unit coverage for the `edgar` source (SEC EDGAR corporate filings — the money
// trail's paper twin; PR: follow-the-money). Like chain-source.test.ts, the
// CIK-vs-full-text routing + the JSON→hit mapping live in the shell script
// (providers/sources/edgar/edgar.sh); the live 20b_finance_sources case exercises
// them against the real SEC APIs. Here we cover:
//   1. the built-in descriptor (shipped ref, keyless `needs`, default budget);
//   2. the REAL shipped jq mapper for BOTH legs — a bare CIK → submissions API and
//      a name query → full-text search — driven offline by a stubbed `curl` that
//      returns captured SEC fixtures, asserting the mapped record contract: a
//      sec.gov/Archives per-filing media.ref, payload.created = the FILING date,
//      form/accession/cik/company in the payload, and NO gps (invariant #3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinDescriptor,
  enumerateSource,
  normalizeSince,
} from "../../src/providers/sources/index.ts";

// ---- built-in descriptor ------------------------------------------------------

test("builtinDescriptor resolves the shipped edgar source (keyless, default budget)", () => {
  const d = builtinDescriptor("edgar");
  assert.ok(d, "edgar descriptor present in dev");
  assert.match(d!.base.join(" "), /edgar\.sh$/);
  assert.equal(d!.base[0], "bash");
  // EDGAR is keyless — its `needs` says so, and flags the SEC User-Agent policy.
  assert.match(d!.needs ?? "", /none|public/i);
  assert.match(d!.needs ?? "", /User-Agent/i);
  assert.equal(d!.timeoutMs, undefined);
});

test("normalizeSince: the forms edgar.sh accepts survive unchanged", () => {
  const grammar = /^(\d+[smhdw]|\d{4}-\d{2}-\d{2})$/;
  for (const s of ["12h", "30d", "1w", "2024-01-01"]) {
    assert.equal(normalizeSince(s), s);
    assert.match(normalizeSince(s), grammar);
  }
  assert.match(normalizeSince(new Date(Date.now() - 5 * 86400e3).toISOString()), /^\d+d$/);
});

// ---- enumerate → record mapping (real shipped jq mapper, stubbed curl) ---------

function withCurlStub(fixtures: { submissions?: unknown; fts?: unknown }): {
  env: NodeJS.ProcessEnv;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "oc-edgar-stub-"));
  if (fixtures.submissions !== undefined) writeFileSync(join(dir, "submissions.json"), JSON.stringify(fixtures.submissions));
  if (fixtures.fts !== undefined) writeFileSync(join(dir, "fts.json"), JSON.stringify(fixtures.fts));
  const curl = join(dir, "curl");
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  *data.sec.gov*)  [ -f "$here/submissions.json" ] && cat "$here/submissions.json" && exit 0; exit 22 ;;
  *efts.sec.gov*)  [ -f "$here/fts.json" ]         && cat "$here/fts.json"         && exit 0; exit 22 ;;
  *)               exit 22 ;;
esac
`,
  );
  chmodSync(curl, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
  return { env, dir };
}

const SUBMISSIONS = {
  cik: "320193",
  name: "Apple Inc.",
  filings: {
    recent: {
      form: ["10-K", "8-K", "4"],
      filingDate: ["2025-03-01", "2024-11-01", "2024-02-15"],
      accessionNumber: ["0000320193-25-000073", "0000320193-24-000100", "0000320193-24-000010"],
      primaryDocument: ["aapl-20241228.htm", "ea0000.htm", ""],
      reportDate: ["2024-12-28", "2024-11-01", "2024-02-15"],
    },
  },
};

test("enumerateSource(edgar CIK): real mapper → sec.gov/Archives ref, created=filing date, form/cik/company, no gps", async () => {
  const { env, dir } = withCurlStub({ submissions: SUBMISSIONS });
  try {
    const recs = await enumerateSource(
      { type: "edgar", base: builtinDescriptor("edgar")!.base },
      { query: "0000320193", env },
    );
    assert.equal(recs.length, 3);
    assert.ok(recs.every((r) => r.state === "ready"));

    // newest-first: the 10-K (2025-03-01) leads
    const first = recs[0].payload as Record<string, unknown>;
    assert.equal(first.form, "10-K");
    assert.equal(first.created, "2025-03-01");
    assert.equal(first.company, "Apple Inc.");
    assert.equal(first.accession, "0000320193-25-000073");
    assert.equal(first.cik, "320193");
    assert.equal(first.gps, undefined, "edgar records carry NO gps");
    assert.match(String(first.title), /^10-K filed 2025-03-01 — Apple Inc\.$/);
    // media.ref = the Archives filing doc (accession de-dashed, non-padded CIK path)
    assert.equal(
      recs[0].media?.ref,
      "https://www.sec.gov/Archives/edgar/data/320193/000032019325000073/aapl-20241228.htm",
    );
    assert.equal(recs[0].media?.ref, first.url, "media.ref === payload.url");

    // a filing whose primaryDocument is empty falls back to the accession folder
    const noDoc = recs.find((r) => (r.payload as Record<string, unknown>).accession === "0000320193-24-000010")!;
    assert.equal(
      noDoc.media?.ref,
      "https://www.sec.gov/Archives/edgar/data/320193/000032019324000010/",
    );

    // every ref is a per-filing Archives deep link (dedup key), all distinct
    const refs = recs.map((r) => r.media?.ref ?? "");
    assert.ok(refs.every((u) => u.startsWith("https://www.sec.gov/Archives/edgar/data/")));
    assert.equal(new Set(refs).size, refs.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enumerateSource(edgar CIK): --since drops filings before the cutoff, newest-first", async () => {
  const { env, dir } = withCurlStub({ submissions: SUBMISSIONS });
  try {
    const recs = await enumerateSource(
      { type: "edgar", base: builtinDescriptor("edgar")!.base },
      { query: "320193", since: "2024-06-01", env },
    );
    // the 2024-02-15 Form 4 is dropped; 10-K (2025-03-01) + 8-K (2024-11-01) remain
    assert.equal(recs.length, 2);
    const forms = recs.map((r) => (r.payload as Record<string, unknown>).form);
    assert.deepEqual(forms, ["10-K", "8-K"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FTS = {
  hits: {
    hits: [
      {
        _id: "0001628280-25-001234:tsla-20241231.htm",
        _source: {
          adsh: "0001628280-25-001234",
          ciks: ["0001318605"],
          file_type: "10-K",
          file_date: "2025-01-29",
          display_names: ["Tesla, Inc. (TSLA) (CIK 0001318605)"],
        },
      },
      {
        _id: "0001628280-24-000999:tsla-q3.htm",
        _source: {
          adsh: "0001628280-24-000999",
          ciks: ["0001318605"],
          file_type: "10-Q",
          file_date: "2024-10-23",
          display_names: ["Tesla, Inc. (TSLA) (CIK 0001318605)"],
        },
      },
    ],
  },
};

test("enumerateSource(edgar full-text): a name query → efts hits with Archives refs (non-padded CIK), no gps", async () => {
  const { env, dir } = withCurlStub({ fts: FTS });
  try {
    const recs = await enumerateSource(
      { type: "edgar", base: builtinDescriptor("edgar")!.base },
      { query: "Tesla Inc", env },
    );
    assert.equal(recs.length, 2);
    const first = recs[0].payload as Record<string, unknown>;
    assert.equal(first.form, "10-K");
    assert.equal(first.created, "2025-01-29");
    assert.equal(first.accession, "0001628280-25-001234");
    // ciks[] arrive zero-padded; the Archives path uses the non-padded integer
    assert.equal(first.cik, "1318605");
    assert.equal(first.gps, undefined);
    assert.equal(
      recs[0].media?.ref,
      "https://www.sec.gov/Archives/edgar/data/1318605/000162828025001234/tsla-20241231.htm",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enumerateSource(edgar): a non-JSON body (past curl -f) is an error record, not a fake-clean empty scan", async () => {
  const { env, dir } = withCurlStub({ submissions: { unexpected: true } });
  try {
    const recs = await enumerateSource(
      { type: "edgar", base: builtinDescriptor("edgar")!.base },
      { query: "320193", env },
    );
    assert.equal(recs.length, 1);
    assert.equal(recs[0].state, "error");
    assert.match(recs[0].error ?? "", /unexpected response/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
