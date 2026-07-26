#!/usr/bin/env bash
# Live financial OSINT sources (follow-the-money): the PUBLIC money trail as scan
# records — `chain` (crypto tx history: BTC keyless via mempool.space, ETH via a
# free ETHERSCAN_API_KEY) and `edgar` (SEC EDGAR corporate filings, keyless). Each
# tx/filing is ONE scan record: payload.created = the event time, media.ref = a
# stable per-item deep link, and NO gps (the trail plots on `graph`, not `map`).
# Real bank/transaction data is out of scope. Bound via OVERCAST_SOURCE_<TYPE>_CMD
# like the other keyless map/OSINT feeds in 20_sources.sh (the bun binary can't
# auto-resolve the shipped scripts from another cwd). The keyless legs (chain:btc:,
# edgar:) run everywhere the network is reachable; a transient outage / rate-limit
# is a best-effort skip (same treatment as overpass/flights/firms), never a FAIL.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=finance
SRCDIR="$PWD/providers/sources"

# --- chain:btc: (mempool.space, KEYLESS — runs everywhere) -------------------
export OVERCAST_SOURCE_CHAIN_CMD="bash $SRCDIR/chain/chain.sh"
CASE=$(case_dir src_chain_btc)
# the Bitcoin genesis address — a well-known, perpetually-active PUBLIC address;
# keyless, so this leg runs anywhere the network is reachable.
ocrun "$CASE" source add 'chain:btc:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' --json >/dev/null 2>&1
out="$(OC_TIMEOUT=120 oc "$CASE" scan --source chain --limit 5 --json)"
save_json "20b_scan_chain_btc" "$out" >/dev/null
bhits="$(echo "$out" | jq -s '[.[]|select(.verb=="scan" and .state=="ready" and ((.payload.txid // "") != ""))]|length' 2>/dev/null)"
if [ "${bhits:-0}" -ge 1 ]; then
  ok "$C.chain.btc" "chain:btc: returned $bhits tx record(s) (keyless via mempool.space)"
  # every tx carries a block time as payload.created (when the money moved) ...
  bcreated="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")|.payload.created // ""] | if length>0 and all(test("^20[0-9][0-9]-")) then "ok" else "" end' 2>/dev/null)"
  assert_nonempty "$C.chain.btc.created" "$bcreated" "chain:btc: hits carry payload.created (block time)"
  # ... a per-tx mempool.space/tx/ media.ref (the monitor dedup key) ...
  bref="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")|.media.ref // ""] | if length>0 and all(test("mempool\\.space/tx/")) then "ok" else "" end' 2>/dev/null)"
  assert_nonempty "$C.chain.btc.ref" "$bref" "chain:btc: refs are mempool.space/tx/ deep links"
  # ... asset=BTC, and NO gps (money has no coordinates — the trail plots on graph)
  basset="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].payload.asset // empty' 2>/dev/null)"
  assert_eq "$C.chain.btc.asset" "BTC" "$basset" "chain:btc: hits are asset=BTC"
  bnogps="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")] | if all(.payload.gps == null) then "ok" else "" end' 2>/dev/null)"
  assert_nonempty "$C.chain.btc.nogps" "$bnogps" "chain:btc: records carry no gps"
else
  berr="$(echo "$out" | jq -s -r '[.[]|select(.state=="error" or .state=="needs_credentials")][0].error // "no tx this run"' 2>/dev/null)"
  skip "$C.chain.btc" "no usable chain:btc: hits this run ($berr) — mempool.space unreachable/rate-limited"
fi
unset OVERCAST_SOURCE_CHAIN_CMD

