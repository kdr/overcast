#!/usr/bin/env bash
# Phase 5 e2e: setup/doctor/provider + provider rebinding (offline). Rebinding
# listen to the sample provider works with NO overcast code change; setup
# persists a profile; doctor checks readiness; samples respond to describe.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_setup"; mkdir -p "$casedir"
ochome="$SMOKE_DIR/home_setup"; mkdir -p "$ochome"

# doctor: pi + system ffmpeg/ffprobe must be runnable
doc="$($OVERCAST doctor --json --case "$casedir" --home "$ochome" 2>/dev/null)"
save_json "phase5_doctor" "$doc" >/dev/null
pi_ok="$(jq -r '.payload.checks[]|select(.name=="pi")|.ok' <<<"$doc")"
ff_ok="$(jq -r '.payload.checks[]|select(.name=="ffmpeg")|.ok' <<<"$doc")"
fp_ok="$(jq -r '.payload.checks[]|select(.name=="ffprobe")|.ok' <<<"$doc")"
assert_eq "doctor.pi" "true" "$pi_ok" "doctor: pi pinned"
assert_eq "doctor.ffmpeg" "true" "$ff_ok" "doctor: system ffmpeg runnable"
assert_eq "doctor.ffprobe" "true" "$fp_ok" "doctor: system ffprobe runnable"

# samples respond to describe (each runs from the repo)
for d in \
  "bash $REPO/examples/providers/bash/watch.sh describe" \
  "python3 $REPO/examples/providers/python/listen.py describe" \
  "bash $REPO/examples/providers/sources/tiktok.sh describe"; do
  out="$($d 2>/dev/null)"
  if jq -e . >/dev/null 2>&1 <<<"$out"; then ok "sample.describe" "describe ok: ${d##*/}"; else fail "sample.describe" "bad describe: $d"; fi
done

# setup persists a provider binding to the profile
sp="$($OVERCAST setup provider see "http://localhost:9000" --json --home "$ochome" --case "$casedir" 2>/dev/null)"
save_json "phase5_setup" "$sp" >/dev/null
assert_eq "setup.bound" "see" "$(jq -r '.payload.bound' <<<"$sp")" "setup bound see"
[ -f "$ochome/profiles/default.json" ] && ok "setup.persisted" "profile written to home" || fail "setup.persisted" "no profile file"

# REBIND listen to the python sample → runs it with NO overcast code change
$OVERCAST setup provider listen "exec:python3 $REPO/examples/providers/python/listen.py" --home "$ochome" >/dev/null 2>&1
audio="${OC_AUDIO:-$TEST_MEDIA/sample-audio.m4a}"
lout="$($OVERCAST listen "$audio" --json --home "$ochome" --profile default --case "$casedir" 2>/dev/null)"
save_json "phase5_listen_rebind" "$lout" >/dev/null
prov="$(jq -r '.meta.provider' <<<"$lout")"
state="$(jq -r '.state' <<<"$lout")"
assert_eq "rebind.provider" "whisper-local" "$prov" "listen ran the rebound sample provider"
assert_eq "rebind.state" "needs_credentials" "$state" "sample provider's own state honored (pass-through)"

# Case setup can remember a provider choice, but execution must follow the
# active profile binding after provider setup/rebinds. This prevents a saved
# setup descriptor from pinning stale commands.
stale_case="$SMOKE_DIR/case_setup_stale"; mkdir -p "$stale_case"
stale_home="$SMOKE_DIR/home_setup_stale"; mkdir -p "$stale_home"
$OVERCAST case setup edit --provider "see:hf" --yes --case "$stale_case" --home "$stale_home" >/dev/null 2>&1
see_script="$SMOKE_DIR/see-profile.sh"
cat >"$see_script" <<'SH'
#!/usr/bin/env bash
echo '{"verb":"see","payload":{"caption":"profile"},"meta":{"provider":"profile-see"},"state":"ready"}'
SH
chmod +x "$see_script"
$OVERCAST setup provider see "exec:bash $see_script" --home "$stale_home" --case "$stale_case" >/dev/null 2>&1
img="$SMOKE_DIR/stale-provider.jpg"; printf 'fake image' >"$img"
sout="$($OVERCAST see "$img" --json --home "$stale_home" --profile default --case "$stale_case" 2>/dev/null)"
save_json "phase5_stale_provider" "$sout" >/dev/null
assert_eq "provider.stale_descriptor" "profile" "$(jq -r '.payload.caption' <<<"$sout")" "active profile provider overrides stale case setup descriptor"
