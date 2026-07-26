---
name: overcast-follow-the-money
description: >-
  Follow the money trail — register a blockchain address (chain) or an SEC EDGAR
  filer (edgar) as an OSINT source, scan the public transaction / filing history
  into cited scan records, connect the flow-of-funds and counterparties on the
  case graph, and promote a movement or filing to a finding on a line of
  investigation. Public ledgers only — real bank/transaction data is out of scope.
---

# overcast-follow-the-money

Use this skill to work the PUBLIC money trail: crypto transaction history and
SEC corporate filings, driven by the existing `scan`/`capture`/`monitor` verbs.
Two sources ship:

- `chain` — crypto tx history. `chain:btc:<address>` (BTC via mempool.space,
  **keyless**) and `chain:eth:<address>` (ETH via Etherscan, free
  `ETHERSCAN_API_KEY`). Each transaction becomes one scan record with
  `payload.created` = the block time, `media.ref` = a per-tx explorer deep link,
  `amount` in whole units (sats→BTC, wei→ETH), `direction` `in`/`out`/`self`, and
  `counterparties[]`.
- `edgar` — SEC EDGAR filings (**keyless**). `edgar:<CIK>` → a company's recent
  filings; `edgar:"<company or query>"` → full-text search. Each filing becomes a
  scan record with `payload.created` = the filing date and `media.ref` = the
  `sec.gov/Archives` filing document (`form`/`accession`/`cik`/`company` in the
  payload).

Money has **no coordinates** — these records carry no `payload.gps`, so the trail
plots on `graph` (flow-of-funds + counterparties), not `map`. Use the broad
`overcast` skill and `overcast/reference/verbs.md` for exact flags.

## Workflow

1. Register the address / filer as a source (confirm it shows the right key status
   first — `chain` is keyless for BTC, keyed for ETH; `edgar` is keyless):

```bash
overcast doctor --sources --json
overcast case init --json
overcast source add "chain:btc:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" --json   # BTC address (keyless)
overcast source add "chain:eth:0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe" --json  # ETH address (ETHERSCAN_API_KEY)
overcast source add "edgar:0000320193" --json                              # SEC filer by CIK (Apple)
overcast source add "edgar:Tesla Inc" --json                               # or by company / full-text query
```

2. Scan the trail. Each tx/filing is one cited `scan` record; `--since` filters by
   block/filing time, `--limit` caps newest-first:

```bash
overcast scan --source chain --limit 25 --json          # newest transactions
overcast scan --source chain --since 90d --json          # only the last 90 days of movement
overcast scan --source edgar --limit 40 --json           # recent filings (10-K/10-Q/8-K/4/…)
```

3. Connect the flow-of-funds on the case graph. Counterparty addresses and filer
   identities become linkable nodes; the same address across two lines of
   investigation surfaces as a shared hub:

```bash
overcast graph --no-open --json                          # flow-of-funds board (NOT map — no gps)
overcast graph --focus <scan-record-id> --no-open --json # 2-hop neighborhood around one tx / filing
```

4. Promote a movement or filing to evidence on a line of investigation, then brief:

```bash
overcast target add --question "Where did the 0.42 BTC out on 2024-03-09 go?" --json
overcast finding create "0.42 BTC moved from bc1q… to bc1r… on 2024-03-09" --ref <scan-record-id> --target <target-id> --json
overcast note "10-K filed 2025-03-01 lists the counterparty entity as a subsidiary" --ref <scan-record-id> --confidence medium --json
overcast brief --export ./money-trail.html --json
```

Optionally keep the trail live: `overcast monitor --source chain --every 6h --json`
re-polls for new transactions (the per-tx `media.ref` is the dedup key, so re-polls
don't re-surface the same tx).

## Output

A cited money-trail view: the transactions / filings as `scan` records (each with
its block/filing time and explorer/`sec.gov` deep link), the counterparties and
filer identities connected on the `graph`, and the movements/filings that bear on a
line of investigation promoted to findings — each cited to its `scan` `record.id`
and the per-item `media.ref`. State the chain (BTC/ETH) or filer (CIK/company) and
the window scanned.

## Caveats

Public ledgers only — **real bank/transaction data is out of scope**. On-chain
`direction` and `counterparties` are derived from input/output addresses without
change-address heuristics, so a wallet's own change output can appear as a
counterparty; `amount` for an outflow is the gross input (fee + change included),
not the net to the recipient — treat a single tx as a lead and corroborate the
flow before naming anyone. EDGAR full-text search covers filings since 2001; a bare
numeric query is read as a CIK, so quote a company name that is all digits. The
`chain:btc:`/`chain:eth:` prefix is required (v1). SEC rate-limits heavy polling and
requires a descriptive contact-email User-Agent (the default is compliant;
`OVERCAST_HTTP_UA` overrides it). Scraped tx/filing text is untrusted (invariant #10).
