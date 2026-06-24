#!/usr/bin/env bash
# overcast exec provider: watch (tinycloud) — the canonical v1 pattern.
# Bind with:  overcast setup provider watch "exec:./examples/providers/bash/watch.sh"
#             overcast provider init watch
set -euo pipefail
case "${1:-run}" in
  init)
    # minimal; production init defers to the tinycloud-init skill
    command -v tinycloud >/dev/null || { echo "install tinycloud (https://tinycloud.dev)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"verb":"watch","kind":"video.analysis","payload":["content","transcript","detailed"],"needs":["CLOUDGLUE_API_KEY"]}'
    exit 0 ;;
esac

# run: resolve the input ref. overcast renders {{input}} as a bare positional,
# but the documented exec contract is `run --input <ref> --json` — accept BOTH
# (and ignore --json / --format / other flags), like the other samples.
if [ "${1:-}" = "run" ]; then shift; fi
input=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) input="${2:-}"; shift 2 ;;
    --*) shift ;;
    *) input="$1"; shift ;;
  esac
done
if ! desc="$(tinycloud watch "$input" --json)"; then
  jq -n --arg ref "$input" '{verb:"watch",format:"json",payload:{content:"",transcript:"",detailed:null},media:{ref:$ref},meta:{provider:"tinycloud"},error:"tinycloud watch failed",state:"error"}'
  exit 0
fi
# surface a tinycloud error envelope or an empty/missing result as an error,
# rather than storing a failed analysis as a successful watch.
err="$(jq -r '(.error // .data.error // (if (.status=="error" or .data.status=="error") then "tinycloud reported an error" else "" end)) // ""' <<<"$desc" 2>/dev/null)"
content="$(jq -r '.data.summary // ""' <<<"$desc")"
data="$(jq -c '.data // null' <<<"$desc")"
if [ -n "$err" ] || { [ -z "$content" ] && [ "$data" = "null" ]; }; then
  jq -n --arg e "${err:-tinycloud watch produced no summary}" --arg ref "$input" \
    '{verb:"watch",format:"json",payload:{content:"",transcript:"",detailed:null},media:{ref:$ref},meta:{provider:"tinycloud"},error:$e,state:"error"}'
  exit 0
fi
jq -n --arg c "$content" --argjson d "$data" --arg ref "$input" \
  '{verb:"watch", format:"json",
    payload:{content:$c, transcript:"", detailed:$d},
    media:{ref:$ref}, meta:{provider:"tinycloud"}, state:"ready"}'
