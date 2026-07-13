#!/usr/bin/env bash
# Phase 8 e2e (offline, NO API calls): the shipped providers' `describe` contract
# + profile resolution. `describe`/`init`-less smoke needs no keys, so this runs
# in the default suite. Real provider calls live in the gated live workflows.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

P="$REPO/providers"            # shipped providers (sources/senses/engines)
EX="$REPO/examples/providers"  # authoring demos

# every shipped provider script answers `describe` with valid JSON (no key)
describe_ok() { # <label> <cmd...>
  local label="$1"; shift
  local out; out="$("$@" describe 2>/dev/null)"
  if jq -e . >/dev/null 2>&1 <<<"$out"; then ok "$label" "describe -> valid JSON"; else fail "$label" "bad describe: $out"; fi
}
describe_ok "describe.hf_see"      bash "$P/senses/hf/see.sh"
describe_ok "describe.hf_enhance"  python3 "$EX/python/enhance.py"
describe_ok "describe.fal_see"     bash "$P/senses/fal/see.sh"
describe_ok "describe.fal_enhance" bash "$P/senses/fal/enhance.sh"
describe_ok "describe.fal_reconstruct" bash "$P/senses/fal/reconstruct.sh"
describe_ok "describe.tinycloud_see" bash "$P/senses/tinycloud/see.sh"
describe_ok "describe.el_listen"   bash "$P/senses/elevenlabs/listen.sh"
describe_ok "describe.el_enhance"  bash "$P/senses/elevenlabs/enhance.sh"
describe_ok "describe.web"        bash "$P/sources/web.sh"
describe_ok "describe.youtube"     bash "$P/sources/youtube.sh"
describe_ok "describe.tiktok"      bash "$P/sources/tiktok.sh"
describe_ok "describe.x"           bash "$P/sources/x.sh"

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

# --- shipped: refs (plan 07 Stage B): catalog persists location-independent ----
# refs, `plan` shows the resolved path, describe/init resolve at exec time,
# old absolute-path profiles heal on load, and doctor flags what healing can't fix.
refhome="$SMOKE_DIR/home_refs"; mkdir -p "$refhome"
refcase="$SMOKE_DIR/case_refs"; mkdir -p "$refcase"

# plan: descriptor carries the ref; the resolved map points at a real file
plan="$($OVERCAST provider setup plan --verb enhance --choice ela --json --home "$refhome" --case "$refcase" 2>/dev/null)"
save_json "phase8_ela_plan" "$plan" >/dev/null
run_tpl="$(jq -r '.payload.changes[0].descriptor.run' <<<"$plan")"
assert_eq "refs.ela_plan_run" "python3 shipped:providers/senses/enhance/ela.py --input {{input}}" "$run_tpl" "ela plan descriptor is a shipped: ref"
resolved="$(jq -r '.payload.changes[0].resolved["shipped:providers/senses/enhance/ela.py"]' <<<"$plan")"
[ -f "$resolved" ] && ok "refs.ela_plan_resolved" "plan resolves the ref to a real file" || fail "refs.ela_plan_resolved" "unresolved: $resolved"

# apply: the profile persists the REF, never an absolute path
$OVERCAST provider setup apply --verb enhance --choice ela --yes --json --home "$refhome" --case "$refcase" >/dev/null 2>&1
prof="$refhome/profiles/default.json"
grep -q 'shipped:providers/senses/enhance/ela.py' "$prof" \
  && ok "refs.ela_profile_ref" "profile stores the shipped: ref" || fail "refs.ela_profile_ref" "ref missing from $prof"
grep -q "$REPO/providers" "$prof" \
  && fail "refs.no_abs_path" "profile leaked an absolute provider path" || ok "refs.no_abs_path" "no absolute provider path persisted"

# provider describe resolves the ref and runs the real script (python3 stdlib, offline)
d="$($OVERCAST provider describe enhance --json --home "$refhome" --case "$refcase" 2>/dev/null)"
save_json "phase8_ela_describe" "$d" >/dev/null
assert_eq "refs.ela_describe_state" "ready" "$(jq -r '.state' <<<"$d")" "describe resolved + ran"
jq -e '.payload.describe|fromjson|.ops[0]=="ela"' >/dev/null 2>&1 <<<"$d" \
  && ok "refs.ela_describe_json" "ela describe JSON round-trips" || fail "refs.ela_describe_json" "bad describe: $(jq -r '.payload.describe' <<<"$d")"

# geocode: the nominatim catalog choice binds end-to-end (no more raw-path hint)
$OVERCAST provider setup apply --verb geocode --choice nominatim --yes --json --home "$refhome" --case "$refcase" >/dev/null 2>&1
geo_run="$(jq -r '.providers.geocode.run' "$prof")"
assert_eq "refs.geocode_ref" "bash shipped:providers/senses/geocode/geocode.sh --input {{input}}" "$geo_run" "nominatim persists the shipped: ref"
gd="$($OVERCAST provider describe geocode --json --home "$refhome" --case "$refcase" 2>/dev/null)"
jq -e '.payload.describe|fromjson|.verb=="geocode"' >/dev/null 2>&1 <<<"$gd" \
  && ok "refs.geocode_describe" "geocode describe resolves + runs" || fail "refs.geocode_describe" "bad describe: $(jq -rc '.payload' <<<"$gd")"

