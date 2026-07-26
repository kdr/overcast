#!/usr/bin/env bash
# overcast `reconstruct` provider — fal.ai (direct, FAL_KEY). A TOOLBOX: one
# binding, dispatched by --ops. EVERYTHING it emits is SYNTHESIZED imagery — the
# payload carries `caveat` and the verb quarantines the records from evidence.
#   --ops view    (default) reposition the camera on a still: --rotate <deg>
#                 (azimuth; 0 front / 90 right / 180 behind; negatives wrap),
#                 --elevate <-30..90>, --zoom <0..10> (Qwen-Image-Edit-2511
#                 multiple-angles LoRA) -> one synthesized view
#   --ops sweep   --count (default 8, 2-24) stops around 360° at the same
#                 --elevate/--zoom -> one synthesized view per stop
#   --ops model   lift a textured 3D mesh from the still (Trellis, or any
#                 image-to-3D queue model via $FAL_RECONSTRUCT_MESH_MODEL,
#                 e.g. fal-ai/hunyuan3d-v3/image-to-3d) -> GLB. Uses the fal
#                 QUEUE API (submit + poll) — mesh generation runs minutes.
#   --ops depth   estimate a depth map (Depth Anything V2) -> grayscale PNG
#   --ops age     age (+N) / de-age (-N) the SUBJECT OF A REAL PHOTO by
#                 --age-years <±years> via an identity-preserving instruction
#                 edit (FLUX.1 Kontext, or any image-edit endpoint via
#                 $FAL_RECONSTRUCT_AGE_MODEL) -> one aged still. The output is a
#                 speculative synthesized LIKENESS — the emitted caveat says so
#                 in words: never a face/cluster/similar match probe. There is
#                 deliberately NO text-only composite path (a real anchor photo
#                 is required, like every other op).
# Bind:
#   overcast provider setup apply --verb reconstruct --choice fal --yes
# Models: $FAL_RECONSTRUCT_VIEW_MODEL, $FAL_RECONSTRUCT_MESH_MODEL,
# $FAL_RECONSTRUCT_DEPTH_MODEL, $FAL_RECONSTRUCT_AGE_MODEL. Queue knobs:
# $FAL_QUEUE_POLL_S (5),
# $FAL_QUEUE_TIMEOUT_S (600). Output lands in $OVERCAST_MEDIA_DIR/reconstruct;
# the record's payload.outputs[] is fanned out into a child record per artifact.
set -uo pipefail

VIEW_MODEL="${FAL_RECONSTRUCT_VIEW_MODEL:-fal-ai/qwen-image-edit-2511-multiple-angles}"
MESH_MODEL="${FAL_RECONSTRUCT_MESH_MODEL:-fal-ai/trellis}"
DEPTH_MODEL="${FAL_RECONSTRUCT_DEPTH_MODEL:-fal-ai/image-preprocessors/depth-anything/v2}"
AGE_MODEL="${FAL_RECONSTRUCT_AGE_MODEL:-fal-ai/flux-pro/kontext}"
QPOLL="${FAL_QUEUE_POLL_S:-5}"
QTIMEOUT="${FAL_QUEUE_TIMEOUT_S:-600}"
KEY="${FAL_KEY:-${FAL_API_KEY:-}}"
OUTDIR="${OVERCAST_MEDIA_DIR:-.}"
CAVEAT="generative reconstruction — synthesized by a model, speculative, NOT photographic evidence"
need() { [ -n "$KEY" ] || { echo "reconstruct (fal.ai) needs FAL_KEY (https://fal.ai/dashboard/keys)" >&2; exit 13; }; }

emit_err() { jq -nc --arg e "$1" '{verb:"reconstruct",format:"json",payload:{},error:$e,state:"error"}'; }
# Upload a local file (mime $2) to fal storage and print its public URL (same
# two-step signed-URL PUT as fal/enhance.sh — data URLs are rejected at size).
fal_upload() {
  local f="$1" ct="$2" init up fu
  init="$(curl -s -m 120 -X POST "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3" \
    -H "Authorization: Key $KEY" -H "Content-Type: application/json" \
    -d "$(jq -nc --arg ct "$ct" --arg fn "$(basename "$f")" '{content_type:$ct,file_name:$fn}')")"
  up="$(jq -r '.upload_url // empty' <<<"$init" 2>/dev/null)"
  fu="$(jq -r '.file_url // empty' <<<"$init" 2>/dev/null)"
  { [ -n "$up" ] && [ -n "$fu" ]; } || return 1
  curl -fsS -m 300 -X PUT -H "Content-Type: $ct" --data-binary @"$f" "$up" >/dev/null 2>&1 || return 1
  printf '%s' "$fu"
}

