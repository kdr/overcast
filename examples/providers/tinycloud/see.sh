#!/usr/bin/env bash
# overcast `see` provider — Cloudglue tinycloud (>= 0.3.7, see.v1 + extract.images.v1).
# File-level image analysis through the tinycloud CLI: description + on-screen text
# via `tinycloud see`; `--prompt` / `--detect` route through `tinycloud extract`
# (image sources are new in 0.3.7). JPEG/PNG/WebP only; results cache by source.
# `--detect` returns presence facts ({label, present, count, evidence}) WITHOUT
# bounding boxes — `crop` does not apply to these detections (bind the OWLv2
# detector for boxes). Contract:
#   init | describe | run --input <img> [--ocr] [--prompt "<focus>"] [--detect "a,b"]
#   overcast setup provider see "exec:bash examples/providers/tinycloud/see.sh --input {{input}}"
# NOTE: keep the run template a `bash …` wrapper — a template that starts with
# `tinycloud` is treated as the built-in default binding and is skipped for `see`.
# Override the tinycloud invocation with OVERCAST_TINYCLOUD_CMD (tokenized on
# spaces; space-containing paths aren't supported by this sample).
set -uo pipefail

read -r -a TC <<<"${OVERCAST_TINYCLOUD_CMD:-tinycloud}"

need() {
  [ -n "${CLOUDGLUE_API_KEY:-}" ] || [ -f "$HOME/.tinycloud/config.json" ] || {
    echo "see (tinycloud) needs CLOUDGLUE_API_KEY or ~/.tinycloud/config.json (https://app.cloudglue.dev)" >&2
    exit 13
  }
}

op="${1:-run}"
case "$op" in
  init)
    command -v "${TC[0]}" >/dev/null || { echo "install tinycloud >= 0.3.7: npm i -g @cloudglue/tinycloud (https://tinycloud.sh)" >&2; exit 1; }
    need
    # `see` needs 0.3.7+; probe the feature flag, not the version string.
    if ! "${TC[@]}" --version 2>/dev/null | tail -n 1 | jq -e '(.features // []) | index("see.v1")' >/dev/null 2>&1; then
      echo "tinycloud >= 0.3.7 with the see.v1 feature is required — run \`tinycloud update\`" >&2
      exit 1
    fi
    exit 0 ;;
  describe)
    echo '{"verb":"see","kind":"image.analysis","payload":["caption","ocr","detections"],"model":"tinycloud:see+extract","needs":["CLOUDGLUE_API_KEY"]}'
    exit 0 ;;
esac

# run: accept both `run --input <ref>` and a bare positional; ignore unknown flags.
if [ "$op" = "run" ]; then shift; fi
input=""; ocr=0; prompt=""; detect=""; input_set=0
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; input_set=1; shift 2 2>/dev/null || shift ;;
  --ocr) ocr=1; shift ;;
  --prompt) prompt="${2:-}"; shift 2 2>/dev/null || shift ;;
  --detect) detect="${2:-}"; shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) [ "$input_set" = 1 ] || input="$1"; shift ;;
esac; done
need

fail_record() { # $1=error message
  jq -nc --arg e "$1" --arg ref "$input" --arg m "$PROVIDER" \
    '{verb:"see",format:"json",payload:{caption:"",ocr:"",detections:[]},media:{ref:$ref},meta:{provider:$m},error:$e,state:"error"}'
  exit 0
}

cred_record() { # $1=error message
  jq -nc --arg e "$1" --arg ref "$input" --arg m "$PROVIDER" \
    '{verb:"see",format:"json",payload:{caption:"",ocr:"",detections:[]},media:{ref:$ref},meta:{provider:$m},error:$e,state:"needs_credentials"}'
  exit 0
}

pending_record() {
  jq -nc --arg ref "$input" --arg m "$PROVIDER" \
    '{verb:"see",format:"json",payload:{caption:"",ocr:"",detections:[]},media:{ref:$ref},meta:{provider:$m},state:"pending"}'
  exit 0
}

PROVIDER="tinycloud:see"
[ -f "$input" ] || fail_record "image not found: $input"
case "$(echo "${input##*.}" | tr '[:upper:]' '[:lower:]')" in
  jpg|jpeg|png|webp) : ;;
  *) fail_record "tinycloud see/extract supports JPEG/PNG/WebP images only — transcode ${input##*/} first" ;;
esac

