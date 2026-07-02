#!/usr/bin/env bash
# X (Twitter) copycat flows — real Apify tweet-scraper enumerate, real CDN video
# download, and the pi headless agent driving the x source + the vended
# overcast-copycat-sweep skill:
#   1) CLI keyword search → text hits carrying author/views triage metadata
#   2) user-scoped video search → capture downloads the actual mp4
#   3) headless agent scans x for a key term (persisted scan records = proof)
#   4) headless agent invokes the copycat-sweep skill's sweep/triage tiers and
#      exports a brief HTML evidence report
# API-cred budget: every scan is --limit 5 (asserted by assert_max_hits) and only
# ONE leg downloads a video, so a full run grabs at most ~5 X items — deliberately
# small to avoid exhausting Apify credit. The copycat DETECTION core (match/reject
# + overlay) is proven offline in 27_copycat_local.sh, which needs no source/API.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=x_copycat
require_cred "$C" APIFY_TOKEN "skipping x copycat flows" || exit 0
SRCDIR="$PWD/examples/providers/sources"
export OVERCAST_SOURCE_X_CMD="bash $SRCDIR/x.sh"

assert_scan_hits() { # <id> <output> <label>  (same shape as 20_sources.sh)
  local id="$1" out="$2" label="$3"
  local hits url title err
  hits="$(echo "$out" | jq -s '[.[]|select(.state=="ready" and .verb=="scan" and (.payload.url // "") != "")]|length' 2>/dev/null)"
  url="$(echo "$out" | jq -s -r '[.[]|select(.state=="ready" and .verb=="scan" and (.payload.url // "") != "")][0].payload.url // empty' 2>/dev/null)"
  title="$(echo "$out" | jq -s -r '[.[]|select(.state=="ready" and .verb=="scan" and (.payload.title // "") != "")][0].payload.title // empty' 2>/dev/null)"
  if [ "${hits:-0}" -ge 1 ]; then
    ok "$id" "$label returned $hits hit(s): ${title:-$url}"
    assert_nonempty "$id.url" "$url" "$label first hit has a url"
  else
    err="$(echo "$out" | jq -s -r '[.[]|select(.state=="error" or .state=="needs_credentials")][0].error // "no hits"' 2>/dev/null)"
    fail "$id" "$label returned no usable hits ($err)"
  fi
}

assert_max_hits() { # <id> <output> <max> <label>
  local id="$1" out="$2" max="$3" label="$4"
  local hits
  hits="$(echo "$out" | jq -s '[.[]|select(.state=="ready" and .verb=="scan" and (.payload.url // "") != "")]|length' 2>/dev/null)"
  if [ "${hits:-0}" -le "$max" ]; then
    ok "$id" "$label stayed within top-$max scan cap ($hits hit(s))"
  else
    fail "$id" "$label returned $hits hit(s), expected at most $max"
  fi
}

# --- 1) CLI: key term → text hits with triage metadata -----------------------
cond "x keyword search from the CLI returns text hits with author/views metadata"
CASE=$(case_dir x_keyword)
ocrun "$CASE" source add 'x:"AI agents"' --json >/dev/null 2>&1
out="$(OC_TIMEOUT=300 oc "$CASE" scan --source x --limit 5 --since 7d --json)"
save_json "26_scan_x_keyword" "$out" >/dev/null
assert_scan_hits "$C.keyword" "$out" "x keyword search"
assert_max_hits "$C.keyword.limit" "$out" 5 "x keyword search"
author="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.author // "") != "")][0].payload.author // empty' 2>/dev/null)"
assert_nonempty "$C.keyword.author" "$author" "a hit carries the author triage field (got @$author)"
snippet="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.snippet // "") != "")][0].payload.snippet // empty' 2>/dev/null)"
assert_nonempty "$C.keyword.text" "$snippet" "a hit carries post text"