op="${1:-run}"
case "$op" in
  init)     need; exit 0 ;;
  describe) echo "{\"verb\":\"reconstruct\",\"kind\":\"media.reconstruction\",\"ops\":[\"view\",\"sweep\",\"model\",\"depth\",\"age\"],\"view_model\":\"$VIEW_MODEL\",\"mesh_model\":\"$MESH_MODEL\",\"depth_model\":\"$DEPTH_MODEL\",\"age_model\":\"$AGE_MODEL\",\"caveat\":\"synthesized imagery — not evidence\",\"needs\":[\"FAL_KEY\"]}"; exit 0 ;;
esac

input=""; ops=""; rotate=""; elevate=""; zoom=""; count=""; prompt=""; seed=""; age_years=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input)     input="${2:-}"; shift 2 2>/dev/null || shift ;;
  --ops)       ops="${2:-}"; shift 2 2>/dev/null || shift ;;
  --rotate)    rotate="${2:-}"; shift 2 2>/dev/null || shift ;;
  --elevate)   elevate="${2:-}"; shift 2 2>/dev/null || shift ;;
  --zoom)      zoom="${2:-}"; shift 2 2>/dev/null || shift ;;
  --count)     count="${2:-}"; shift 2 2>/dev/null || shift ;;
  --age-years) age_years="${2:-}"; shift 2 2>/dev/null || shift ;;
  --prompt)    prompt="${2:-}"; shift 2 2>/dev/null || shift ;;
  --seed)      seed="${2:-}"; shift 2 2>/dev/null || shift ;;
  --*)         shift ;;
  *)           input="$1"; shift ;;
esac; done
ops="$(printf '%s' "$ops" | tr '[:upper:]' '[:lower:]')"
[ -n "$ops" ] || ops="view"
case "$ops" in
  view|sweep|model|depth|age) : ;;
  *) emit_err "unknown --ops '$ops' (valid: view, sweep, model, depth, age)"; exit 0 ;;
esac
need
[ -f "$input" ] || { emit_err "input not found: $input"; exit 0; }
ext="$(printf '%s' "${input##*.}" | tr '[:upper:]' '[:lower:]')"
case "$ext" in
  jpg|jpeg|png|webp|bmp) : ;;
  *) emit_err "reconstruct is image-only (got .$ext); pass a still or let the verb extract a video frame (--at)"; exit 0 ;;
esac
base="$(basename "${input%.*}")"
mkdir -p "$OUTDIR/reconstruct"
subtype="$ext"; [ "$subtype" = "jpg" ] && subtype="jpeg"
IMIME="image/$subtype"

# Per-run signature folded into every output filename so a re-run with DIFFERENT
# params (or a different source of the same basename) can't overwrite an earlier
# run's artifacts and strand its record on stale pixels. Identical params hash the
# same (idempotent regeneration), distinct params diverge — the collision-free
# intent contactSheet/grid already use. Portable across sha256sum / shasum / cksum.
hash10() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-10
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -c1-10
  else cksum | tr -d ' ' | cut -c1-10; fi
}
RUNSIG="$(printf '%s' "$input|$ops|$rotate|$elevate|$zoom|$count|$age_years|$prompt|$seed" | hash10)"

# normalize any azimuth (incl. negatives / >360) into [0,360)
norm_az() { awk -v a="${1:-0}" 'BEGIN{m=a%360; if(m<0)m+=360; printf "%g", m}'; }
# filesystem-safe number tag (12.5 -> 12p5, -30 handled by norm upstream)
ntag() { printf '%s' "$1" | tr '.' 'p' | tr -dc '0-9p-'; }

