#!/usr/bin/env bash
# Profiles + setup: bind per-verb providers into named profiles, verify they
# persist and load (the "different setups for different things" path).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=profiles
CASE=$(case_dir profiles)
EX="$PWD/examples/providers"

# a "recon" profile that binds three senses to opt-in providers
ocrun "$CASE" --profile recon setup provider listen "exec:bash $EX/elevenlabs/listen.sh {{input}}" --json >/dev/null 2>&1
ocrun "$CASE" --profile recon setup provider see    "exec:bash $EX/fal/see.sh {{input}}"            --json >/dev/null 2>&1
ocrun "$CASE" --profile recon setup provider enhance "exec:bash $EX/fal/enhance.sh {{input}}"        --json >/dev/null 2>&1

# show the profile back — bindings persisted
show="$(oc "$CASE" --profile recon setup show --json)"
save_json "40_profile_recon" "$show" >/dev/null
assert_nonempty "$C.listen_bound" "$(echo "$show"|jq -r '.payload.profile.providers.listen.run // empty')" "recon binds listen"
assert_nonempty "$C.see_bound"    "$(echo "$show"|jq -r '.payload.profile.providers.see.run // empty')"    "recon binds see"
assert_nonempty "$C.enhance_bound" "$(echo "$show"|jq -r '.payload.profile.providers.enhance.run // empty')" "recon binds enhance"

# provider list + describe through the bound profile
plist="$(oc "$CASE" --profile recon provider list --json)"
assert_nonempty "$C.provider_list" "$(echo "$plist"|jq -r '.payload.providers.see // empty | tostring')" "provider list shows see"
desc="$(oc "$CASE" --profile recon provider describe see --json)"
assert_eq "$C.provider_describe" "ready" "$(echo "$desc"|jq -r '.state')" "provider describe see runs the script"

# a SEPARATE profile is isolated (default has no recon bindings)
def="$(oc "$CASE" --profile default setup show --json)"
isolated="$(echo "$def" | jq -r '.payload.profile.providers.see.run // "none"')"
assert_eq "$C.isolation" "none" "$isolated" "default profile isn't polluted by recon"

# http binding → explicit error (transport not wired in v1), not silent fallback
ocrun "$CASE" --profile httptest setup provider see "http://localhost:9" --json >/dev/null 2>&1
FRAME="$SMOKE_DIR/prof_frame.jpg"; have_media "$VIDEO_OBJECTS" && frame_jpg "$VIDEO_OBJECTS" 1 "$FRAME"
if [ -f "$FRAME" ]; then
  he="$(oc "$CASE" --profile httptest see "$FRAME" --json)"
  if echo "$he" | jq -e '.state=="error" and (.error|test("http"))' >/dev/null 2>&1; then ok "$C.http_error" "http see binding → explicit transport error"; else fail "$C.http_error" "http binding not surfaced: $(echo "$he"|jq -rc '{state,error}')"; fi
fi
