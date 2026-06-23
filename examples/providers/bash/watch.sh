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

# run: <provider> <input> --json    (overcast renders {{input}})
input="${2:-${1}}"
desc="$(tinycloud watch "$input" --json)"
content="$(jq -r '.data.summary // ""' <<<"$desc")"
jq -n --arg c "$content" --argjson d "$(jq '.data' <<<"$desc")" --arg ref "$input" \
  '{verb:"watch", format:"json",
    payload:{content:$c, transcript:"", detailed:$d},
    media:{ref:$ref}, meta:{provider:"tinycloud"}, state:"ready"}'
