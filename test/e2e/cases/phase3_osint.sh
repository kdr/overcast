#!/usr/bin/env bash
# Phase 3 e2e: OSINT round-trip (offline via the committed fixture source
# provider). prebrief stands up a case; target/source register; scan --pull
# captures + senses; monitor --once diffs the seen-set. watch is bound to the
# fixture sense provider so the whole chain runs offline.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

# a tiny clip for the fixture source to "find" + the env wiring
clip="$SMOKE_DIR/osint_src.mp4"
node --import tsx -e "
import {FFMPEG_PATH} from '$REPO/src/media/ffmpeg.ts';
import {execFileSync} from 'node:child_process';
execFileSync(FFMPEG_PATH,['-y','-f','lavfi','-i','testsrc=size=96x72:rate=10:duration=1','-pix_fmt','yuv420p','$clip'],{stdio:'ignore'});
" 2>/dev/null
[ -f "$clip" ] || { fail "osint.clip_gen" "could not generate fixture clip"; return 0 2>/dev/null || exit 0; }
# a DISTINCT second clip so the fixture's two hits are genuinely two items
# (monitor dedups by media.ref).
clip2="$SMOKE_DIR/osint_src2.mp4"; cp "$clip" "$clip2"

export OVERCAST_SOURCE_FIXTURE_CMD="bash $REPO/test/fixtures/fake-source.sh"
export OVERCAST_FIXTURE_CLIP="$clip"
export OVERCAST_FIXTURE_CLIP2="$clip2"

casedir="$SMOKE_DIR/case_osint"; mkdir -p "$casedir"
ochome="$SMOKE_DIR/home_osint"; mkdir -p "$ochome/profiles"
cat >"$ochome/profiles/fx.json" <<JSON
{"name":"fx","providers":{"watch":{"type":"exec","run":"bash $REPO/test/fixtures/fake-watch.sh {{input}}"}}}
JSON
G=(--case "$casedir" --home "$ochome" --profile fx)

# prebrief stands up the case end to end
pb="$($OVERCAST prebrief shadowport --target "@pier9" --source "fixture:pier9" --json "${G[@]}" 2>/dev/null)"
save_json "phase3_prebrief" "$pb" >/dev/null
assert_eq "prebrief.state" "ready" "$(jq -r '.state' <<<"$pb")" "prebrief ready"
assert_eq "prebrief.target" "@pier9" "$(jq -r '.payload.target.value' <<<"$pb")" "prebrief seeded target"
assert_eq "prebrief.source" "fixture" "$(jq -r '.payload.source.type' <<<"$pb")" "prebrief seeded source"

# source list reflects the registry
sl="$($OVERCAST source list --json "${G[@]}" 2>/dev/null)"
assert_eq "source.enabled" "1" "$(jq -r '.payload.enabled' <<<"$sl")" "one enabled source"

# scan --pull: enumerate -> capture -> watch round-trips into records
scan_out="$($OVERCAST scan --pull --json "${G[@]}" 2>/dev/null)"
save_json "phase3_scan" "$scan_out" >/dev/null
nhits="$(jq -s '[.[]|select(.verb=="scan" and (.payload.op // "")!="pull_progress")]|length' <<<"$scan_out" 2>/dev/null)"
ncap="$(jq -s '[.[]|select(.verb=="capture")]|length' <<<"$scan_out" 2>/dev/null)"
nwatch="$(jq -s '[.[]|select(.verb=="watch")]|length' <<<"$scan_out" 2>/dev/null)"
assert_eq "scan.hits" "2" "$nhits" "scan emitted 2 hits"
[ "${ncap:-0}" -ge 1 ] && ok "scan.pull_capture" "scan --pull captured ($ncap)" || fail "scan.pull_capture" "no captures"
[ "${nwatch:-0}" -ge 1 ] && ok "scan.pull_watch" "scan --pull sensed via watch ($nwatch)" || fail "scan.pull_watch" "no watch records"

# monitor --once: detect new fixture items, capture, watch, update seen.json
mcase="$SMOKE_DIR/case_monitor"; mkdir -p "$mcase"
$OVERCAST source add "fixture:pier9" --case "$mcase" --home "$ochome" --profile fx >/dev/null 2>&1
m1="$($OVERCAST monitor --once --pipe watch --json --case "$mcase" --home "$ochome" --profile fx 2>/dev/null)"
save_json "phase3_monitor1" "$m1" >/dev/null
new1="$(jq -s '.[]|select(.verb=="monitor")|.payload.new_items' <<<"$m1" 2>/dev/null | head -1)"
assert_eq "monitor.first_new" "2" "$new1" "monitor --once detects 2 new items"
seen="$(jq -r '.keys|length' "$mcase/.overcast/seen.json" 2>/dev/null)"
assert_eq "monitor.seen_updated" "2" "$seen" "seen.json updated to 2 keys"

m2="$($OVERCAST monitor --once --pipe watch --json --case "$mcase" --home "$ochome" --profile fx 2>/dev/null)"
new2="$(jq -s '.[]|select(.verb=="monitor")|.payload.new_items' <<<"$m2" 2>/dev/null | head -1)"
assert_eq "monitor.second_none" "0" "$new2" "second monitor pass detects 0 new (diff works)"

# the verb surface includes the OSINT verbs (presence check — later phases append)
ov="$($OVERCAST commands --json 2>/dev/null | jq -r '.verbs[].name')"
omissing=""
for v in scan capture monitor target source prebrief; do
  echo "$ov" | grep -qx "$v" || omissing="$omissing $v"
done
[ -z "$omissing" ] && ok "osint.verb_surface" "scan/capture/monitor/target/source/prebrief listed" || fail "osint.verb_surface" "missing:$omissing"