# --- dispatch: plain/--ocr → `tinycloud see`; --prompt/--detect → `tinycloud extract`
if [ -n "$detect" ]; then
  PROVIDER="tinycloud:extract"
  q="For each of: ${detect} — is it present, approximate count, one-line evidence"
  [ -n "$prompt" ] && q="Context: ${prompt}. ${q}"
  resp="$("${TC[@]}" extract "$q" "$input" --json 2>/dev/null)"; code=$?
elif [ -n "$prompt" ]; then
  PROVIDER="tinycloud:extract"
  resp="$("${TC[@]}" extract "$prompt" "$input" --json 2>/dev/null)"; code=$?
elif [ "$ocr" = "1" ]; then
  resp="$("${TC[@]}" see "$input" --json 2>/dev/null)"; code=$?
else
  # skip the on-screen-text read unless --ocr asked for it
  resp="$("${TC[@]}" see "$input" --visual-only --json 2>/dev/null)"; code=$?
fi

env_line="$(printf '%s\n' "$resp" | tail -n 1)"
if ! jq -e . >/dev/null 2>&1 <<<"$env_line"; then
  if [ "$code" = "2" ] || [ "$code" = "13" ]; then
    cred_record "tinycloud needs credentials (set CLOUDGLUE_API_KEY)"
  fi
  [ "$code" = "3" ] && pending_record
  fail_record "tinycloud returned invalid JSON (exit $code)"
fi

# --- envelope → loose record: status + exit code decide state (never trust
#     ready + non-zero exit); tinycloud errors may be {code,message} objects.
status="$(jq -r '.status // .state // .data.status // .data.state // empty' <<<"$env_line")"
err="$(jq -r '(.error // .data.error // empty) | if type == "object" then (.message // .code // tostring) else . end' <<<"$env_line")"
if [ "$status" = "needs_credentials" ] || [ "$status" = "needs_auth" ] || [ "$code" = "2" ] || [ "$code" = "13" ]; then
  cred_record "${err:-tinycloud needs credentials (set CLOUDGLUE_API_KEY)}"
fi
[ "$code" = "3" ] && pending_record
[ -n "$err" ] && fail_record "$err"
case "$status" in
  error|failed) fail_record "tinycloud reported an error" ;;
  pending|in_progress|processing|running|queued|paused|needs_upload|needs_download) # defensive: --background is never passed here
    pending_record ;;
  ready|completed|success|ok|"") [ "$code" != "0" ] && fail_record "tinycloud exited $code despite a ready envelope" ;;
  *) [ "$code" = "0" ] && {
       pending_record
     }
     fail_record "unexpected tinycloud status '${status:-none}' (exit $code)" ;;
esac

if [ "$PROVIDER" = "tinycloud:see" ]; then
  # data: {title, summary, description, scene_text, …}
  jq -c --arg ref "$input" --arg m "$PROVIDER" --argjson ocr "$([ "$ocr" = "1" ] && echo true || echo false)" '
    (.data // {}) as $d |
    ([$d.title, ($d.description // $d.summary)] | map(select(. != null and . != "")) | join(" — ")) as $cap |
    {verb:"see", format:"json",
     payload:{caption:$cap, ocr:(if $ocr then ($d.scene_text // "") else "" end), detections:[]},
     media:{ref:$ref}, meta:{provider:$m}, state:"ready"}' <<<"$env_line"
elif [ -n "$detect" ]; then
  # extract data.result.entities: {<label>: {present, approximate_count, one_line_evidence}}
  jq -c --arg ref "$input" --arg m "$PROVIDER" --arg want "$detect" '
    (.data.result.entities // {}) as $e |
    (if ($e | type) == "object" then
       ($e | to_entries | map({label: (.key | gsub("_"; " ")),
                               present: (.value.present == true),
                               count: (.value.approximate_count // .value.count // null),
                               evidence: ((.value.one_line_evidence // .value.evidence // "") | tostring)}))
     else [] end) as $det |
    {verb:"see", format:"json",
     payload:{caption:(.summary // ""), ocr:"", detections:$det,
              counts:($det | map(select(.present)) | map({(.label): (.count // 1)}) | add // {}),
              detect:$want, extract:(.data.result // .data // null)},
     media:{ref:$ref}, meta:{provider:$m}, state:"ready"}' <<<"$env_line"
else
  jq -c --arg ref "$input" --arg m "$PROVIDER" '
    {verb:"see", format:"json",
     payload:{caption:(.summary // ""), ocr:"", detections:[],
              extract:(.data.result.entities // .data.result // .data // null)},
     media:{ref:$ref}, meta:{provider:$m}, state:"ready"}' <<<"$env_line"
fi
