#!/usr/bin/env bash
# Phase 6 e2e: the live monitoring page `situation` (offline — no browser, no
# creds, no ffmpeg). Exercises the whole control plane + HTTP surface headlessly:
#   (a) `situation status` on an empty case → a not-running record.
#   (b) a BACKGROUNDED token-authed `serve` on an EPHEMERAL port
#       (OVERCAST_SITUATION_PORT=0), discovered via .overcast/situation/runtime.json.
#   (c) the auth boundary on /api/state — 401 without the token, 200 (+ JSON
#       snapshot) with it — plus the static console shell at / (served, secret-free).
#   (d) a cross-process `situation set` the running server consumes (control.json
#       written, then swept on the ~2s control tick).
#   (e) a graceful `situation stop` that exits the serving process + sweeps
#       runtime.json.
# Every wait is a bounded poll loop; a trap kill -9 guards the background pid.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_situation"; mkdir -p "$casedir"
sitdir="$casedir/.overcast/situation"
rtfile="$sitdir/runtime.json"
ctlfile="$sitdir/control.json"
TOKEN="sit_tok_phase6"

serve_pid=""
cleanup() { [ -n "${serve_pid:-}" ] && kill -9 "$serve_pid" 2>/dev/null; return 0; }
trap cleanup EXIT

# the registry lists situation (one spec → CLI/tool/skill)
if $OVERCAST commands --json | jq -r '.verbs[].name' | grep -qx "situation"; then
  ok "situation.verb_surface" "commands --json lists situation"
else
  fail "situation.verb_surface" "situation missing from commands --json"
fi

# (a) status with no server → a ready record reporting running:false
sout="$($OVERCAST situation status --json --case "$casedir" 2>/dev/null)"
save_json "phase6_situation_status_off" "$sout" >/dev/null
assert_eq "situation.status_verb" "situation" "$(jq -r '.verb' <<<"$sout")" "status emits a situation record"
assert_eq "situation.status_off" "false" "$(jq -r '.payload.running' <<<"$sout")" "no server → running:false"

# (b) background a token-authed serve on an ephemeral port (no browser)
export OVERCAST_SITUATION_TOKEN="$TOKEN"
export OVERCAST_SITUATION_PORT=0
$OVERCAST situation serve --no-open --case "$casedir" \
  >"$SMOKE_DIR/phase6_situation_serve.out" 2>"$SMOKE_DIR/phase6_situation_serve.err" &
serve_pid=$!

# poll for runtime.json (server writes it AFTER binding the port) — bounded ~20s
i=0
while [ ! -f "$rtfile" ] && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
if [ -f "$rtfile" ]; then
  ok "situation.serve_started" "runtime.json appeared — serve is live"
else
  fail "situation.serve_started" "runtime.json never appeared within ~20s"
  return 0 2>/dev/null || exit 0
fi

url="$(jq -r '.url' "$rtfile")"
port="$(jq -r '.port' "$rtfile")"
if [ -n "$url" ] && [ "$url" != "null" ] && [ "$port" != "0" ] && [ "$port" != "null" ]; then
  ok "situation.runtime_port" "runtime.json carries a bound ephemeral port ($port)"
else
  fail "situation.runtime_port" "runtime.json missing a bound port (url=$url port=$port)"
fi
# the pairing token lives only in the terminal QR / pairing URL — never on disk
if grep -qF "$TOKEN" "$rtfile"; then
  fail "situation.token_secret" "pairing token leaked into runtime.json"
else
  ok "situation.token_secret" "runtime.json does not contain the pairing token"
fi

# status now discovers the live server cross-process (pid alive + port served)
runout="$($OVERCAST situation status --json --case "$casedir" 2>/dev/null)"
save_json "phase6_situation_status_on" "$runout" >/dev/null
assert_eq "situation.status_on" "true" "$(jq -r '.payload.running' <<<"$runout")" "running server → running:true"

# (c) the HTTP surface (auth boundary + static shell). curl is a de-facto dep of
# the suite (every source provider shells out to it), but guard just in case.
if command -v curl >/dev/null 2>&1; then
  base="${url%/}"
  # /api/state WITHOUT the token → 401 (auth enforced on the data endpoint)
  code_noauth="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/api/state")"
  assert_eq "situation.api_401" "401" "$code_noauth" "/api/state refused without the token"
  # /api/state WITH the token → 200 + a JSON snapshot (panels + version)
  code_auth="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/api/state?token=$TOKEN")"
  assert_eq "situation.api_200" "200" "$code_auth" "/api/state served with the token"
  api="$(curl -s --max-time 10 "$base/api/state?token=$TOKEN")"
  save_json "phase6_situation_api" "$api" >/dev/null
  if jq -e 'has("panels") and has("version")' <<<"$api" >/dev/null 2>&1; then
    ok "situation.api_snapshot" "authed /api/state returns a JSON snapshot (panels+version)"
  else
    fail "situation.api_snapshot" "authed /api/state did not return a snapshot"
  fi
  # the static console shell is served at / (unauthenticated but secret-free)
  page="$(curl -s --max-time 10 "$base/")"
  pagecode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base/")"
  if [ "$pagecode" = "200" ] && printf '%s' "$page" | grep -q '<'; then
    ok "situation.page_html" "console shell served at / (200 + HTML)"
  else
    fail "situation.page_html" "console shell not served at / (code=$pagecode)"
  fi
  if printf '%s' "$page" | grep -qF "$TOKEN"; then
    fail "situation.page_secret" "the console page embedded the pairing token"
  else
    ok "situation.page_secret" "console page does not embed the token"
  fi
else
  ok "situation.http_skip" "curl unavailable — skipping HTTP surface checks"
fi

# (d) a cross-process `situation set` the live server consumes on its ~2s tick
setout="$($OVERCAST situation set --limit 8 --json --case "$casedir" 2>/dev/null)"
save_json "phase6_situation_set" "$setout" >/dev/null
assert_eq "situation.set_op" "set" "$(jq -r '.payload.op' <<<"$setout")" "set emits a set op"
assert_eq "situation.set_running" "true" "$(jq -r '.payload.running' <<<"$setout")" "set sees the live server"
assert_eq "situation.set_control" "8" "$(jq -r '.payload.control.limit' <<<"$setout")" "set records the new limit"
# the serving process consumes (deletes) control.json once it applies the patch
i=0
while [ -f "$ctlfile" ] && [ "$i" -lt 30 ]; do sleep 0.5; i=$((i + 1)); done
if [ ! -f "$ctlfile" ]; then
  ok "situation.set_consumed" "the live server consumed control.json (applied the set)"
else
  fail "situation.set_consumed" "control.json not consumed within ~15s"
fi

# (e) a graceful stop exits the serving process + sweeps runtime.json
stopout="$($OVERCAST situation stop --json --case "$casedir" 2>/dev/null)"
save_json "phase6_situation_stop" "$stopout" >/dev/null
assert_eq "situation.stop_op" "stop" "$(jq -r '.payload.op' <<<"$stopout")" "stop emits a stop op"
i=0
while kill -0 "$serve_pid" 2>/dev/null && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
if kill -0 "$serve_pid" 2>/dev/null; then
  fail "situation.stopped" "serve process still alive ~20s after stop"
else
  ok "situation.stopped" "serve process exited after situation stop"
  serve_pid=""
fi
if [ -f "$rtfile" ]; then
  fail "situation.runtime_swept" "runtime.json survived a graceful stop"
else
  ok "situation.runtime_swept" "runtime.json removed on stop"
fi