# --- 2) CLI: same-account candidate match probe -----------------------------
cond "x same-account video search finds the original creator's agent-harness post"
CASE=$(case_dir x_same_account)
ocrun "$CASE" source add 'x:video:from:shenseanchen' --json >/dev/null 2>&1
out="$(OC_TIMEOUT=300 oc "$CASE" scan --source x --limit 5 --json)"
save_json "26_scan_x_same_account" "$out" >/dev/null
assert_scan_hits "$C.same_account" "$out" "x same-account video search"
assert_max_hits "$C.same_account.limit" "$out" 5 "x same-account video search"
match_url="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready") | select(((.payload.author // "") | ascii_downcase) == "shenseanchen") | select(((.payload.title // "") + " " + (.payload.snippet // "")) | test("agent harness|loop engineering"; "i"))][0].payload.url // empty' 2>/dev/null)"
match_media="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready") | select(((.payload.author // "") | ascii_downcase) == "shenseanchen") | select(((.payload.title // "") + " " + (.payload.snippet // "")) | test("agent harness|loop engineering"; "i"))][0].media.ref // empty' 2>/dev/null)"
assert_nonempty "$C.same_account.match" "$match_url" "same-account search found @ShenSeanChen's agent harness / loop engineering post"
assert_nonempty "$C.same_account.media" "$match_media" "same-account match exposes media/capture ref"

# --- 3) CLI: user-scoped video search → capture downloads the mp4 ------------
cond "x video search scoped to a user yields a CDN media ref that capture downloads"
CASE=$(case_dir x_user_video)
ocrun "$CASE" source add 'x:video:from:NASA' --json >/dev/null 2>&1
out="$(OC_TIMEOUT=300 oc "$CASE" scan --source x --limit 5 --json)"
save_json "26_scan_x_user_video" "$out" >/dev/null
assert_scan_hits "$C.user_video" "$out" "x user video search"
assert_max_hits "$C.user_video.limit" "$out" 5 "x user video search"
hit_id="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready") | select((.media.ref // "") | test("video\\.twimg\\.com"))][0].id // empty' 2>/dev/null)"
if [ -n "$hit_id" ]; then
  ok "$C.user_video.cdn" "hit $hit_id points media.ref at video.twimg.com (no X auth needed)"
  cap="$(OC_TIMEOUT=420 oc "$CASE" capture "$hit_id" --json)"
  save_json "26_capture_x_video" "$cap" >/dev/null
  cap_path="$(echo "$cap" | jq -s -r '[.[]|select(.verb=="capture" and .state=="ready")][0].payload.path // empty' 2>/dev/null)"
  if [ -n "$cap_path" ] && [ -s "$cap_path" ]; then
    size="$(wc -c <"$cap_path" | tr -d ' ')"
    ok "$C.user_video.file" "capture downloaded a real video: $(basename "$cap_path") ($size bytes)"
  else
    fail "$C.user_video.file" "capture produced no file (path: ${cap_path:-none})"
  fi
else
  fail "$C.user_video.cdn" "no scan hit carried a video.twimg.com media ref"
fi

# --- 4) headless agent: key term text sweep ----------------------------------
if require_cred "$C.headless" CLOUDGLUE_API_KEY "headless agent needs a brain LLM"; then
  cond "headless agent scans x for a key term and persists scan records"
  CASE=$(case_dir x_headless)
  ocrun "$CASE" source add 'x:"prompt injection"' --json >/dev/null 2>&1
  prompt="Use the overcast scan tool for this case with limit 5 to sweep the registered x source, then reply in one line: 'HITS: <n>' with the number of posts found."
  out="$(OC_TIMEOUT=420 oc "$CASE" --mode json "$prompt")"
  save_json "26_headless_x_scan_trace" "$out" >/dev/null
  assert_nonempty "$C.headless.trace" "$out" "headless JSONL trace captured"
  invalid=0; nlines=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    nlines=$((nlines + 1))
    printf '%s' "$line" | jq -e . >/dev/null 2>&1 || invalid=$((invalid + 1))
  done <<<"$out"
  assert_eq "$C.headless.json" "0" "$invalid" "every one of $nlines event lines is valid JSON"
  # count REAL hits (payload.url non-empty) straight from the case store, so
  # provider placeholder padding can never fake a pass
  recs="$(cat "$CASE/.overcast/records/scan.jsonl" 2>/dev/null | jq -s '[.[]|select((.payload.url // "") != "")]|length')"
  if [ "${recs:-0}" -ge 1 ] && [ "${recs:-0}" -le 5 ]; then
    ok "$C.headless.persisted" "agent's x scan persisted $recs real hit record(s) to the case"
  else
    fail "$C.headless.persisted" "expected 1-5 persisted scan hits from the headless agent, got ${recs:-0}"
  fi
fi

# --- 5) headless agent invokes the copycat-sweep skill ------------------------
if require_cred "$C.skill" CLOUDGLUE_API_KEY "skill invocation needs a brain LLM"; then
  cond "headless agent runs the vended copycat-sweep skill (sweep+triage tiers) and records a briefable TL;DR"
  SKILL_FILE="$PWD/skills/overcast-copycat-sweep/SKILL.md"
  if [ -f "$SKILL_FILE" ]; then
    CASE=$(case_dir x_skill)
    BRIEF_HTML="$SMOKE_DIR/26_copycat_brief.html"
    ocrun "$CASE" source add 'x:video:AI agents' --json >/dev/null 2>&1
    # the skill body starts with '---' frontmatter — lead with prose so the CLI
    # never sees an option-like first token
    prompt="You have the following Overcast agent skill available:

$(cat "$SKILL_FILE")

Invoke the skill above for this BOUNDED task (sweep + triage tiers only — steps 2, 3 and the note part of step 5; do NOT watch/capture/index/monitor anything and do NOT create findings without a confirmed match): the 'original' is a video about AI agent harness and loop engineering published 2026-06-26. The x source is already registered for this case. Run the overcast scan tool with limit 5. Triage the hits per step 3 and record ONE narrative note tagged 'tldr' (pass tag: tldr) starting 'copycat sweep triage:' that names the sources checked, the top candidate authors with views and published dates, and the explicit verdict (e.g. none confirmed without capture-tier checks). Do not call brief; the test harness will export the report after your note is persisted. Then reply in one line: 'SWEEP: <n> hits'."
    out="$(OC_TIMEOUT=600 oc "$CASE" --mode json "$prompt")"
    save_json "26_skill_copycat_trace" "$out" >/dev/null
    assert_nonempty "$C.skill.trace" "$out" "skill-driven JSONL trace captured"
    scans="$(cat "$CASE/.overcast/records/scan.jsonl" 2>/dev/null | jq -s '[.[]|select((.payload.url // "") != "")]|length')"
    if [ "${scans:-0}" -ge 1 ] && [ "${scans:-0}" -le 5 ]; then
      ok "$C.skill.scan" "skill run persisted $scans real scan hit(s)"
    else
      fail "$C.skill.scan" "expected 1-5 scan hits from skill run, got ${scans:-0}"
    fi
    notes="$(ocrun "$CASE" case records --verb note --json 2>/dev/null | jq -r '.payload.count // 0')"
    if [ "${notes:-0}" -ge 1 ]; then
      ok "$C.skill.note" "skill run recorded $notes triage note(s)"
    else
      fail "$C.skill.note" "skill run recorded no triage note"
    fi
    brief="$(OC_TIMEOUT=180 oc "$CASE" brief --export "$BRIEF_HTML" --theme csi --json)"
    save_json "26_skill_copycat_brief" "$brief" >/dev/null
    if [ -s "$BRIEF_HTML" ] && grep -qi "<html" "$BRIEF_HTML"; then
      ok "$C.skill.html" "test harness exported skill-driven brief HTML evidence: $BRIEF_HTML ($(wc -c <"$BRIEF_HTML" | tr -d ' ') bytes)"
      # the report must read as an investigation: TL;DR narrative banner +
      # sources-checked / matches panels, not a bare record dump
      if grep -q 'data-csi-tldr' "$BRIEF_HTML" && grep -q 'copycat sweep triage' "$BRIEF_HTML"; then
        ok "$C.skill.tldr" "brief opens with the agent's TL;DR narrative"
      else
        fail "$C.skill.tldr" "brief HTML lacks the TL;DR narrative banner"
      fi
      if grep -q 'Sources checked' "$BRIEF_HTML" && grep -qi 'Matches &amp; findings' "$BRIEF_HTML"; then
        ok "$C.skill.synthesis" "brief carries sources-checked + matches/findings sections"
      else
        fail "$C.skill.synthesis" "brief HTML lacks sources-checked / matches sections"
      fi
    else
      fail "$C.skill.html" "no brief HTML exported at $BRIEF_HTML"
    fi
  else
    fail "$C.skill.file" "vended skill missing: $SKILL_FILE (run overcast skills generate)"
  fi
fi
