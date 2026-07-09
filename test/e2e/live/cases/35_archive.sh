#!/usr/bin/env bash
# Global archive with REAL media, end to end:
#   verb side  — init/add (trimmed real clip + image, sha256 dedup), show,
#                ask --archive over real items, capture archive:… pull into a
#                SECOND case, cross-case `image match --index archive:…` (real
#                RANSAC against a bucket image-ransac index stood up by the
#                archive setup wizard), watch archive:… in place (Cloudglue).
#   agent side — the headless pi agent drives the archive TOOL: lists buckets,
#                then archives a real frame with a tag; both verified
#                deterministically via the CLI afterwards.
# Buckets live in THIS case's per-case home ($CASE/.ochome/archive), so nothing
# touches ~/.overcast; the consumer case shares that home via --home.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=archive

have_media "$ARCHIVE_VIDEO" || { skip "$C" "no OC_ARCHIVE_VIDEO / OC_VIDEO_SMALL"; exit 0; }

CASE=$(case_dir archive)
HOMEDIR="$CASE/.ochome"
CASE2="$SMOKE_DIR/case_archive_consumer"; mkdir -p "$CASE2"
BUCKET="ref-footage"

# och <casedir> <args…> — like oc, but pinned to the FIRST case's home so a
# second case sees the same archive buckets (the cross-case premise).
och() {
  local cd="$1"; shift
  local out
  # shellcheck disable=SC2086
  out="$(perl -e 'alarm shift; exec @ARGV or exit 127' "${OC_TIMEOUT:-300}" $OVERCAST --case "$cd" --home "$HOMEDIR" "$@" 2>/dev/null)"
  oc_capture "overcast $*" "$out"
  printf '%s' "$out"
}

# --- init + add real media --------------------------------------------------
cond "archive init + add store real media in the bucket (sha256, tags, provenance)"
CLIP="$SMOKE_DIR/archive_clip.mp4"
clip_av 8 "$ARCHIVE_VIDEO" "$CLIP"
[ -f "$CLIP" ] || { skip "$C" "ffmpeg could not trim a clip from $ARCHIVE_VIDEO"; exit 0; }

init="$(oc "$CASE" archive init "$BUCKET" --name "Reference footage" --json)"
save_json "archive_init" "$init" >/dev/null
assert_eq "$C.init_state" "ready" "$(echo "$init" | jq -r '.state')" "archive init ready"
assert_eq "$C.init_created" "true" "$(echo "$init" | jq -r '.payload.created')" "bucket created"

add_args=("$CLIP")
have_media "$ARCHIVE_IMAGE" && add_args+=("$ARCHIVE_IMAGE")
add="$(oc "$CASE" archive add "${add_args[@]}" --to "$BUCKET" --tags landmark,e2e --note "real e2e reference media" --json)"
save_json "archive_add" "$add" >/dev/null
summary="$(echo "$add" | jq -s '[.[]|select(.verb=="archive" and .payload.op=="add")][0]')"
added="$(echo "$summary" | jq -r '.payload.added|length')"
assert_eq "$C.add_count" "${#add_args[@]}" "$added" "archive add saved every real file"
assert_nonempty "$C.add_sha" "$(echo "$summary" | jq -r '.payload.added[0].sha256 // empty')" "items carry a content sha256"

cond "re-adding identical real content dedupes by sha256"
add2="$(oc "$CASE" archive add "$CLIP" --to "$BUCKET" --json)"
dedup="$(echo "$add2" | jq -s '[.[]|select(.verb=="archive" and .payload.op=="add")][0].payload.already_archived|length')"
assert_eq "$C.dedup" "1" "$dedup" "identical clip deduped"

cond "archive show reports the real items"
show="$(oc "$CASE" archive show "$BUCKET" --json)"
assert_eq "$C.show_items" "${#add_args[@]}" "$(echo "$show" | jq -r '.payload.total_items')" "show counts the archived items"
CLIP_ITEM="$(echo "$show" | jq -r '.payload.items[]|select(.ref|endswith(".mp4"))|.ref' | head -1 | xargs basename)"
assert_nonempty "$C.show_item_ref" "$CLIP_ITEM" "archived clip filename resolved"

