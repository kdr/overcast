#!/usr/bin/env bash
# overcast `enhance` provider — fal.ai (direct, FAL_KEY). A TOOLBOX: one binding,
# dispatched by --ops.
#   (default)         image: faithful upscale (ESRGAN); audio: denoise+48kHz (DeepFilterNet3)
#   --ops separate    split an audio/video's voices/sounds by --prompt (SAM Audio) -> target + residual tracks
#   --ops segment     cut requested objects out of an image by --prompt (SAM 3) -> mask + RGBA cutout per instance
# The default `enhance` stays the internal ffmpeg toolkit; bind to opt in:
#   overcast setup provider enhance "exec:bash examples/providers/fal/enhance.sh {{input}}"
# Models: $FAL_ENHANCE_IMAGE_MODEL, $FAL_ENHANCE_AUDIO_MODEL, $FAL_SEPARATE_MODEL
# (fal-ai/sam-audio/separate), $FAL_SEGMENT_MODEL (fal-ai/sam-3/image). Split ops
# emit ONE record whose payload.outputs[] is fanned out into a record per artifact
# by the enhance verb. Output is written to $OVERCAST_MEDIA_DIR.
set -uo pipefail

IMG_MODEL="${FAL_ENHANCE_IMAGE_MODEL:-fal-ai/esrgan}"
AUD_MODEL="${FAL_ENHANCE_AUDIO_MODEL:-fal-ai/deepfilternet3}"
SEP_MODEL="${FAL_SEPARATE_MODEL:-fal-ai/sam-audio/separate}"
SEG_MODEL="${FAL_SEGMENT_MODEL:-fal-ai/sam-3/image}"
SEG_MAX="${SEGMENT_MAX_INSTANCES:-8}"
KEY="${FAL_KEY:-${FAL_API_KEY:-}}"
OUTDIR="${OVERCAST_MEDIA_DIR:-.}"
FFMPEG="${OVERCAST_FFMPEG:-ffmpeg}"
need() { [ -n "$KEY" ] || { echo "enhance (fal.ai) needs FAL_KEY (https://fal.ai/dashboard/keys)" >&2; exit 13; }; }

emit_err() { jq -nc --arg e "$1" '{verb:"enhance",format:"json",payload:{},error:$e,state:"error"}'; }
b64file() { base64 -i "$1" 2>/dev/null | tr -d '\n' || base64 "$1" | tr -d '\n'; }

op="${1:-run}"
case "$op" in
  init)     need; exit 0 ;;
  describe) echo "{\"verb\":\"enhance\",\"kind\":\"media.enhanced\",\"ops\":[\"separate\",\"segment\"],\"image_model\":\"$IMG_MODEL\",\"audio_model\":\"$AUD_MODEL\",\"separate_model\":\"$SEP_MODEL\",\"segment_model\":\"$SEG_MODEL\",\"needs\":[\"FAL_KEY\"]}"; exit 0 ;;
esac

input=""; ops=""; prompt=""; speakers=""; masks_only=0
while [ "$#" -gt 0 ]; do case "$1" in
  --input)      input="${2:-}"; shift 2 2>/dev/null || shift ;;
  --ops)        ops="${2:-}"; shift 2 2>/dev/null || shift ;;
  --prompt)     prompt="${2:-}"; shift 2 2>/dev/null || shift ;;
  --speakers)   speakers="${2:-}"; shift 2 2>/dev/null || shift ;;
  --masks-only) masks_only=1; shift ;;
  --*)          shift ;;
  *)            input="$1"; shift ;;
