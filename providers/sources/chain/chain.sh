#!/usr/bin/env bash
# overcast source provider: chain (public blockchain transaction history — turn a
# crypto address's on-chain money trail into scan records, one per transaction).
# BTC leg is KEYLESS (mempool.space REST); ETH leg uses a FREE key
# (ETHERSCAN_API_KEY, https://etherscan.io/apis). Real bank/transaction data is
# out of scope — this is the PUBLIC ledger only.
#
# Bind with:  overcast source add 'chain:btc:bc1q...'    # BTC address (keyless)
#             overcast source add 'chain:eth:0xABC...'   # ETH address (ETHERSCAN_API_KEY)
#             overcast scan    --source chain --limit 25
#             overcast scan    --source chain --since 30d
#             overcast graph   --no-open                 # flow-of-funds board (no gps)
# Refs / queries (enumerate --query — the ref after `chain:`):
#   btc:<address>   — BTC tx history via mempool.space (keyless)
#   eth:<address>   — ETH tx history via Etherscan (ETHERSCAN_API_KEY)
# The explicit btc:/eth: prefix is REQUIRED for v1; anything else is a clear error.
# Each tx becomes one hit: payload.created = block time, media.ref = a per-tx
# explorer deep link (mempool.space/tx/<txid> or etherscan.io/tx/<hash>). Amounts
# are normalized to whole units (sats->BTC, wei->ETH); direction is in|out|self
# from whether the queried address is on the input side, output side, or both.
# NO gps (money has no coordinates) — plot the trail on `graph`, not `map`.
# Implements: enumerate --query <q> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
BTC_API="https://mempool.space/api"
# Etherscan V2 (chainid-scoped). The legacy V1 host (api.etherscan.io/api with no
# chainid) is being shut down, so use v2/api?chainid=1 — `chain:eth:` is Ethereum
# mainnet (chainid 1) by definition, so this is fixed, not a new env knob.
ETH_API="https://api.etherscan.io/v2/api"
KEY="${ETHERSCAN_API_KEY:-}"
# a descriptive UA is polite (and mempool/etherscan tolerate a blank one, unlike
# SEC EDGAR); override via OVERCAST_HTTP_UA, same knob as overpass/edgar.
UA="${OVERCAST_HTTP_UA:-overcast-osint/0.0.8 (+https://github.com/kdr/overcast)}"

op="${1:-enumerate}"; shift || true

