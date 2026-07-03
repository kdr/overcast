#!/usr/bin/env bash
# overcast `enhance` provider — LOCAL models (on-device). A TOOLBOX dispatched by
# --ops, over the uv-managed visual-db Python env:
#   --ops separate   pyannote diarization -> per-speaker tracks  (enhance_voice.py)
#   --ops segment    GroundingDINO + SAM 2.1 text-prompted masks (enhance_segment.py)
# The default `enhance` stays the internal ffmpeg toolkit; bind to opt in:
#   overcast setup provider enhance "exec:bash examples/providers/local/enhance.sh {{input}}"
# Set up the env with:  scripts/visual-db-uv.sh --enhance   (or --voice / --segment)
# Voice separation additionally needs HF_TOKEN + accepted pyannote license.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
VDB="$HERE/../visual-db"

resolve_py() {
  if [ -n "${OVERCAST_VISUAL_DB_PY:-}" ]; then echo "$OVERCAST_VISUAL_DB_PY"; return; fi
  if [ -n "${OC_VISUAL_DB_PY:-}" ]; then echo "$OC_VISUAL_DB_PY"; return; fi
  if [ -x "$ROOT/.dev/visual-db-py/bin/python" ]; then echo "$ROOT/.dev/visual-db-py/bin/python"; return; fi
  echo "python3"
}
PY="$(resolve_py)"

op="${1:-run}"
case "$op" in
  init)
    # EITHER stack is enough — voice (--ops separate) needs pyannote+torch,
    # segment (--ops segment) needs transformers+torch; a user may install just
    # one. Only fail if NEITHER is present. Note whatever's missing.
    have_seg=0; have_voice=0
    "$PY" -c 'import transformers, torch' 2>/dev/null && have_seg=1
    "$PY" -c 'import pyannote.audio' 2>/dev/null && have_voice=1
    if [ "$have_seg" = 0 ] && [ "$have_voice" = 0 ]; then
      echo "local-models needs the uv env: scripts/visual-db-uv.sh --enhance (installs pyannote + transformers/SAM2/torch)" >&2
      exit 13
    fi
    [ "$have_voice" = 0 ] && echo "note: --ops separate needs pyannote.audio: scripts/visual-db-uv.sh --voice" >&2
    [ "$have_seg" = 0 ] && echo "note: --ops segment needs transformers+torch: scripts/visual-db-uv.sh --segment" >&2
    if [ "$have_voice" = 1 ] && [ -z "${HF_TOKEN:-}${HUGGING_FACE_HUB_TOKEN:-}" ]; then
      echo "note: voice separation also needs HF_TOKEN + accepted license: https://huggingface.co/pyannote/speaker-diarization-community-1" >&2
    fi
    exit 0 ;;
  describe)
    echo '{"verb":"enhance","kind":"media.enhanced","ops":["separate","segment"],"separate":"pyannote/speaker-diarization-community-1","segment":"IDEA-Research/grounding-dino-tiny + facebook/sam2.1-hiera-tiny","needs":["scripts/visual-db-uv.sh --enhance","HF_TOKEN (separate only)"]}'
    exit 0 ;;
esac

# find --ops to pick the entrypoint; forward all args through unchanged.
ops=""
n="$#"; i=1
while [ "$i" -le "$n" ]; do
  eval "cur=\${$i}"
  # shellcheck disable=SC2154
  if [ "$cur" = "--ops" ]; then j=$((i + 1)); eval "ops=\${$j:-}"; fi
  i=$((i + 1))
done

# pick the handler explicitly and reject ambiguous combos (no silent precedence).
want_sep=0; want_seg=0
case ",$ops," in *,separate,*) want_sep=1 ;; esac
case ",$ops," in *,segment,*)  want_seg=1 ;; esac
if [ $((want_sep + want_seg)) -gt 1 ]; then
  jq -nc --arg o "$ops" '{verb:"enhance",format:"json",payload:{},error:("one split op at a time — got ops=\"" + $o + "\" (use --ops separate OR --ops segment)"),state:"error"}'
elif [ "$want_sep" = 1 ]; then
  exec "$PY" "$VDB/enhance_voice.py" "$@"
elif [ "$want_seg" = 1 ]; then
  exec "$PY" "$VDB/enhance_segment.py" "$@"
else
  jq -nc --arg o "$ops" '{verb:"enhance",format:"json",payload:{},error:("local-models handles --ops separate|segment (got ops=\"" + $o + "\"); for denoise/normalize/upscale bind the internal ffmpeg toolkit: overcast setup provider enhance ffmpeg"),state:"error"}'
fi
