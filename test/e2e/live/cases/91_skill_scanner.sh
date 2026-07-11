#!/usr/bin/env bash
# SKILL: overcast-scanner — "listen to the scanner" (police-CAD incident watch).
# Drives the skill's documented chain against the REAL SF Socrata feed (keyless,
# no cred gate): register dispatch:sf, open a line of investigation, scan the
# rolling calls-for-service window, run the monitor --once dedup pass, plot the
# geotagged calls on the case map (csi theme), and stamp one incident onto the
# line as a finding. Skips the downstream asserts (not fails) if the rolling
# window happens to be empty — the feed is a live ~48h window.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_scanner
SKILL_FILE="$PWD/skills/overcast-scanner/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE (run overcast skills generate)"; exit 0; }

CASE=$(case_dir skill_scanner)

# 1) skill step: register the rolling CAD feed (keyless Socrata preset)
cond "scanner skill: source add dispatch:sf registers the rolling CAD feed"
sout="$(oc "$CASE" source add 'dispatch:sf' --json)"
save_json "91_scanner_source" "$sout" >/dev/null
sstate="$(echo "$sout" | jq -s -r '[.[]|select(.verb=="source")][0].state // ""' 2>/dev/null)"
assert_eq "$C.source" "ready" "$sstate" "dispatch:sf registered"

# 2) skill step: open the line of investigation the incidents triage against
cond "scanner skill: target add opens the line the calls are triaged onto"
tout="$(oc "$CASE" target add 'sf-scanner-watch' --question 'Any calls-for-service relevant to the case area right now?' --json)"
save_json "91_scanner_target" "$tout" >/dev/null
tstate="$(echo "$tout" | jq -s -r '[.[]|select(.verb=="target")][0].state // ""' 2>/dev/null)"
assert_eq "$C.target" "ready" "$tstate" "line of investigation opened"

# 3) skill step: scan the rolling window (REAL feed — no provider override)
cond "scanner skill: scan --source dispatch pulls the live calls-for-service window"
out="$(OC_TIMEOUT=180 oc "$CASE" scan --source dispatch --since 2d --limit 8 --json)"
save_json "91_scanner_scan" "$out" >/dev/null
hits="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")]|length' 2>/dev/null)"
# an ERROR record (broken feed / provider regression) is a FAILURE, not a clean
# skip — only a genuinely empty window (no ready hits AND no error) is skippable,
# else a regression passes the suite as "empty window" (Bugbot #102).
serr="$(echo "$out" | jq -s -r '[.[]|select(.state=="error" or .state=="needs_credentials")][0].error // ""' 2>/dev/null)"
if [ -n "$serr" ] && [ "$serr" != "null" ]; then
  fail "$C.scan" "dispatch scan errored (not an empty window): $serr"
  exit 0
fi
if [ -z "$hits" ] || [ "$hits" = "0" ]; then
  skip "$C.scan" "live SF window returned 0 hits with no error (rolling feed) — downstream asserts skipped"
  exit 0
fi
ok "$C.scan" "live dispatch scan returned $hits calls-for-service hits"

# a call must carry a call-type title; gps rides on any non-sensitive call
dtitle="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and ((.payload.title // "") != ""))][0].payload.title // empty' 2>/dev/null)"
assert_nonempty "$C.title" "$dtitle" "dispatch hit carries a call-type title ($dtitle)"
dlat="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.gps.lat != null))][0].payload.gps.lat // empty' 2>/dev/null)"
assert_nonempty "$C.gps" "$dlat" "dispatch hit carries payload.gps (lat=$dlat)"
rid="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].id // empty' 2>/dev/null)"

# 4) skill step: the standing-watch pass — monitor --once dedups against seen
cond "scanner skill: monitor --once runs the dedup pass over the same feed"
mout="$(OC_TIMEOUT=180 oc "$CASE" monitor --once --source dispatch --limit 8 --json)"
save_json "91_scanner_monitor" "$mout" >/dev/null
mstate="$(echo "$mout" | jq -s -r '[.[]|select(.verb=="monitor")][0].state // ""' 2>/dev/null)"
assert_eq "$C.monitor" "ready" "$mstate" "monitor --once pass completed"

# 5) skill step: plot the geotagged calls on the case map (csi theme)
cond "scanner skill: map --no-open plots the geotagged calls (csi theme)"
MAP_HTML="$SMOKE_DIR/91_scanner_map.html"
mapout="$(oc "$CASE" map --no-open --theme csi --export "$MAP_HTML" --json)"
save_json "91_scanner_map" "$mapout" >/dev/null
mapstate="$(echo "$mapout" | jq -s -r '[.[]|select(.verb=="map")][0].state // ""' 2>/dev/null)"
assert_eq "$C.map" "ready" "$mapstate" "map rendered"
[ -f "$MAP_HTML" ] && ok "$C.map_file" "map HTML written ($MAP_HTML)" || fail "$C.map_file" "map HTML missing"
if [ -n "$dlat" ]; then
  latkey="$(printf '%s' "$dlat" | cut -c1-4)"
  if grep -qF "$latkey" "$MAP_HTML" 2>/dev/null; then
    ok "$C.map_marker" "map HTML embeds the dispatch call coordinates (~$latkey)"
  else
    fail "$C.map_marker" "map HTML does not contain the dispatch gps ($latkey)"
  fi
fi

# 6) skill step: stamp one incident onto the line as a finding
cond "scanner skill: finding create --target stamps the incident onto the line"
fout="$(oc "$CASE" finding create "Scanner hit: $dtitle" --target 'sf-scanner-watch' --ref "$rid" --json)"
save_json "91_scanner_finding" "$fout" >/dev/null
fstate="$(echo "$fout" | jq -s -r '[.[]|select(.verb=="finding")][0].state // ""' 2>/dev/null)"
assert_eq "$C.finding" "ready" "$fstate" "incident stamped onto the line of investigation"
