#!/usr/bin/env bash
# overcast source provider: edgar (SEC EDGAR corporate filings — turn a company's
# filing history into scan records, one per filing). NO key: the SEC APIs are
# public, but they 403 a blank/bot User-Agent, so we always send a descriptive one
# (OVERCAST_HTTP_UA, same knob as overpass/chain).
#
# Bind with:  overcast source add 'edgar:320193'         # by CIK (Apple) -> submissions API
#             overcast source add 'edgar:Tesla Inc'      # by name/query -> full-text search
#             overcast scan    --source edgar --limit 20
#             overcast scan    --source edgar --since 2024-01-01
# Refs / queries (enumerate --query — the ref after `edgar:`):
#   <CIK>                      — a bare 1–10 digit CIK (optional leading `CIK`) →
#                                the company's recent filings (submissions API)
#   "<company or full-text>"   — anything else → EDGAR full-text search (efts)
# Each filing becomes one hit: payload.created = the FILING date, media.ref = the
# sec.gov/Archives filing document (an HTML/txt page → fetch kind:"page"), plus
# form / accession / cik / company in the payload. NO gps.
# Implements: enumerate --query <q> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
SUB_API="https://data.sec.gov/submissions"
FTS_API="https://efts.sec.gov/LATEST/search-index"
# SEC REQUIRES a descriptive User-Agent carrying a CONTACT EMAIL (their fair-access
# policy 403s blank/bot UAs — AND, empirically, UAs bearing a URL or parentheses;
# only the plain `product/version email` shape passes). Default to a compliant one;
# override via OVERCAST_HTTP_UA (must keep an email or SEC 403s the request).
UA="${OVERCAST_HTTP_UA:-overcast-osint/0.0.8 research@overcast.video}"

op="${1:-enumerate}"; shift || true

