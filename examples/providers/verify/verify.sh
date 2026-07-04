#!/usr/bin/env bash
# overcast `verify` provider — C2PA / Content Credentials provenance via the
# `c2patool` CLI (system tool, no API key). Default backend for the `verify`
# sense. Reports whether a captured/sensed image or video carries a signed
# provenance manifest (increasingly present on AI-generated + pro-camera media),
# who signed it, and the validation state.
# Contract: init | describe | run --input <media>
# Emits a media.provenance record: { summary, has_manifest, claim_generator,
# signer, signature_alg, validation_state, validation_codes, assertions,
# ingredients, active_manifest, title }.
#
# NOTE: distinct from overcast's source-post provenance (src/verbs/provenance.ts,
# which stamps where a record CAME FROM). This verb checks the media's own
# embedded C2PA credentials.
set -uo pipefail

need_c2patool() {
  command -v c2patool >/dev/null 2>&1 || {
    cat >&2 <<'MSG'
verify needs `c2patool` (not found on PATH). Install one of:
  • brew install c2patool
  • cargo install c2patool
  • https://github.com/contentauth/c2pa-rs/releases
MSG
    exit 13
  }
}

op="${1:-run}"
case "$op" in
  init)     need_c2patool; exit 0 ;;
  describe) echo '{"verb":"verify","kind":"media.provenance","payload":["summary","has_manifest","claim_generator","signer","validation_state"],"needs":["c2patool"]}'; exit 0 ;;
esac

input=""; input_set=0
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; input_set=1; shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) [ "$input_set" = 1 ] || input="$1"; shift ;;
esac; done
need_c2patool
[ -f "$input" ] || { jq -nc --arg i "$input" '{verb:"verify",format:"json",payload:{error:("file not found: "+$i)},error:"file not found",state:"error"}'; exit 0; }

errf="$(mktemp)"
out="$(c2patool "$input" 2>"$errf")"; code=$?
err="$(cat "$errf")"; rm -f "$errf"

if [ "$code" -ne 0 ]; then
  case "$err" in
    *"No claim found"*|*"no claim"*|*"No claim"*|*"JumbfNotFound"*)
      # a valid, expected result: the media simply carries no content credentials
      jq -nc --arg ref "$input" '{verb:"verify",format:"json",
        payload:{summary:"no content credentials (no C2PA manifest)",has_manifest:false},
        media:{ref:$ref},meta:{provider:"c2patool"},state:"ready"}'
      exit 0 ;;
    *)
      jq -nc --arg ref "$input" --arg e "$err" '{verb:"verify",format:"json",
        payload:{has_manifest:null},media:{ref:$ref},
        error:("c2patool failed: " + ($e|.[0:300])),state:"error"}'
      exit 0 ;;
  esac
fi

# c2patool can exit 0 yet print output with no active manifest (empty / minimal
# JSON) — don't claim has_manifest:true for that. Treat it as "no credentials".
if ! printf '%s' "$out" | jq -e 'type == "object" and ((.active_manifest // "") | tostring | length > 0)' >/dev/null 2>&1; then
  jq -nc --arg ref "$input" '{verb:"verify",format:"json",
    payload:{summary:"no content credentials (no C2PA manifest)",has_manifest:false},
    media:{ref:$ref},meta:{provider:"c2patool"},state:"ready"}'
  exit 0
fi

# manifest present — map the c2patool manifest store to a compact record.
printf '%s' "$out" | jq -c --arg ref "$input" '
  .active_manifest as $a
  | (.manifests[$a] // {}) as $m
  | ($m.claim_generator_info[0] // {}) as $gen
  | ([(.validation_status // [])[].code] | unique) as $codes
  | (if ($gen.name // "") != ""
     then $gen.name + (if ($gen.version // "") != "" then " " + $gen.version else "" end)
     else null end) as $genstr
  | {
      verb:"verify", format:"json",
      payload:{
        summary: ("C2PA manifest"
                  + (if $genstr != null then " · gen:" + $genstr else "" end)
                  + (if ($m.signature_info.issuer // "") != "" then " · signer:" + $m.signature_info.issuer else "" end)
                  + (if (.validation_state // "") != "" then " · " + .validation_state else "" end)),
        has_manifest: true,
        claim_generator: $genstr,
        signer: ($m.signature_info.issuer // null),
        signature_alg: ($m.signature_info.alg // null),
        validation_state: (.validation_state // null),
        validation_codes: $codes,
        assertions: (($m.assertions // []) | length),
        ingredients: (($m.ingredients // []) | length),
        active_manifest: $a,
        title: ($m.title // null)
      },
      media:{ref:$ref},
      meta:{provider:"c2patool"},
      state:"ready"
    }'
