// Unit coverage for the `chain` source (public blockchain tx history — the money
// trail as OSINT scan records; PR: follow-the-money). Like dispatch.test.ts, the
// ref→query tokenization + the JSON→hit mapping live in the shell script
// (providers/sources/chain/chain.sh); the live 20b_finance_sources case exercises
// them end-to-end against real backends. Here we cover:
//   1. the TS seams the source crosses — the built-in descriptor (shipped ref +
//      keyless-BTC/keyed-ETH `needs`, default exec budget) and normalizeSince;
//   2. the REAL shipped jq mapper, driven offline by a stubbed `curl` on PATH that
//      returns captured mempool.space / Etherscan fixtures — asserting the mapped
//      record contract: stable per-tx media.ref, payload.created = block time,
//      normalized amount, direction, and NO gps (money has no coordinates,
//      invariant #3: a loose record with no envelope fields).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinDescriptor,
  enumerateSource,
  normalizeSince,
  APIFY_RUN_SYNC_TIMEOUT_MS,
} from "../../src/providers/sources/index.ts";

// ---- built-in descriptor ------------------------------------------------------

test("builtinDescriptor resolves the shipped chain source (BTC keyless, ETH keyed, default budget)", () => {
  const d = builtinDescriptor("chain");
  assert.ok(d, "chain descriptor present in dev");
  assert.match(d!.base.join(" "), /chain\.sh$/);
  assert.equal(d!.base[0], "bash");
  // the money-trail source is dual-leg: BTC works keyless (mempool.space), ETH
  // needs a free key — the `needs` note must say BOTH, never claim a hard key.
  assert.match(d!.needs ?? "", /btc/i);
  assert.match(d!.needs ?? "", /keyless|mempool/i);
  assert.match(d!.needs ?? "", /ETHERSCAN_API_KEY/);
  // the BTC leg paginates the confirmed chain, so it carries an explicit exec
  // budget (5 min) sized to the bounded page count — distinct from the Apify one.
  assert.equal(d!.timeoutMs, 300000);
  assert.notEqual(d!.timeoutMs, APIFY_RUN_SYNC_TIMEOUT_MS);
});

test("builtinDescriptor: OVERCAST_SOURCE_CHAIN_CMD rebinds the command, keeps type semantics", () => {
  process.env.OVERCAST_SOURCE_CHAIN_CMD = 'bash "/x y/chain.sh"';
  try {
    const d = builtinDescriptor("chain");
    assert.ok(d);
    assert.equal(d!.type, "chain");
    assert.deepEqual(d!.base, ["bash", "/x y/chain.sh"]); // quote-aware tokenization
    assert.equal(d!.timeoutMs, 300000); // the manifest exec budget persists through a command rebind
  } finally {
    delete process.env.OVERCAST_SOURCE_CHAIN_CMD;
  }
});

// ---- --since normalization (the enumerate seam) -------------------------------

test("normalizeSince: the forms chain.sh accepts survive unchanged", () => {
  // chain.sh's `--since` parser accepts exactly Ns/Nm/Nh/Nd/Nw and YYYY-MM-DD.
  const grammar = /^(\d+[smhdw]|\d{4}-\d{2}-\d{2})$/;
  for (const s of ["30s", "45m", "12h", "30d", "1w", "2025-01-01"]) {
    assert.equal(normalizeSince(s), s, `contract form ${s} must reach chain.sh unchanged`);
    assert.match(normalizeSince(s), grammar);
  }
  // a CLI-valid ISO datetime would trip chain.sh's fail-closed `--since` error;
  // normalizeSince rewrites it to a coarse relative duration IN that grammar.
  assert.match(normalizeSince(new Date(Date.now() - 3 * 86400e3).toISOString()), /^\d+d$/);
});

// ---- enumerate → record mapping (real shipped jq mapper, stubbed curl) ---------

/** Stand up a temp dir on PATH whose `curl` ignores the real network and returns
 *  captured fixtures by URL host — so enumerateSource runs the REAL shipped
 *  chain.sh (its jq mapper included) fully offline. Returns the env to hand
 *  enumerateSource (PATH-prepended so the stub wins, real jq/date/grep resolve). */