case "$op" in
  init)     exit 0 ;;  # keyless (public SEC EDGAR API)
  describe) echo '{"source":"edgar","emits":"scan.hit","needs":[]}'; exit 0 ;;

  enumerate)
    query=""; limit=25; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    # trim surrounding whitespace so a padded ref still parses (a whitespace-only
    # query then trips the empty check) — consistent with the other sources.
    query="${query#"${query%%[![:space:]]*}"}"; query="${query%"${query##*[![:space:]]}"}"
    [ -n "$query" ] || { echo "edgar enumerate needs a CIK or query: bind edgar:<CIK> or edgar:\"<company>\"" >&2; exit 1; }
    case "$limit" in ''|*[!0-9]*) limit=25 ;; esac
    [ "$limit" -gt 200 ] 2>/dev/null && limit=200
    [ "$limit" -lt 1 ] 2>/dev/null && limit=1

    # --since -> a client-side floor on the FILING date (drop older filings), sort
    # newest-first, THEN --limit — the firms/overpass pattern. Portable epoch math;
    # fail CLOSED on an unparseable window.
    now="$(date -u +%s)"; cutdate=""
    if [ -n "$since" ]; then
      cutepoch=""
      case "$since" in
        *[0-9]s) cutepoch=$(( now - 10#${since%s} )) ;;
        *[0-9]m) cutepoch=$(( now - 10#${since%m} * 60 )) ;;
        *[0-9]h) cutepoch=$(( now - 10#${since%h} * 3600 )) ;;
        *[0-9]d) cutepoch=$(( now - 10#${since%d} * 86400 )) ;;
        *[0-9]w) cutepoch=$(( now - 10#${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cutepoch="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$since 00:00:00" +%s 2>/dev/null || echo '')" ;;
        *) echo "edgar: could not parse --since '$since' (use Ns/Nm/Nh/Nd/Nw or YYYY-MM-DD)" >&2; exit 1 ;;
      esac
      [ -n "$cutepoch" ] || { echo "edgar: could not parse --since '$since'" >&2; exit 1; }
      # EDGAR filing dates are day-granular (YYYY-MM-DD), so compare on the DATE.
      cutdate="$(date -u -r "$cutepoch" +%Y-%m-%d 2>/dev/null || date -u -d "@$cutepoch" +%Y-%m-%d 2>/dev/null || echo '')"
      [ -n "$cutdate" ] || { echo "edgar: could not format --since '$since' into a date" >&2; exit 1; }
    fi

    # bare CIK (optional leading `CIK`) → submissions API; anything else → full-text.
    qup="$(printf '%s' "$query" | tr '[:lower:]' '[:upper:]')"
    cikcand="$query"
    case "$qup" in CIK*) cikcand="${query:3}" ;; esac
    if printf '%s' "$cikcand" | grep -qE '^[0-9]{1,10}$'; then
      # ---- submissions API: CIK zero-padded to 10 digits; Archives path uses the
      # NON-padded integer CIK ----
      cikpad="$(printf '%010d' "$((10#$cikcand))")"
      cikint="$((10#$cikcand))"
      if ! resp="$(curl -fsS -m 45 -H "User-Agent: $UA" "$SUB_API/CIK$cikpad.json")"; then
        echo "edgar submissions request failed for CIK $cikpad (check the CIK)" >&2; exit 1
      fi
      # A valid response is a JSON object whose filings.recent carries the parallel
      # accessionNumber array; a non-JSON body (rate-limit HTML) that slips past
      # curl -f is a HARD error, never a fake-empty [] (mirrors firms/overpass).
      if ! printf '%s' "$resp" | jq -e 'type == "object" and (.filings.recent.accessionNumber | type == "array")' >/dev/null 2>&1; then
        echo "edgar submissions: unexpected response for CIK $cikpad: $(printf '%s' "$resp" | head -c 200)" >&2; exit 1
      fi
      printf '%s' "$resp" | jq -c --arg cik "$cikint" --argjson n "$limit" --arg cut "$cutdate" '
        (.name // "") as $company
        | (.filings.recent) as $r
        | [ range(0; ($r.accessionNumber | length)) as $i
            | {
                form:    ($r.form[$i]            // ""),
                date:    ($r.filingDate[$i]      // null),
                acc:     ($r.accessionNumber[$i] // ""),
                doc:     ($r.primaryDocument[$i] // ""),
                report:  ($r.reportDate[$i]      // null)
              }
            | (.acc | gsub("-"; "")) as $accnd
            | ("https://www.sec.gov/Archives/edgar/data/" + $cik + "/" + $accnd
               + (if (.doc // "") != "" then "/" + .doc else "/" end)) as $url
            | {
                title: ((.form // "filing") + " filed " + (.date // "?")
                        + (if $company != "" then " — " + $company else "" end)),
                url: $url,
                source: "edgar",
                # graph/brief rank + --since-filter by payload.created = the FILING
                # date, not scan ingest — so an old filing scanned today sorts old.
                created: .date,
                published: .date,
                snippet: ("form " + (.form // "?") + " · accession " + (.acc // "?")
                          + (if (.report // "") != "" then " · report period " + .report else "" end)),
                form: .form,
                accession: .acc,
                cik: $cik,
                company: (if $company != "" then $company else null end),
                report_date: .report,
                media: { ref: $url }
              }
          ]
        | map(select($cut == "" or (.created != null and .created >= $cut)))
        | sort_by(.created // "") | reverse | .[0:$n]'
    else
      # ---- full-text search (efts): hits.hits[]._source carries adsh / ciks /
      # file_type / file_date / display_names; _id = "<accession>:<primaryDoc>" ----
      qenc="$(jq -rn --arg v "$query" '$v|@uri')"
      if ! resp="$(curl -fsS -m 45 -H "User-Agent: $UA" "$FTS_API?q=$qenc")"; then
        echo "edgar full-text request failed for '$query'" >&2; exit 1
      fi
      # A valid response is a JSON object with a hits.hits array (zero matches →
      # []); a non-JSON body is a HARD error, never a fake-empty scan.
      if ! printf '%s' "$resp" | jq -e 'type == "object" and (.hits.hits | type == "array")' >/dev/null 2>&1; then
        echo "edgar full-text: unexpected response for '$query': $(printf '%s' "$resp" | head -c 200)" >&2; exit 1
      fi
      printf '%s' "$resp" | jq -c --argjson n "$limit" --arg cut "$cutdate" '
        [ (.hits.hits // [])[]
          | (._source // {}) as $s
          | (._id // "") as $id
          | ($s.adsh // ($id | split(":")[0]) // "") as $acc
          | ($acc | gsub("-"; "")) as $accnd
          | (($id | split(":")[1]) // "") as $doc
          | (($s.ciks // [])[0] // "") as $cikraw
          | (if $cikraw != "" then ($cikraw | sub("^0+"; "")) else "" end) as $cik
          | ($s.file_type // ($s.root_forms[0] // "")) as $form
          | ($s.file_date // null) as $date
          | (($s.display_names // [])[0] // "") as $company
          | (if ($cik != "" and $accnd != "")
               then ("https://www.sec.gov/Archives/edgar/data/" + $cik + "/" + $accnd
                     + (if $doc != "" then "/" + $doc else "/" end))
               else "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany" end) as $url
          | {
              title: (($form | if . == "" then "filing" else . end) + " filed " + ($date // "?")
                      + (if $company != "" then " — " + $company else "" end)),
              url: $url,
              source: "edgar",
              created: $date,
              published: $date,
              snippet: ("form " + ($form | if . == "" then "?" else . end) + " · accession " + ($acc | if . == "" then "?" else . end)
                        + (if $company != "" then " · " + $company else "" end)),
              form: (if $form == "" then null else $form end),
              accession: (if $acc == "" then null else $acc end),
              cik: (if $cik == "" then null else $cik end),
              company: (if $company == "" then null else $company end),
              media: { ref: $url }
            }
        ]
        | map(select($cut == "" or (.created != null and .created >= $cut)))
        | sort_by(.created // "") | reverse | .[0:$n]'
    fi
    ;;

  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "edgar fetch needs --url" >&2; exit 1; }
    # a hit's ref is a filing document (HTML/txt) — curl it as evidence and report
    # the kind by content type (default page). SEC needs the descriptive UA here too.
    if ! ct="$(curl -fsSL -m 60 -H "User-Agent: $UA" -o "$out" -w '%{content_type}' "$url")" || [ ! -s "$out" ]; then
      echo "edgar fetch failed for $url" >&2; rm -f "$out"; exit 1
    fi
    case "$ct" in
      image/*)          kind="image" ;;
      application/pdf*) kind="file" ;;
      *)                kind="page" ;;   # HTML / txt filing documents
    esac
    jq -nc --arg p "$out" --arg k "$kind" --arg u "$url" '{kind:$k,path:$p,source:"edgar",url:$u}'
    ;;

  *) echo "edgar source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