# ---- one Qwen multiple-angles call: print an outputs[] item JSON, or set
# GEN_ERR and print nothing. $1 = azimuth (already normalized).
GEN_ERR=""
gen_view() {
  local az="$1" body resp url out rseed
  body="$(jq -nc --arg u "$IURL" --arg h "$az" --arg v "$elevate" --arg z "$zoom" --arg p "$prompt" --arg s "$seed" '
    {image_urls:[$u], horizontal_angle:($h|tonumber), output_format:"png", num_images:1}
    + (if $v != "" then {vertical_angle:($v|tonumber)} else {} end)
    + (if $z != "" then {zoom:($z|tonumber)} else {} end)
    + (if $p != "" then {additional_prompt:$p} else {} end)
    + (if $s != "" then {seed:($s|tonumber)} else {} end)')"
  resp="$(curl -s -m 300 -X POST "https://fal.run/$VIEW_MODEL" -H "Authorization: Key $KEY" -H "Content-Type: application/json" -d "$body")"
  url="$(jq -r '.images[0].url // empty' <<<"$resp" 2>/dev/null)"
  if [ -z "$url" ]; then
    GEN_ERR="$(jq -r '(.detail // .error // "view synthesis failed") | if type=="string" then . else tojson end' <<<"$resp" 2>/dev/null | head -c 300)"
    return 1
  fi
  out="$OUTDIR/reconstruct/${base}_${RUNSIG}_az$(ntag "$az")${elevate:+_el$(ntag "$elevate")}${zoom:+_z$(ntag "$zoom")}.png"
  curl -fsS -m 300 -o "$out" "$url" && [ -s "$out" ] || { GEN_ERR="synthesized view download failed"; rm -f "$out"; return 1; }
  rseed="$(jq -r '.seed // empty' <<<"$resp" 2>/dev/null)"
  jq -nc --arg ref "$out" --arg az "$az" --arg v "$elevate" --arg z "$zoom" --arg s "$rseed" '
    {kind:"view", ref:$ref, azimuth:($az|tonumber)}
    + (if $v != "" then {elevate:($v|tonumber)} else {} end)
    + (if $z != "" then {zoom:($z|tonumber)} else {} end)
    + (if $s != "" then {seed:($s|tonumber)} else {} end)'
}

emit_ready() { # $1 op, $2 model, $3 outputs json, $4 extra payload json
  jq -nc --arg inp "$input" --arg m "$2" --arg o "$1" --arg cv "$CAVEAT" --argjson outs "$3" --argjson extra "$4" \
    '{verb:"reconstruct",format:"json",
      payload:({op:$o,input:$inp,model:$m,caveat:$cv,count:($outs|length),outputs:$outs} + $extra),
      media:{ref:$inp},meta:{provider:("fal:"+$m)},state:"ready"}'
}

# ---- --ops view : single camera reposition -----------------------------------
do_view() {
  if [ -z "$rotate" ] && [ -z "$elevate" ] && [ -z "$zoom" ]; then
    emit_err "view needs a camera move: --rotate <deg>, --elevate <deg>, and/or --zoom <0-10>"; return
  fi
  local az item extra
  az="$(norm_az "${rotate:-0}")"
  IURL="$(fal_upload "$input" "$IMIME")" || { emit_err "fal: image upload to storage failed"; return; }
  item="$(gen_view "$az")" || { emit_err "$GEN_ERR"; return; }
  extra="$(jq -nc --arg r "${rotate:-0}" --arg v "$elevate" --arg z "$zoom" '
    {rotate:($r|tonumber)}
    + (if $v != "" then {elevate:($v|tonumber)} else {} end)
    + (if $z != "" then {zoom:($z|tonumber)} else {} end)')"
  emit_ready "view" "$VIEW_MODEL" "[$item]" "$extra"
}

# ---- --ops sweep : n stops around 360° ---------------------------------------
do_sweep() {
  local n="${count:-8}" i=0 az item outputs="[]" errs=""
  case "$n" in ''|*[!0-9]*) emit_err "--count must be an integer (got '$n')"; return ;; esac
  if [ "$n" -lt 2 ] || [ "$n" -gt 24 ]; then emit_err "--count $n out of range (2-24 stops)"; return; fi
  IURL="$(fal_upload "$input" "$IMIME")" || { emit_err "fal: image upload to storage failed"; return; }
  while [ "$i" -lt "$n" ]; do
    az="$(awk -v i="$i" -v n="$n" 'BEGIN{printf "%g", i*360/n}')"
    if item="$(gen_view "$az")" && [ -n "$item" ]; then
      outputs="$(jq -c --argjson it "$item" '. + [$it]' <<<"$outputs")"
    else
      errs="${errs}${errs:+; }az $az: ${GEN_ERR:-failed}"
    fi
    i=$((i + 1))
  done
  if [ "$(jq 'length' <<<"$outputs")" = "0" ]; then
    emit_err "sweep: every stop failed — ${errs:-no detail}"; return
  fi
  local extra
  extra="$(jq -nc --arg v "$elevate" --arg z "$zoom" --arg e "$errs" '
    {} + (if $v != "" then {elevate:($v|tonumber)} else {} end)
      + (if $z != "" then {zoom:($z|tonumber)} else {} end)
      + (if $e != "" then {stop_errors:$e} else {} end)')"
  emit_ready "sweep" "$VIEW_MODEL" "$outputs" "$extra"
}