esac; done
: "${speakers:=}"  # accepted (SAM Audio doesn't use it); reserved for parity
need
[ -f "$input" ] || { emit_err "input not found: $input"; exit 0; }
mkdir -p "$OUTDIR"
ext="$(echo "${input##*.}" | tr 'A-Z' 'a-z')"
base="$(basename "${input%.*}")"

# ---- --ops separate : SAM Audio text-prompted source separation --------------
do_separate() {
  [ -n "$prompt" ] || { emit_err "separate needs --prompt (the voice/sound to isolate, e.g. --prompt 'the man speaking')"; return; }
  mkdir -p "$OUTDIR/separate"
  local src amime
  case "$ext" in
    mp4|mov|webm|mkv|avi|m4v)
      src="$OUTDIR/separate/${base}_audio.wav"
      "$FFMPEG" -y -i "$input" -vn -ac 1 -ar 48000 -acodec pcm_s16le "$src" >/dev/null 2>&1 || { emit_err "ffmpeg could not extract audio from $input"; return; }
      amime="audio/wav" ;;
    wav)  src="$input"; amime="audio/wav" ;;
    mp3)  src="$input"; amime="audio/mpeg" ;;
    flac) src="$input"; amime="audio/flac" ;;
    *)    src="$input"; amime="audio/$ext" ;;
  esac
  local b64 body resp turl rurl tout rout
  b64="$(b64file "$src")"
  body="$(jq -nc --arg u "data:$amime;base64,$b64" --arg p "$prompt" '{audio_url:$u,prompt:$p}')"
  resp="$(curl -s -m 600 -X POST "https://fal.run/$SEP_MODEL" -H "Authorization: Key $KEY" -H "Content-Type: application/json" -d "$body")"
  turl="$(jq -r '.target.url // empty' <<<"$resp" 2>/dev/null)"
  rurl="$(jq -r '.residual.url // empty' <<<"$resp" 2>/dev/null)"
  if [ -z "$turl" ]; then
    emit_err "$(jq -r '(.detail // .error // "sam-audio separate failed")' <<<"$resp" 2>/dev/null | head -c 300)"; return
  fi
  tout="$OUTDIR/separate/${base}_target.wav"
  rout="$OUTDIR/separate/${base}_residual.wav"
  curl -fsS -m 300 -o "$tout" "$turl" && [ -s "$tout" ] || { emit_err "sam-audio: target track download failed"; return; }
  local outputs
  outputs="$(jq -nc --arg t "$tout" --arg p "$prompt" '[{kind:"track",ref:$t,label:$p,role:"target"}]')"
  if [ -n "$rurl" ] && curl -fsS -m 300 -o "$rout" "$rurl" && [ -s "$rout" ]; then
    outputs="$(jq -c --arg r "$rout" '. + [{kind:"track",ref:$r,label:"residual",role:"residual"}]' <<<"$outputs")"
  fi
  jq -nc --arg inp "$input" --arg m "$SEP_MODEL" --arg p "$prompt" --argjson outs "$outputs" \
    '{verb:"enhance",format:"json",payload:{op:"separate",input:$inp,model:$m,prompt:$p,count:($outs|length),outputs:$outs},media:{ref:$inp},meta:{provider:("fal:"+$m)},state:"ready"}'
}

# ---- --ops segment : SAM 3 text-prompted instance segmentation ---------------
do_segment() {
  [ -n "$prompt" ] || { emit_err "segment needs --prompt (what to segment, e.g. --prompt 'the red car')"; return; }
  case "$ext" in
    jpg|jpeg|png|webp|bmp) : ;;
    *) emit_err "segment is image-only (got .$ext); segment a frame:// still of a video first"; return ;;
  esac
  mkdir -p "$OUTDIR/segment"
  local subtype imime b64 body resp nmask
  subtype="$ext"; [ "$subtype" = "jpg" ] && subtype="jpeg"; imime="image/$subtype"
  b64="$(b64file "$input")"
  body="$(jq -nc --arg u "data:$imime;base64,$b64" --arg p "$prompt" --argjson n "$SEG_MAX" \
    '{image_url:$u,prompt:$p,return_multiple_masks:true,max_masks:$n,include_scores:true,include_boxes:true,output_format:"png"}')"
  resp="$(curl -s -m 300 -X POST "https://fal.run/$SEG_MODEL" -H "Authorization: Key $KEY" -H "Content-Type: application/json" -d "$body")"
  nmask="$(jq -r '(.masks // []) | length' <<<"$resp" 2>/dev/null || echo 0)"
  if ! [ "$nmask" -gt 0 ] 2>/dev/null; then
    emit_err "$(jq -r '(.detail // .error // "sam-3 segment returned no masks")' <<<"$resp" 2>/dev/null | head -c 300)"; return
  fi
  local outputs dets i murl score box boxobj idx mout cout ref kind maskfield item det
  outputs="[]"; dets="[]"; i=0
  while [ "$i" -lt "$nmask" ]; do
    idx=$((i + 1))
    murl="$(jq -r ".masks[$i].url // empty" <<<"$resp" 2>/dev/null)"
    score="$(jq -r ".scores[$i] // .metadata[$i].score // null" <<<"$resp" 2>/dev/null)"
    box="$(jq -c ".boxes[$i] // .metadata[$i].box // null" <<<"$resp" 2>/dev/null)"
    i=$((i + 1))
    [ -n "$murl" ] || continue
    mout="$OUTDIR/segment/${base}_${idx}_mask.png"
    curl -fsS -m 120 -o "$mout" "$murl" && [ -s "$mout" ] || continue
    # SAM 3 boxes are normalized [cx,cy,w,h] -> {xmin,ymin,xmax,ymax} (still normalized)
    boxobj="$(jq -c 'if type=="array" and length>=4 then {xmin:(.[0]-.[2]/2),ymin:(.[1]-.[3]/2),xmax:(.[0]+.[2]/2),ymax:(.[1]+.[3]/2)} else null end' <<<"$box" 2>/dev/null)"
    [ -n "$boxobj" ] || boxobj="null"
    if [ "$masks_only" = "1" ]; then
      ref="$mout"; kind="mask"; maskfield="null"
    else
      cout="$OUTDIR/segment/${base}_${idx}.png"
      if "$FFMPEG" -y -i "$input" -i "$mout" -filter_complex "[1:v][0:v]scale2ref[a][b];[a]format=gray[aa];[b][aa]alphamerge" "$cout" >/dev/null 2>&1 && [ -s "$cout" ]; then
        ref="$cout"; kind="cutout"; maskfield="$(jq -nc --arg m "$mout" '$m')"
      else
        # cutout compositing failed — degrade HONESTLY to the binary mask rather
        # than mislabeling a grayscale mask as an RGBA cutout.
        rm -f "$cout"; ref="$mout"; kind="mask"; maskfield="null"
      fi
    fi
    item="$(jq -nc --arg ref "$ref" --arg k "$kind" --arg lab "$prompt" --argjson idx "$idx" \
      --argjson sc "${score:-null}" --argjson bx "$boxobj" --argjson mask "$maskfield" \
      '{kind:$k,ref:$ref,label:$lab,instance:$idx,score:$sc,box:$bx,box_normalized:true,mask:$mask}')"
    outputs="$(jq -c --argjson it "$item" '. + [$it]' <<<"$outputs")"
    det="$(jq -nc --arg lab "$prompt" --argjson sc "${score:-null}" --argjson bx "$boxobj" \
      '{label:$lab,score:$sc,box:$bx,box_normalized:true}')"
    dets="$(jq -c --argjson d "$det" '. + [$d]' <<<"$dets")"
  done
  if [ "$(jq 'length' <<<"$outputs")" = "0" ]; then emit_err "sam-3: all mask downloads failed"; return; fi
  jq -nc --arg inp "$input" --arg m "$SEG_MODEL" --arg p "$prompt" --argjson outs "$outputs" --argjson dets "$dets" \
    '{verb:"enhance",format:"json",payload:{op:"segment",input:$inp,model:$m,prompt:$p,count:($outs|length),detections:$dets,outputs:$outs},media:{ref:$inp},meta:{provider:("fal:"+$m)},state:"ready"}'
}