# healing: an old-style absolute-path profile heals on load; the next profile
# write persists the ref; a custom path passes through untouched
healhome="$SMOKE_DIR/home_heal"; mkdir -p "$healhome/profiles"
cat >"$healhome/profiles/default.json" <<'JSON'
{
  "name": "default",
  "providers": {
    "enhance": {
      "type": "exec",
      "run": "python3 /opt/old-install/examples/providers/enhance/ela.py --input {{input}}",
      "init": { "command": "python3 /opt/old-install/examples/providers/enhance/ela.py init" },
      "describe": "python3 /opt/old-install/examples/providers/enhance/ela.py describe"
    },
    "see": { "type": "exec", "run": "bash /custom/see.sh --input {{input}}" }
  }
}
JSON
$OVERCAST setup llm cloudglue tinycloud:advanced --json --home "$healhome" --case "$refcase" >/dev/null 2>&1
grep -q 'shipped:providers/senses/enhance/ela.py' "$healhome/profiles/default.json" \
  && ok "heal.rewritten" "old examples/providers path healed to a shipped: ref" || fail "heal.rewritten" "no ref in healed profile"
grep -q '/opt/old-install/examples/providers' "$healhome/profiles/default.json" \
  && fail "heal.old_path_gone" "old absolute path survived the save" || ok "heal.old_path_gone" "old absolute path rewritten"
grep -q '/custom/see.sh' "$healhome/profiles/default.json" \
  && ok "heal.custom_untouched" "user-authored custom path untouched" || fail "heal.custom_untouched" "custom path was mangled"

# doctor: flags an unresolvable shipped: ref + a stale absolute path healing can't fix
stalehome="$SMOKE_DIR/home_stale_refs"; mkdir -p "$stalehome/profiles"
cat >"$stalehome/profiles/default.json" <<'JSON'
{
  "name": "default",
  "providers": {
    "enhance": { "type": "exec", "run": "python3 shipped:providers/senses/nope/missing.py --input {{input}}" },
    "see": { "type": "exec", "run": "bash /gone/providers/senses/fal/see.sh --input {{input}}" }
  }
}
JSON
doc="$($OVERCAST doctor --json --home "$stalehome" --case "$refcase" 2>/dev/null)"
save_json "phase8_doctor_refs" "$doc" >/dev/null
assert_eq "doctor.provider_paths" "false" "$(jq -r '.payload.checks[]|select(.name=="provider-paths")|.ok' <<<"$doc")" "doctor flags broken shipped paths"
jq -r '.payload.checks[]|select(.name=="provider-paths")|.detail' <<<"$doc" | grep -q 'unresolvable shipped:providers/senses/nope/missing.py' \
  && ok "doctor.unresolvable_ref" "unresolvable ref named in detail" || fail "doctor.unresolvable_ref" "detail missing the ref"
# stale = a gone absolute path whose shipped ref DOES resolve here (see.sh is a real
# shipped filename) — re-apply fixes it. A gone path whose ref doesn't resolve is a
# user's own provider and is NOT flagged (see unit coverage).
jq -r '.payload.checks[]|select(.name=="provider-paths")|.detail' <<<"$doc" | grep -q 'stale path /gone/providers/senses/fal/see.sh' \
  && ok "doctor.stale_path" "stale absolute path named in detail" || fail "doctor.stale_path" "detail missing the stale path"
jq -e '.payload.warnings[]|select(test("missing shipped provider files"))' >/dev/null 2>&1 <<<"$doc" \
  && ok "doctor.refs_warning" "shipped-path warning raised" || fail "doctor.refs_warning" "no warning"

# case-policy heal (Bugbot: case policies skip heal on load) — a case setup.json
# whose provider policy carries an OLD absolute path must NOT trip doctor's
# provider-paths check, because loadSetup now heals it just like loadProfile.
casepolhome="$SMOKE_DIR/home_casepol"; mkdir -p "$casepolhome/profiles"
casepolcase="$SMOKE_DIR/case_policy_heal"; mkdir -p "$casepolcase/.overcast"
cat >"$casepolcase/.overcast/setup.json" <<'JSON'
{
  "version": 1,
  "providers": {
    "enhance": {
      "verb": "enhance", "choice": "ela",
      "descriptor": { "type": "exec", "run": "python3 /opt/old-install/examples/providers/enhance/ela.py" }
    }
  }
}
JSON
cpdoc="$($OVERCAST doctor --json --home "$casepolhome" --case "$casepolcase" 2>/dev/null)"
cppaths="$(jq -r '.payload.checks[]|select(.name=="provider-paths")|.detail' <<<"$cpdoc")"
[ -n "$(echo "$cppaths" | grep -F '/opt/old-install/examples/providers')" ] \
  && fail "casepol.heal_no_false_positive" "doctor flagged a healable case-policy path: $cppaths" \
  || ok "casepol.heal_no_false_positive" "case-policy old path heals on load, no doctor false positive"