# ---- --ops model : image -> 3D mesh via the fal QUEUE API --------------------
# Mesh generation runs minutes; fal.run would 5xx/timeout. Submit to
# queue.fal.run, then poll the returned status_url until COMPLETED and fetch
# response_url. Trellis takes image_url; hunyuan takes input_image_url.
do_model() {
  local key sub status_url response_url waited=0 empties=0 st s resp murl out
  local max_empty="${FAL_QUEUE_MAX_EMPTY:-6}"
  IURL="$(fal_upload "$input" "$IMIME")" || { emit_err "fal: image upload to storage failed"; return; }
  case "$MESH_MODEL" in
    *hunyuan*) key="input_image_url" ;;
    *)         key="image_url" ;;
  esac
  sub="$(curl -s -m 60 -X POST "https://queue.fal.run/$MESH_MODEL" -H "Authorization: Key $KEY" -H "Content-Type: application/json" \
    -d "$(jq -nc --arg u "$IURL" --arg k "$key" '{($k):$u}')")"
  status_url="$(jq -r '.status_url // empty' <<<"$sub" 2>/dev/null)"
  response_url="$(jq -r '.response_url // empty' <<<"$sub" 2>/dev/null)"
  if [ -z "$status_url" ] || [ -z "$response_url" ]; then
    emit_err "$(jq -r '(.detail // .error // "fal queue submit failed") | if type=="string" then . else tojson end' <<<"$sub" 2>/dev/null | head -c 300)"; return
  fi
  while :; do
    st="$(curl -s -m 30 -H "Authorization: Key $KEY" "$status_url" 2>/dev/null)"
    s="$(jq -r '.status // empty' <<<"$st" 2>/dev/null)"
    [ "$s" = "COMPLETED" ] && break
    if [ -n "$s" ]; then
      empties=0
      if [ "$s" != "IN_QUEUE" ] && [ "$s" != "IN_PROGRESS" ]; then
        emit_err "fal queue: $MESH_MODEL returned status $s"; return
      fi
    else
      # a status poll with NO status field (curl failure / empty / malformed
      # body) must not spin silently to the full QTIMEOUT — bail after a few
      # consecutive empties so a broken status endpoint fails fast.
      empties=$((empties + 1))
      if [ "$empties" -ge "$max_empty" ]; then
        emit_err "fal queue: $MESH_MODEL status endpoint returned no status $empties times (endpoint down or bad response)"; return
      fi
    fi
    if [ "$waited" -ge "$QTIMEOUT" ]; then
      emit_err "fal queue: $MESH_MODEL timed out after ${QTIMEOUT}s (raise FAL_QUEUE_TIMEOUT_S)"; return
    fi
    sleep "$QPOLL"; waited=$((waited + QPOLL))
  done
  resp="$(curl -s -m 300 -H "Authorization: Key $KEY" "$response_url")"
  murl="$(jq -r '(.model_mesh.url // .model_glb.url // .model_glb_pbr.url // .model_url // empty)' <<<"$resp" 2>/dev/null)"
  if [ -z "$murl" ]; then
    emit_err "$(jq -r '(.detail // .error // "mesh generation returned no model file") | if type=="string" then . else tojson end' <<<"$resp" 2>/dev/null | head -c 300)"; return
  fi
  out="$OUTDIR/reconstruct/${base}_${RUNSIG}_mesh.glb"
  curl -fsS -m 600 -o "$out" "$murl" && [ -s "$out" ] || { rm -f "$out"; emit_err "mesh download failed or empty"; return; }
  emit_ready "model" "$MESH_MODEL" "$(jq -nc --arg r "$out" '[{kind:"mesh",ref:$r,format:"glb"}]')" "{}"
}