# ---- default : ESRGAN (image) / DeepFilterNet3 (audio) -----------------------
do_enhance() {
  local model field subtype mime rkey out b64 resp url err
  case "$ext" in
    jpg|jpeg|png|webp|bmp) model="$IMG_MODEL"; field=image_url; subtype="$ext"; [ "$subtype" = "jpg" ] && subtype="jpeg"; mime="image/$subtype"; rkey=".image.url"; out="$OUTDIR/${base}_fal.png" ;;
    mp3|wav|m4a|aac|flac|ogg) model="$AUD_MODEL"; field=audio_url; mime="audio/$ext"; rkey=".audio_file.url"; out="$OUTDIR/${base}_fal.mp3" ;;
    *) emit_err "unsupported modality .$ext"; return ;;
  esac
  b64="$(b64file "$input")"
  resp="$(curl -s -m 180 -X POST "https://fal.run/$model" \
    -H "Authorization: Key $KEY" -H "Content-Type: application/json" \
    -d "{\"$field\":\"data:$mime;base64,$b64\"}")"
  url="$(jq -r "$rkey // empty" <<<"$resp" 2>/dev/null)"
  err="$(jq -r '(.detail // .error // empty)' <<<"$resp" 2>/dev/null)"
  if [ -n "$url" ]; then
    if curl -fsS -m 120 -o "$out" "$url" && [ -s "$out" ]; then
      jq -nc --arg o "$out" --arg m "fal:$model" \
        '{verb:"enhance",format:"json",payload:{output:$o,ops:["fal"],model:$m},media:{ref:$o},meta:{provider:$m},state:"ready"}'
    else
      rm -f "$out"; emit_err "fal enhance: result download failed or empty"
    fi
  else
    emit_err "${err:-fal enhance failed}"
  fi
}

# pick the handler explicitly and reject ambiguous combos (no silent precedence).
want_sep=0; want_seg=0
case ",$ops," in *,separate,*) want_sep=1 ;; esac
case ",$ops," in *,segment,*)  want_seg=1 ;; esac
if [ $((want_sep + want_seg)) -gt 1 ]; then
  emit_err "one split op at a time — got ops=\"$ops\" (use --ops separate OR --ops segment)"
elif [ "$want_sep" = 1 ]; then do_separate
elif [ "$want_seg" = 1 ]; then do_segment
else do_enhance
fi