# --- cross-case: ask --archive + capture pull from a SECOND case -------------
cond "a second case asks over the bucket's memory (ask --archive, local-grep on real tags)"
answer="$(och "$CASE2" ask "landmark" --archive "$BUCKET" --json)"
save_json "archive_ask" "$answer" >/dev/null
cites="$(echo "$answer" | jq -r '.payload.citations|length')"
if [ "${cites:-0}" -ge 1 ]; then ok "$C.ask_cites" "ask --archive cites $cites bucket item(s)"; else fail "$C.ask_cites" "ask --archive found no citations"; fi
assert_eq "$C.ask_meta" "$BUCKET" "$(echo "$answer" | jq -r '.meta.archive')" "answer stamped with the bucket"

cond "capture archive:<bucket>/<item> pulls a real copy into the second case with provenance"
pull="$(och "$CASE2" capture "archive:$BUCKET/$CLIP_ITEM" --json)"
save_json "archive_pull" "$pull" >/dev/null
assert_eq "$C.pull_state" "ready" "$(echo "$pull" | jq -r '.state')" "pull ready"
assert_eq "$C.pull_source" "archive" "$(echo "$pull" | jq -r '.payload.source')" "pull stamped source archive"
case "$(echo "$pull" | jq -r '.media.ref')" in
  "$CASE2"/*) ok "$C.pull_copied" "pulled copy landed in the consumer case" ;;
  *) fail "$C.pull_copied" "pulled copy not under the consumer case" ;;
esac
pull2="$(och "$CASE2" capture "archive:$BUCKET/$CLIP_ITEM" --json)"
assert_eq "$C.pull_dedup" "true" "$(echo "$pull2" | jq -r '.payload.already_present')" "second pull dedupes by sha256"

# --- cross-case index: archive setup wizard + real RANSAC match --------------
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if have_media "$LOCAL_IMAGE_REF" && have_media "$LOCAL_IMAGE_VIDEO_A" && "$PY" - <<'PY' >/dev/null 2>&1
import cv2, numpy
PY
then
  cond "archive setup stands up a bucket image-ransac index and backfills the archived reference"
  ref_add="$(oc "$CASE" archive add "$LOCAL_IMAGE_REF" --to "$BUCKET" --tags reference --json)"
  save_json "archive_ref_add" "$ref_add" >/dev/null
  applied="$(oc "$CASE" archive setup "$BUCKET" --index stills:image-ransac --memory local-grep --yes --json)"
  save_json "archive_setup_apply" "$applied" >/dev/null
  setup_rec="$(echo "$applied" | jq -s '[.[]|select(.verb=="archive" and (.payload.op=="archive_setup" or .payload.op=="archive_setup_update"))][0]')"
  assert_eq "$C.setup_saved" "true" "$(echo "$setup_rec" | jq -r '.payload.saved')" "archive setup applied"
  members="$(jq -r '[.indexes[]|select(.name=="stills")][0].members|length' "$HOMEDIR/archive/$BUCKET/.overcast/indexes.json")"
  if [ "${members:-0}" -ge 1 ]; then ok "$C.setup_backfill" "backfill registered $members reference image(s)"; else fail "$C.setup_backfill" "backfill registered no members"; fi

  cond "the consumer case finds the archived reference in real footage (image match --index archive:…)"
  MIN_INLIERS="${OC_LOCAL_IMAGE_MIN_INLIERS:-8}"
  MIN_RATIO="${OC_LOCAL_IMAGE_MIN_RATIO:-0.25}"
  MAX_FRAMES="${OC_LOCAL_IMAGE_MAX_FRAMES:-12}"
  IMAGE_FPS="${OC_LOCAL_IMAGE_FPS:-0.7}"
  match="$(OC_TIMEOUT=420 och "$CASE2" image match "$LOCAL_IMAGE_VIDEO_A" --index "archive:$BUCKET/stills" --min-inliers "$MIN_INLIERS" --min-ratio "$MIN_RATIO" --fps "$IMAGE_FPS" --max-frames "$MAX_FRAMES" --json)"
  match="$(echo "$match" | primary_rec)"  # drop any auto-suggested finding the persist hook appended
  save_json "archive_cross_match" "$match" >/dev/null
  assert_eq "$C.match_state" "ready" "$(echo "$match" | jq -r '.state')" "cross-case image match ready"
  assert_eq "$C.match_meta" "$BUCKET" "$(echo "$match" | jq -r '.meta.archive')" "match evidence stamped meta.archive"
  count="$(echo "$match" | jq -r '.payload.count // 0')"
  if [ "${count:-0}" -ge 1 ]; then ok "$C.match_count" "found $count real match(es) against the bucket index"; else fail "$C.match_count" "expected ≥1 match against the bucket index, got 0"; fi
  # artifacts stay bucket-side; evidence persists to the CONSUMER case
  if [ -f "$CASE2/.overcast/indexes.json" ]; then
    fail "$C.match_bucket_side" "consumer case unexpectedly grew an index mirror"
  else
    ok "$C.match_bucket_side" "index mirror + DB artifacts stayed in the bucket"
  fi
  evid="$(och "$CASE2" case records --verb image --json | jq -r '.payload.count // 0')"
  if [ "${evid:-0}" -ge 1 ]; then ok "$C.match_evidence" "match record persisted to the consumer case"; else fail "$C.match_evidence" "no image record in the consumer case"; fi
else
  skip "$C.cross_index" "no OC_LOCAL_IMAGE_REF/OC_LOCAL_IMAGE_VIDEO_A or cv2/numpy in \$OC_VISUAL_DB_PY"
fi

# --- watch archive:… in place (real Cloudglue) --------------------------------
if require_cred "$C.watch" CLOUDGLUE_API_KEY "watch-in-place needs the default sense backend"; then
  cond "watch archive:<bucket>/<item> senses the archived clip IN PLACE (no copy into the case)"
  w="$(OC_TIMEOUT=300 och "$CASE2" watch "archive:$BUCKET/$CLIP_ITEM" --json)"
  w="$(echo "$w" | primary_rec)"
  save_json "archive_watch" "$w" >/dev/null
  assert_eq "$C.watch_state" "ready" "$(echo "$w" | jq -r '.state')" "in-place watch ready"
  case "$(echo "$w" | jq -r '.media.ref')" in
    "$HOMEDIR/archive/"*) ok "$C.watch_in_place" "watch record points at the BUCKET file (no copy)" ;;
    *) fail "$C.watch_in_place" "watch media.ref is not the bucket file: $(echo "$w" | jq -r '.media.ref')" ;;
  esac
fi

# --- agentic: the headless agent drives the archive tool -----------------------
if require_cred "$C.agent" CLOUDGLUE_API_KEY "headless agent needs a brain LLM"; then
  cond "the headless agent lists archive buckets via the archive tool"
  out="$(OC_TIMEOUT=240 oc "$CASE" -p "Use the archive tool with action list to list the global archive buckets. Reply in one line naming each bucket and its item count.")"
  save_json "archive_agent_list" "$(jq -Rs '{text: .}' <<<"$out")" >/dev/null
  if printf '%s' "$out" | grep -q "$BUCKET"; then
    ok "$C.agent_list" "agent named the bucket ($BUCKET)"
  else
    fail "$C.agent_list" "agent reply never mentioned $BUCKET: $(printf '%s' "$out" | tr '\n' ' ' | head -c 120)"
  fi

  cond "the headless agent archives a real frame with a tag (verified via the CLI)"
  FRAME="$SMOKE_DIR/archive_agent_frame.jpg"
  frame_jpg "$ARCHIVE_VIDEO" 2 "$FRAME"
  if [ -f "$FRAME" ]; then
    before="$(oc "$CASE" archive show "$BUCKET" --json | jq -r '.payload.total_items')"
    OC_TIMEOUT=240 oc "$CASE" -p "Use the archive tool to add the file $FRAME to the archive bucket $BUCKET with the tag agent-added. Then reply DONE." >/dev/null
    after_show="$(oc "$CASE" archive show "$BUCKET" --json)"
    after="$(echo "$after_show" | jq -r '.payload.total_items')"
    tagged="$(echo "$after_show" | jq -r '[.payload.items[]|select((.tags // [])|index("agent-added"))]|length')"
    if [ "${after:-0}" -gt "${before:-0}" ] && [ "${tagged:-0}" -ge 1 ]; then
      ok "$C.agent_add" "agent archived the frame (items $before->$after, tag agent-added present)"
    else
      fail "$C.agent_add" "agent add not verified (items $before→$after, tagged=$tagged)"
    fi
  else
    skip "$C.agent_add" "ffmpeg could not extract a frame"
  fi
fi
