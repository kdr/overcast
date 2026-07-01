#!/usr/bin/env bash
# Real basic-clip (local CLIP) DB checks: create a local basic-clip index, embed
# an image + a video via `similar add`, then query by text (`search`) and image
# (`match`). Uses paths from .env and skips cleanly when open_clip is absent.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=clip_db

have_media "$CLIP_IMAGE_REF" || { skip "$C.clip" "no OC_CLIP_IMAGE_REF"; exit 0; }

PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import open_clip, torch, PIL, numpy
PY
then
  skip "$C.clip_deps" "basic-clip deps missing in $PY (run scripts/visual-db-uv.sh --clip)"
  exit 0
fi

CASE=$(case_dir clip_db)

cond "index create --type basic-clip --local makes a CLIP DB and similar add embeds a reference image"
created="$(oc "$CASE" index create scenes --type basic-clip --local --granularity frame --json)"; rc=$?
assert_eq "$C.create_exit" "0" "$rc" "local basic-clip index create exits 0"
CLIP_INDEX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.index_id" "$CLIP_INDEX" "local basic-clip index id returned"
assert_eq "$C.create_config" "frame" "$(echo "$created" | jq -r '.payload.config.granularity // empty')" "config.json granularity persisted"

add_img="$(OC_TIMEOUT=420 oc "$CASE" similar add "$CLIP_IMAGE_REF" --index "$CLIP_INDEX" --json)"
assert_eq "$C.add_image_state" "ready" "$(echo "$add_img" | jq -r '.state')" "reference image embedded into the CLIP DB"

if have_media "$CLIP_VIDEO"; then
  add_vid="$(OC_TIMEOUT=600 oc "$CASE" similar add "$CLIP_VIDEO" --index "$CLIP_INDEX" --json)"
  assert_eq "$C.add_video_state" "ready" "$(echo "$add_vid" | jq -r '.state')" "video embedded (frame-sampled) into the CLIP DB"
  save_json "clip_db_add_video" "$add_vid" >/dev/null
else
  skip "$C.add_video" "no OC_CLIP_VIDEO"
fi

cond "similar search ranks members by text->image similarity"
search="$(OC_TIMEOUT=420 oc "$CASE" similar search "$CLIP_TEXT" --index "$CLIP_INDEX" --limit 5 --json)"
assert_eq "$C.search_state" "ready" "$(echo "$search" | jq -r '.state')" "text search state ready"
assert_eq "$C.search_query" "$CLIP_TEXT" "$(echo "$search" | jq -r '.payload.query // empty')" "text query echoed on the record"
search_count="$(echo "$search" | jq -r '.payload.count // 0')"
if [ "$search_count" -gt 0 ]; then
  ok "$C.search_count" "found $search_count semantic match(es) for \"$CLIP_TEXT\""
else
  fail "$C.search_count" "expected at least one semantic match for \"$CLIP_TEXT\", got 0"
fi
save_json "clip_db_search" "$search" >/dev/null

cond "similar match ranks members by image->image similarity"
match="$(OC_TIMEOUT=420 oc "$CASE" similar match "$CLIP_IMAGE_REF" --index "$CLIP_INDEX" --json)"
assert_eq "$C.match_state" "ready" "$(echo "$match" | jq -r '.state')" "image match state ready"
match_count="$(echo "$match" | jq -r '.payload.count // 0')"
if [ "$match_count" -gt 0 ]; then
  ok "$C.match_count" "found $match_count visual match(es) (the reference itself should rank top)"
else
  fail "$C.match_count" "expected at least one visual match (the embedded reference), got 0"
fi
save_json "clip_db_match" "$match" >/dev/null

# the cache should now hold at least one embedding vector on disk
if ls "$CASE/.overcast/index/$CLIP_INDEX/emb/"*.npy >/dev/null 2>&1; then
  ok "$C.cache" "embedding cache materialized under the index dir"
else
  fail "$C.cache" "expected cached .npy embeddings under .overcast/index/$CLIP_INDEX/emb/"
fi