case "$op" in
  init)     exit 0 ;;  # BTC leg is keyless; the ETH key gap surfaces at enumerate (exit 13)
  describe) echo '{"source":"chain","emits":"scan.hit","needs":["ETHERSCAN_API_KEY (chain:eth: only; chain:btc: keyless)"]}'; exit 0 ;;

  enumerate)
    query=""; limit=50; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    # trim surrounding whitespace so a padded ref still parses (a whitespace-only
    # query then trips the empty check) — consistent with the other sources.
    query="${query#"${query%%[![:space:]]*}"}"; query="${query%"${query##*[![:space:]]}"}"
    [ -n "$query" ] || { echo "chain enumerate needs an address: bind chain:btc:<address> or chain:eth:<address>" >&2; exit 1; }
    case "$limit" in ''|*[!0-9]*) limit=50 ;; esac
    [ "$limit" -gt 200 ] 2>/dev/null && limit=200
    [ "$limit" -lt 1 ] 2>/dev/null && limit=1

    # split the ref into a chain-kind prefix + address on the FIRST colon. The
    # explicit btc:/eth: prefix is required for v1 — a bare address (no prefix) is
    # ambiguous between chains, so reject it with a clear message rather than guess.
    kind="${query%%:*}"; addr="${query#*:}"
    kind="$(printf '%s' "$kind" | tr '[:upper:]' '[:lower:]')"
    if [ "$kind" = "$query" ] || [ -z "$addr" ]; then
      echo "chain: ref must be chain:btc:<address> or chain:eth:<address> (got '$query' — the btc:/eth: prefix is required)" >&2; exit 1
    fi

    # --since -> a client-side floor (drop txs whose block time predates it), sort
    # newest-first, THEN --limit — the firms/overpass pattern. Portable epoch math
    # (BSD `date -r` / GNU `date -d @`); fail CLOSED on an unparseable window so we
    # never silently widen to a different range than asked.
    now="$(date -u +%s)"; cutiso=""; cutepoch=""
    if [ -n "$since" ]; then
      case "$since" in
        *[0-9]s) cutepoch=$(( now - 10#${since%s} )) ;;
        *[0-9]m) cutepoch=$(( now - 10#${since%m} * 60 )) ;;
        *[0-9]h) cutepoch=$(( now - 10#${since%h} * 3600 )) ;;
        *[0-9]d) cutepoch=$(( now - 10#${since%d} * 86400 )) ;;
        *[0-9]w) cutepoch=$(( now - 10#${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cutepoch="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$since 00:00:00" +%s 2>/dev/null || echo '')" ;;
        *) echo "chain: could not parse --since '$since' (use Ns/Nm/Nh/Nd/Nw or YYYY-MM-DD)" >&2; exit 1 ;;
      esac
      [ -n "$cutepoch" ] || { echo "chain: could not parse --since '$since'" >&2; exit 1; }
      cutiso="$(date -u -r "$cutepoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$cutepoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
      [ -n "$cutiso" ] || { echo "chain: could not format --since '$since' into an ISO timestamp" >&2; exit 1; }
    fi

    case "$kind" in
      btc)
        # BTC addresses are base58 / bech32 — strictly alphanumeric, so validate the
        # charset then embed RAW in the path (URL-safe as-is). This also rejects a
        # smuggled `/` or query-string that could redirect the API call.
        if ! printf '%s' "$addr" | grep -qE '^[A-Za-z0-9]+$'; then
          echo "chain: '$addr' is not a valid BTC address (expected base58 / bech32 alphanumerics)" >&2; exit 1
        fi
        # bech32 addresses are case-insensitive (mempool returns them lowercase), so
        # match case-insensitively; base58 is a plain string match once both sides
        # are lowercased. Counterparties still EMIT the original-case address.
        addrlc="$(printf '%s' "$addr" | tr '[:upper:]' '[:lower:]')"
        if ! resp="$(curl -fsS -m 45 -H "User-Agent: $UA" "$BTC_API/address/$addr/txs")"; then
          echo "chain btc enumerate request failed for '$addr' (check the address)" >&2; exit 1
        fi
        # A valid mempool response is a JSON ARRAY of txs; an error body (bad address,
        # rate-limit HTML/text) that slips past curl -f is a HARD error, never a
        # fake-empty [] (mirrors firms/overpass response validation).
        if ! printf '%s' "$resp" | jq -e 'type == "array"' >/dev/null 2>&1; then
          echo "chain btc enumerate: unexpected response: $(printf '%s' "$resp" | head -c 200)" >&2; exit 1
        fi
        # mempool.space's /txs returns only the most-recent page (~50: mempool + the
        # first confirmed page). Paginate the confirmed chain (/txs/chain/<last_txid>,
        # 25 per page), bounded to ≤12 pages so a busy address can't spin. Count
        # toward --limit only the txs a --since window would KEEP (confirmed +
        # block_time >= cutoff) so unconfirmed/older txs don't stop us short, and
        # halt once the oldest fetched tx is already past the window (older pages can
        # only be older). A mid-pagination fetch/parse FAILURE is a hard error, never
        # a silent partial scan; an empty page is the genuine end of history.
        txs="$resp"
        recompute_have() {
          if [ -n "$cutepoch" ]; then
            have="$(printf '%s' "$txs" | jq --argjson c "$cutepoch" '[.[]|select((.status.block_time // -1) >= $c)]|length')"
            pastwin="$(printf '%s' "$txs" | jq --argjson c "$cutepoch" '(((.[-1]//{}).status.block_time) // -1) as $bt | if ($bt >= 0 and $bt < $c) then 1 else 0 end')"
          else
            have="$(printf '%s' "$txs" | jq 'length')"; pastwin=0
          fi
        }
        recompute_have
        # the /txs/chain/ cursor must be a CONFIRMED txid — mempool (unconfirmed)
        # txs sort first and have no confirmed page, so paginating from one 404s.
        # No confirmed tx → don't paginate (end of history, not an error).
        last="$(printf '%s' "$txs" | jq -r '[.[] | select(.status.block_time != null)] | (.[-1].txid // empty)')"
        pages=1
        while [ "$have" -lt "$limit" ] && [ -n "$last" ] && [ "$pastwin" -eq 0 ] && [ "$pages" -lt 12 ]; do
          if ! page="$(curl -fsS -m 20 -H "User-Agent: $UA" "$BTC_API/address/$addr/txs/chain/$last")"; then
            echo "chain btc pagination request failed at page $pages (chain/$last) — not a clean end-of-history" >&2; exit 1
          fi
          if ! printf '%s' "$page" | jq -e 'type == "array"' >/dev/null 2>&1; then
            echo "chain btc pagination: unexpected non-array response: $(printf '%s' "$page" | head -c 200)" >&2; exit 1
          fi
          plen="$(printf '%s' "$page" | jq 'length')"
          [ "$plen" -eq 0 ] && break
          txs="$(printf '%s\n%s' "$txs" "$page" | jq -s 'add')"
          last="$(printf '%s' "$txs" | jq -r '[.[] | select(.status.block_time != null)] | (.[-1].txid // empty)')"
          recompute_have
          pages=$((pages + 1))
        done
        printf '%s' "$txs" | jq -c --arg addr "$addrlc" --argjson n "$limit" --arg cutiso "$cutiso" '
          map(
            ([ .vin[]? | .prevout // {} ]) as $ins
            | ([ .vout[]? // {} ]) as $outs
            | ([ $ins[]  | select((.scriptpubkey_address // "" | ascii_downcase) == $addr) | (.value // 0) ] | add // 0) as $sent
            | ([ $outs[] | select((.scriptpubkey_address // "" | ascii_downcase) == $addr) | (.value // 0) ] | add // 0) as $recv
            | (if $sent > 0 and $recv > 0 then "self" elif $sent > 0 then "out" elif $recv > 0 then "in" else "in" end) as $dir
            | (if $dir == "out" then $sent elif $dir == "in" then $recv else (if $sent > $recv then $sent else $recv end) end) as $amtSats
            | ($amtSats / 100000000) as $amt
            | ([ $ins[]  | select((.scriptpubkey_address // "" | ascii_downcase) != $addr) | .scriptpubkey_address // empty ]) as $senders
            | ([ $outs[] | select((.scriptpubkey_address // "" | ascii_downcase) != $addr) | .scriptpubkey_address // empty ]) as $recipients
            # transaction-order (deduped later) — the title uses the FIRST-seen
            # counterparty, not the alphabetically-first one that `unique` returns,
            # so it points at a meaningful lead; the counterparties SET stays unique.
            | (if $dir == "in" then $senders elif $dir == "out" then $recipients else ($senders + $recipients) end
               | map(select(. != null and . != ""))) as $cpsOrdered
            | ($cpsOrdered | unique) as $cps
            | ($ins  | length) as $nin
            | ($outs | length) as $nout
            | (.status.block_time // null) as $bt
            | (if $bt != null then ($bt | todate) else null end) as $iso
            | (($cpsOrdered[0] // "?") | if length > 18 then .[0:18] + "…" else . end) as $cp0
            | ("https://mempool.space/tx/" + .txid) as $url
            | {
                title: (($amt|tostring) + " BTC " + $dir
                        + (if $dir == "in" then " from " elif $dir == "out" then " to " else " " end)
                        + $cp0 + " (" + ($nout|tostring) + " outputs)"),
                url: $url,
                source: "chain",
                # graph/brief rank + --since-filter by payload.created = the BLOCK
                # time (when the money moved), not scan ingest; unconfirmed txs
                # (no block_time) carry null and sort last under a --since window.
                created: $iso,
                published: $iso,
                snippet: ("value " + ($amt|tostring) + " BTC · " + ($nin|tostring) + " inputs · " + ($nout|tostring) + " outputs"),
                counterparties: $cps,
                amount: $amt,
                asset: "BTC",
                direction: $dir,
                txid: .txid,
                media: { ref: $url }
              }
          )
          | map(select($cutiso == "" or (.created != null and .created >= $cutiso)))
          | sort_by(.created // "9999") | reverse | .[0:$n]'
        ;;

      eth)
        [ -n "$KEY" ] || { echo "chain eth needs a key: set ETHERSCAN_API_KEY (free at https://etherscan.io/apis); chain:btc: works without one" >&2; exit 13; }
        # ETH addresses are 0x + 40 hex; validate then @uri-encode as belt-and-suspenders
        # (it rides a query string, not the path).
        if ! printf '%s' "$addr" | grep -qiE '^0x[0-9a-f]{40}$'; then
          echo "chain: '$addr' is not a valid ETH address (expected 0x + 40 hex)" >&2; exit 1
        fi
        addrenc="$(jq -rn --arg v "$addr" '$v|@uri')"
        addrlc="$(printf '%s' "$addr" | tr '[:upper:]' '[:lower:]')"
        # page=1 + offset=<limit> makes Etherscan return the newest --limit txs in one
        # call (offset is the page size, max 10000; our limit is ≤200) — otherwise a
        # busy address silently returns only the API's default page.
        if ! resp="$(curl -fsS -m 45 -H "User-Agent: $UA" "$ETH_API?chainid=1&module=account&action=txlist&address=$addrenc&sort=desc&page=1&offset=$limit&apikey=$KEY")"; then
          echo "chain eth enumerate request failed for '$addr' (check the address and ETHERSCAN_API_KEY)" >&2; exit 1
        fi
        # Etherscan wraps everything in {status,message,result}. status "1" = a real
        # result[] array; status "0" + "No transactions found" is a legitimate EMPTY
        # scan ([]); any OTHER status "0" (Invalid API Key / Max rate limit / NOTOK)
        # is a HARD error — its `result` is then a STRING, not the array we'd map, so
        # a fake-empty [] would hide a broken key.
        if ! printf '%s' "$resp" | jq -e 'type == "object" and has("status")' >/dev/null 2>&1; then
          echo "chain eth enumerate: unexpected response: $(printf '%s' "$resp" | head -c 200)" >&2; exit 1
        fi
        status="$(printf '%s' "$resp" | jq -r '.status // ""')"
        if [ "$status" != "1" ]; then
          if printf '%s' "$resp" | jq -e '(.message // "") | test("No transactions found"; "i")' >/dev/null 2>&1; then
            echo '[]'; exit 0
          fi
          echo "chain eth enumerate error: $(printf '%s' "$resp" | jq -r '(.message // "") + " — " + ((.result // "") | tostring)' | head -c 200)" >&2; exit 1
        fi
        if ! printf '%s' "$resp" | jq -e '(.result | type) == "array"' >/dev/null 2>&1; then
          echo "chain eth enumerate: status 1 but result is not an array: $(printf '%s' "$resp" | head -c 200)" >&2; exit 1
        fi
        printf '%s' "$resp" | jq -c --arg addr "$addrlc" --argjson n "$limit" --arg cutiso "$cutiso" '
          [ (.result // [])[]
            | (.from // "" | ascii_downcase) as $from
            | (.to   // "" | ascii_downcase) as $to
            | (if $from == $addr and $to == $addr then "self" elif $from == $addr then "out" elif $to == $addr then "in" else "in" end) as $dir
            | ((.value // "0" | tonumber) / 1e18) as $amt
            | (if $dir == "out" then [ .to ] elif $dir == "in" then [ .from ] else [ .from, .to ] end
               | map(select(. != null and . != "")) | map(ascii_downcase) | map(select(. != $addr))) as $cpsOrdered
            | ($cpsOrdered | unique) as $cps
            | ((.timeStamp // "0" | tonumber)) as $ts
            | (if $ts > 0 then ($ts | todate) else null end) as $iso
            | (($cpsOrdered[0] // "?") | if length > 18 then .[0:18] + "…" else . end) as $cp0
            | ("https://etherscan.io/tx/" + .hash) as $url
            | {
                title: (($amt|tostring) + " ETH " + $dir
                        + (if $dir == "in" then " from " elif $dir == "out" then " to " else " " end) + $cp0),
                url: $url,
                source: "chain",
                created: $iso,
                published: $iso,
                snippet: ("value " + ($amt|tostring) + " ETH · " + (.from // "?") + " → " + (.to // "?")),
                counterparties: $cps,
                amount: $amt,
                asset: "ETH",
                direction: $dir,
                txid: .hash,
                media: { ref: $url }
              }
          ]
          | map(select($cutiso == "" or (.created != null and .created >= $cutiso)))
          | sort_by(.created // "9999") | reverse | .[0:$n]'
        ;;

      *) echo "chain: unknown chain '$kind' (v1 supports btc / eth — use chain:btc:<address> or chain:eth:<address>)" >&2; exit 1 ;;
    esac
    ;;

  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "chain fetch needs --url" >&2; exit 1; }
    # a hit's ref is a block-explorer tx page (HTML). curl it as evidence; it is a
    # page, so report kind:"page" (mirrors overpass/firms fetch).
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if curl -fsSL -m 60 -H "User-Agent: $UA" -o "$page" "$url"; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"chain",url:$u}'
    else
      echo "chain fetch failed for $url" >&2; rm -f "$page"; exit 1
    fi
    ;;

  *) echo "chain source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
