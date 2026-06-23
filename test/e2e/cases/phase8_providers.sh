#!/usr/bin/env bash
# Phase 8 e2e (offline, NO API calls): the example providers' `describe` contract
# + profile resolution. `describe`/`init`-less smoke needs no keys, so this runs
# in the default suite. Real provider calls live in the gated live workflows.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

P="$REPO/examples/providers"

# every shipped provider script answers `describe` with valid JSON (no key)
describe_ok() { # <label> <cmd...>
  local label="$1"; shift
  local out; out="$("$@" describe 2>/dev/null)"
  if jq -e . >/dev/null 2>&1 <<<"$out"; then ok "$label" "describe -> valid JSON"; else fail "$label" "bad describe: $out"; fi
}
describe_ok "describe.hf_see"      bash "$P/hf/see.sh"
describe_ok "describe.hf_enhance"  python3 "$P/hf/enhance.py"
describe_ok "describe.fal_see"     bash "$P/fal/see.sh"
describe_ok "describe.fal_enhance" bash "$P/fal/enhance.sh"
describe_ok "describe.el_listen"   bash "$P/elevenlabs/listen.sh"
describe_ok "describe.el_enhance"  bash "$P/elevenlabs/enhance.sh"
describe_ok "describe.youtube"     bash "$P/sources/youtube.sh"
describe_ok "describe.tiktok"      bash "$P/sources/tiktok.sh"

# profiles build offline (setup just writes bindings) and resolve as expected
home="$SMOKE_DIR/prof-home"; mkdir -p "$home"
bash "$REPO/examples/profiles/install-profiles.sh" --home "$home" >/dev/null 2>&1
for p in cloudglue fal elevenlabs hf recon; do
  [ -f "$home/profiles/$p.json" ] && ok "profile.$p" "profile written" || fail "profile.$p" "missing"
done
# recon = best-of-breed mix: listen + see + enhance bound (watch stays default tinycloud)
miss=""
for v in listen see enhance; do
  jq -e ".providers.$v.run" "$home/profiles/recon.json" >/dev/null 2>&1 || miss="$miss $v"
done
[ -z "$miss" ] && ok "profile.recon_bindings" "recon binds listen/see/enhance" || fail "profile.recon_bindings" "missing:$miss"

# --help advertises the provider keys
h="$($OVERCAST --help 2>/dev/null)"
for k in FAL_KEY ELEVENLABS_API_KEY HF_TOKEN; do
  echo "$h" | grep -q "$k" && ok "help.$k" "$k documented" || fail "help.$k" "$k missing from --help"
done

# listen --describe flag is on the verb surface (commands --json)
$OVERCAST commands --json 2>/dev/null | jq -e '.verbs[]|select(.name=="listen")|.flags[]|select(.name=="describe")' >/dev/null \
  && ok "listen.describe_flag" "listen --describe in registry" || fail "listen.describe_flag" "missing"