function withCurlStub(fixtures: { mempool?: unknown; etherscan?: unknown }): {
  env: NodeJS.ProcessEnv;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "oc-chain-stub-"));
  if (fixtures.mempool !== undefined) writeFileSync(join(dir, "mempool.json"), JSON.stringify(fixtures.mempool));
  if (fixtures.etherscan !== undefined) writeFileSync(join(dir, "etherscan.json"), JSON.stringify(fixtures.etherscan));
  const curl = join(dir, "curl");
  // pick the http(s) arg, cat the matching fixture; a missing fixture → exit 22
  // (curl's "HTTP error" code) so the script's `curl -fsS` failure path is hit.
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  *mempool.space*txs/chain*)  echo '[]'; exit 0 ;;   # confirmed-chain pagination: no more pages
  *mempool.space*)  [ -f "$here/mempool.json" ]   && cat "$here/mempool.json"   && exit 0; exit 22 ;;
  *etherscan.io*)   [ -f "$here/etherscan.json" ] && cat "$here/etherscan.json" && exit 0; exit 22 ;;
  *)                exit 22 ;;
esac
`,
  );
  chmodSync(curl, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
  return { env, dir };
}

const BTC_TXS = [
  // received: 42,000,000 sats to the queried addr (2 inputs from 2 senders) — "in"
  {
    txid: "aaa111",
    vin: [
      { prevout: { scriptpubkey_address: "bcSENDER1", value: 50000000 } },
      { prevout: { scriptpubkey_address: "bcSENDER2", value: 10000000 } },
    ],
    vout: [
      { scriptpubkey_address: "bcQUERY", value: 42000000 },
      { scriptpubkey_address: "bcCHANGE", value: 17000000 },
    ],
    status: { confirmed: true, block_time: 1700000000 },
  },
  // spent the full input to a single recipient (0.5M sat fee) — "out"
  {
    txid: "bbb222",
    vin: [{ prevout: { scriptpubkey_address: "bcQUERY", value: 42000000 } }],
    vout: [{ scriptpubkey_address: "bcRECIP", value: 41500000 }],
    status: { confirmed: true, block_time: 1710000000 },
  },
];

test("enumerateSource(chain btc): real mapper → stable per-tx media.ref, created=block time, no gps", async () => {
  const { env, dir } = withCurlStub({ mempool: BTC_TXS });
  try {
    const recs = await enumerateSource(
      { type: "chain", base: builtinDescriptor("chain")!.base },
      { query: "btc:bcQUERY", env },
    );
    assert.equal(recs.length, 2);
    assert.ok(recs.every((r) => r.state === "ready"), "all btc hits are ready records");

    for (const r of recs) {
      const p = r.payload as Record<string, unknown>;
      assert.equal(p.source, "chain");
      assert.equal(p.asset, "BTC");
      // media.ref is a per-tx mempool.space deep link === payload.url; the money
      // trail has NO gps (it plots on `graph`, not `map`).
      const ref = r.media?.ref ?? "";
      assert.match(ref, /^https:\/\/mempool\.space\/tx\/[a-z0-9]+$/);
      assert.equal(ref, p.url, "media.ref === payload.url (stable per-tx link)");
      assert.equal(p.gps, undefined, "chain records carry NO gps");
      // payload.created = the block time (ISO), not scan ingest
      assert.match(String(p.created), /^20\d\d-\d\d-\d\dT/);
    }

    // newest-first: bbb222 (block_time 1710000000) leads aaa111
    const first = recs[0].payload as Record<string, unknown>;
    assert.equal(first.txid, "bbb222");
    assert.equal(first.direction, "out");
    assert.deepEqual(first.counterparties, ["bcRECIP"]);
    assert.equal(first.amount, 0.42); // gross outflow = the 42,000,000 sat input → 0.42 BTC

    const inbound = recs.find((r) => (r.payload as Record<string, unknown>).txid === "aaa111")!;
    const ip = inbound.payload as Record<string, unknown>;
    assert.equal(ip.direction, "in");
    assert.equal(ip.amount, 0.42); // 42,000,000 sats received
    assert.deepEqual(ip.counterparties, ["bcSENDER1", "bcSENDER2"]);
    assert.match(String(ip.title), /^0\.42 BTC in from bcSENDER1/);

    // distinct txs → distinct refs (monitor seen-set keys on the link)
    const refs = recs.map((r) => r.media?.ref);
    assert.equal(new Set(refs).size, refs.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ETH_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const ETH_RESP = {
  status: "1",
  message: "OK",
  result: [
    // out: 0.42 ETH from the queried addr
    { timeStamp: "1700000000", hash: "0xhashOUT", from: ETH_ADDR, to: "0x000000000000000000000000000000000000dead", value: "420000000000000000" },
    // in: 1.25 ETH to the queried addr
    { timeStamp: "1710000000", hash: "0xhashIN", from: "0x000000000000000000000000000000000000beef", to: ETH_ADDR, value: "1250000000000000000" },
  ],
};

test("enumerateSource(chain eth): wei→ETH normalization, direction, etherscan.io/tx ref", async () => {
  const { env, dir } = withCurlStub({ etherscan: ETH_RESP });
  try {
    const recs = await enumerateSource(
      { type: "chain", base: builtinDescriptor("chain")!.base },
      { query: `eth:${ETH_ADDR}`, env: { ...env, ETHERSCAN_API_KEY: "test-key" } },
    );
    assert.equal(recs.length, 2);
    assert.ok(recs.every((r) => r.state === "ready"));
    const inbound = recs.find((r) => (r.payload as Record<string, unknown>).txid === "0xhashIN")!;
    const ip = inbound.payload as Record<string, unknown>;
    assert.equal(ip.asset, "ETH");
    assert.equal(ip.amount, 1.25); // 1.25e18 wei → 1.25 ETH
    assert.equal(ip.direction, "in");
    assert.match(String(inbound.media?.ref), /^https:\/\/etherscan\.io\/tx\/0x/);
    assert.equal(ip.gps, undefined);
    const outbound = recs.find((r) => (r.payload as Record<string, unknown>).txid === "0xhashOUT")!;
    assert.equal((outbound.payload as Record<string, unknown>).direction, "out");
    assert.equal((outbound.payload as Record<string, unknown>).amount, 0.42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enumerateSource(chain eth): a null `to` (contract creation) doesn't crash the whole enumerate", async () => {
  // Bugbot: counterparties ran ascii_downcase on raw .to/.from — a null `to`
  // (contract-creation tx) aborted the jq map and failed the entire ETH scan.
  const resp = {
    status: "1",
    message: "OK",
    result: [
      { timeStamp: "1700000000", hash: "0xhashCREATE", from: ETH_ADDR, to: null, value: "0" },
      { timeStamp: "1710000000", hash: "0xhashIN", from: "0x000000000000000000000000000000000000beef", to: ETH_ADDR, value: "1000000000000000000" },
    ],
  };
  const { env, dir } = withCurlStub({ etherscan: resp });
  try {
    const recs = await enumerateSource(
      { type: "chain", base: builtinDescriptor("chain")!.base },
      { query: `eth:${ETH_ADDR}`, env: { ...env, ETHERSCAN_API_KEY: "test-key" } },
    );
    assert.equal(recs.length, 2, "both txs map even though one has a null `to`");
    const create = recs.find((r) => (r.payload as Record<string, unknown>).txid === "0xhashCREATE")!;
    assert.equal(create.state, "ready");
    assert.equal((create.payload as Record<string, unknown>).direction, "out");
    // the null `to` yields no counterparty rather than aborting the mapper
    assert.deepEqual((create.payload as Record<string, unknown>).counterparties, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enumerateSource(chain eth): a missing ETHERSCAN_API_KEY is a soft needs_credentials, not a hard fail", async () => {
  const { env, dir } = withCurlStub({});
  try {
    // strip any inherited key so the eth leg hits its exit-13 gate
    const noKey = { ...env };
    delete noKey.ETHERSCAN_API_KEY;
    const recs = await enumerateSource(
      { type: "chain", base: builtinDescriptor("chain")!.base },
      { query: `eth:${ETH_ADDR}`, env: noKey },
    );
    assert.equal(recs.length, 1);
    assert.equal(recs[0].state, "needs_credentials");
    // BTC never needs a key — the ETH gap must not read as "chain unavailable"
    assert.match(recs[0].error ?? "", /ETHERSCAN_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enumerateSource(chain): a bare address with no btc:/eth: prefix is a clear error (v1 requires the prefix)", async () => {
  const { env, dir } = withCurlStub({});
  try {
    const recs = await enumerateSource(
      { type: "chain", base: builtinDescriptor("chain")!.base },
      { query: "bcQUERYaddressonly", env },
    );
    assert.equal(recs.length, 1);
    assert.equal(recs[0].state, "error");
    assert.match(recs[0].error ?? "", /btc:.*eth:|prefix/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enumerateSource(chain btc): a non-array (error body past curl -f) is an error record, not a fake-clean empty scan", async () => {
  const { env, dir } = withCurlStub({ mempool: { error: "rate limited" } });
  try {
    const recs = await enumerateSource(
      { type: "chain", base: builtinDescriptor("chain")!.base },
      { query: "btc:bcQUERY", env },
    );
    assert.equal(recs.length, 1);
    assert.equal(recs[0].state, "error");
    assert.match(recs[0].error ?? "", /unexpected response/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