# ---- --ops age : speculative age progression of the photo's subject ---------
# Identity-preserving instruction edit (FLUX.1 Kontext default; any image-edit
# endpoint via $FAL_RECONSTRUCT_AGE_MODEL — qwen/nano-banana style endpoints
# take image_urls[], kontext-style take image_url). The verb validates the
# delta; this re-checks so a raw exec bind fails cleanly too. Output caveat is
# the EXTENDED age caveat: synthesized likeness, never a match probe.
do_age() {
  local n body resp url out rseed key ptext
  case "$age_years" in
    ''|+|-) emit_err "age needs --age-years <±years> (e.g. +20 to age forward, -10 to de-age)"; return ;;
  esac
  if ! printf '%s' "$age_years" | grep -Eq '^[+-]?[0-9]+$'; then
    emit_err "--age-years must be a whole number of years (got '$age_years')"; return
  fi
  n=$((age_years))
  if [ "$n" -eq 0 ]; then emit_err "--age-years 0 is a no-op — pass a non-zero delta"; return; fi
  if [ "$n" -lt -40 ] || [ "$n" -gt 60 ]; then emit_err "--age-years $n out of range (-40 de-age … +60 age forward)"; return; fi
  if [ "$n" -gt 0 ]; then
    ptext="Age the person in this photo by $n years. Keep the same identity, facial structure, pose, expression, lighting and background — photorealistic natural aging only (skin texture, wrinkles, hair color and density). Change nothing else about the image."
  else
    ptext="Make the person in this photo $((0 - n)) years younger. Keep the same identity, facial structure, pose, expression, lighting and background — photorealistic natural de-aging only. Change nothing else about the image."
  fi
  [ -n "$prompt" ] && ptext="$ptext $prompt"
  IURL="$(fal_upload "$input" "$IMIME")" || { emit_err "fal: image upload to storage failed"; return; }
  case "$AGE_MODEL" in
    *qwen*|*nano-banana*) key="image_urls" ;;
    *)                    key="image_url" ;;
  esac
  body="$(jq -nc --arg u "$IURL" --arg k "$key" --arg p "$ptext" --arg s "$seed" '
    {($k): (if $k == "image_urls" then [$u] else $u end), prompt:$p, output_format:"png", num_images:1}
    + (if $s != "" then {seed:($s|tonumber)} else {} end)')"
  resp="$(curl -s -m 300 -X POST "https://fal.run/$AGE_MODEL" -H "Authorization: Key $KEY" -H "Content-Type: application/json" -d "$body")"
  url="$(jq -r '(.images[0].url // .image.url // empty)' <<<"$resp" 2>/dev/null)"
  if [ -z "$url" ]; then
    emit_err "$(jq -r '(.detail // .error // "age progression failed") | if type=="string" then . else tojson end' <<<"$resp" 2>/dev/null | head -c 300)"; return
  fi
  out="$OUTDIR/reconstruct/${base}_${RUNSIG}_age$(ntag "$n").png"
  curl -fsS -m 300 -o "$out" "$url" && [ -s "$out" ] || { rm -f "$out"; emit_err "aged image download failed or empty"; return; }
  rseed="$(jq -r '.seed // empty' <<<"$resp" 2>/dev/null)"
  # shellcheck disable=SC2034  # dynamic scope: emit_ready reads this CAVEAT
  local CAVEAT="$CAVEAT. This is a speculative synthesized likeness, not a photograph of the subject. Do NOT use it as a probe for face/cluster/similar matching or to identify anyone — it can invent identity-changing detail."
  emit_ready "age" "$AGE_MODEL" \
    "$(jq -nc --arg r "$out" --arg y "$n" --arg s "$rseed" '[{kind:"age",ref:$r,age_years:($y|tonumber)} + (if $s != "" then {seed:($s|tonumber)} else {} end)]')" \
    "$(jq -nc --arg y "$n" '{age_years:($y|tonumber)}')"
}

# ---- --ops depth : monocular depth estimate ----------------------------------
do_depth() {
  local resp url out
  IURL="$(fal_upload "$input" "$IMIME")" || { emit_err "fal: image upload to storage failed"; return; }
  resp="$(curl -s -m 300 -X POST "https://fal.run/$DEPTH_MODEL" -H "Authorization: Key $KEY" -H "Content-Type: application/json" \
    -d "$(jq -nc --arg u "$IURL" '{image_url:$u}')")"
  url="$(jq -r '(.image.url // .images[0].url // empty)' <<<"$resp" 2>/dev/null)"
  if [ -z "$url" ]; then
    emit_err "$(jq -r '(.detail // .error // "depth estimation failed") | if type=="string" then . else tojson end' <<<"$resp" 2>/dev/null | head -c 300)"; return
  fi
  out="$OUTDIR/reconstruct/${base}_${RUNSIG}_depth.png"
  curl -fsS -m 300 -o "$out" "$url" && [ -s "$out" ] || { rm -f "$out"; emit_err "depth map download failed or empty"; return; }
  emit_ready "depth" "$DEPTH_MODEL" "$(jq -nc --arg r "$out" '[{kind:"depth",ref:$r}]')" "{}"
}

IURL=""
case "$ops" in
  view)  do_view ;;
  sweep) do_sweep ;;
  model) do_model ;;
  depth) do_depth ;;
  age)   do_age ;;
esac