# --- chain:eth: (Etherscan, ETHERSCAN_API_KEY) -------------------------------
if require_cred "$C.chain.eth" ETHERSCAN_API_KEY "skipping ETH tx history (chain:btc: is keyless)"; then
  export OVERCAST_SOURCE_CHAIN_CMD="bash $SRCDIR/chain/chain.sh"
  CASE=$(case_dir src_chain_eth)
  # the Ethereum Foundation donation address — a well-known, active PUBLIC address.
  ocrun "$CASE" source add 'chain:eth:0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source chain --limit 5 --json)"
  save_json "20b_scan_chain_eth" "$out" >/dev/null
  ehits="$(echo "$out" | jq -s '[.[]|select(.verb=="scan" and .state=="ready" and ((.payload.txid // "") != ""))]|length' 2>/dev/null)"
  if [ "${ehits:-0}" -ge 1 ]; then
    ok "$C.chain.eth" "chain:eth: returned $ehits tx record(s)"
    eref="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")|.media.ref // ""] | if length>0 and all(test("etherscan\\.io/tx/")) then "ok" else "" end' 2>/dev/null)"
    assert_nonempty "$C.chain.eth.ref" "$eref" "chain:eth: refs are etherscan.io/tx/ deep links"
    easset="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].payload.asset // empty' 2>/dev/null)"
    assert_eq "$C.chain.eth.asset" "ETH" "$easset" "chain:eth: hits are asset=ETH"
  else
    eerr="$(echo "$out" | jq -s -r '[.[]|select(.state=="error" or .state=="needs_credentials")][0].error // "no tx this run"' 2>/dev/null)"
    skip "$C.chain.eth" "no usable chain:eth: hits this run ($eerr)"
  fi
  unset OVERCAST_SOURCE_CHAIN_CMD
fi

# --- edgar: (SEC EDGAR, KEYLESS) — Apple's recent filings by CIK -------------
export OVERCAST_SOURCE_EDGAR_CMD="bash $SRCDIR/edgar/edgar.sh"
CASE=$(case_dir src_edgar)
# Apple Inc., CIK 0000320193 — a stable, high-volume filer. A larger --limit lets a
# periodic 10-K/10-Q surface past the frequent Form-4 insider filings up top.
ocrun "$CASE" source add 'edgar:0000320193' --json >/dev/null 2>&1
out="$(OC_TIMEOUT=120 oc "$CASE" scan --source edgar --limit 100 --json)"
save_json "20b_scan_edgar" "$out" >/dev/null
fhits="$(echo "$out" | jq -s '[.[]|select(.verb=="scan" and .state=="ready" and ((.payload.form // "") != ""))]|length' 2>/dev/null)"
if [ "${fhits:-0}" -ge 1 ]; then
  ok "$C.edgar.cik" "edgar returned $fhits filing record(s) for Apple (CIK 320193, keyless)"
  # a periodic report (10-K annual or 10-Q quarterly) must be among them
  fperiodic="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")|.payload.form // ""] | if any(test("^10-[KQ]")) then "ok" else "" end' 2>/dev/null)"
  assert_nonempty "$C.edgar.periodic" "$fperiodic" "edgar surfaced a 10-K/10-Q periodic report"
  # every ref is a sec.gov/Archives filing document (the dedup key)
  fref="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")|.media.ref // ""] | if length>0 and all(test("sec\\.gov/Archives")) then "ok" else "" end' 2>/dev/null)"
  assert_nonempty "$C.edgar.ref" "$fref" "edgar refs are sec.gov/Archives filing documents"
  # payload.created = the filing date (ISO), not scan ingest
  fcreated="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")|.payload.created // ""] | if length>0 and all(test("^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]")) then "ok" else "" end' 2>/dev/null)"
  assert_nonempty "$C.edgar.created" "$fcreated" "edgar hits carry payload.created (filing date)"
  # NO gps (a filing has no coordinates)
  fnogps="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")] | if all(.payload.gps == null) then "ok" else "" end' 2>/dev/null)"
  assert_nonempty "$C.edgar.nogps" "$fnogps" "edgar records carry no gps"
else
  ferr="$(echo "$out" | jq -s -r '[.[]|select(.state=="error" or .state=="needs_credentials")][0].error // "no filings this run"' 2>/dev/null)"
  skip "$C.edgar.cik" "no usable edgar hits this run ($ferr) — SEC EDGAR unreachable/rate-limited/UA-blocked"
fi
unset OVERCAST_SOURCE_EDGAR_CMD
