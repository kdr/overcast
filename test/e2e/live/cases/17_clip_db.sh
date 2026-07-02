#!/usr/bin/env bash
# Real basic-clip (local CLIP) DB checks, CLI + headless agent:
#   • derives fixtures from REAL videos (frames via ffmpeg) when OC_CLIP_* is
#     unset, and captions a frame with `see` to derive the text queries
#   • covers all four cross-modal modes — text×video, image×video, image×image,
#     text×image — and writes a self-contained HTML evidence page
#     ($SMOKE_DIR/clip_db_evidence.html) with query + match thumbnails/scores
#   • drives one search through the headless agent (--mode json) and asserts a
#     `similar` record persisted
# Skips cleanly when open_clip deps or media are absent.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=clip_db

PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import open_clip, torch, PIL, numpy
PY
then
  skip "$C.clip_deps" "basic-clip deps missing in $PY (run scripts/visual-db-uv.sh --clip)"
  exit 0
fi

# --- real fixtures: two distinct-scene videos + frames drawn from them --------
# VIDEO A (e.g. a work site) is the target for text×video / image×video;
# VIDEO B (a different scene) provides an IMAGE member for image×image / text×image.
SRC_A="${CLIP_VIDEO:-$VIDEO_OBJECTS}"
SRC_B="$VIDEO_SMALL"
have_media "$SRC_A" || { skip "$C.media" "no OC_CLIP_VIDEO/OC_VIDEO_OBJECTS video"; exit 0; }
have_media "$SRC_B" || { skip "$C.media" "no OC_VIDEO_SMALL video"; exit 0; }

CLIP_A="$SMOKE_DIR/clipdb_video_a.mp4"; clip_av 20 "$SRC_A" "$CLIP_A"
CLIP_B="$SMOKE_DIR/clipdb_video_b.mp4"; clip_av 20 "$SRC_B" "$CLIP_B"
IMG_B_MEMBER="${CLIP_IMAGE_REF:-$SMOKE_DIR/clipdb_member_b.jpg}"
have_media "$IMG_B_MEMBER" || frame_jpg "$SRC_B" 3 "$IMG_B_MEMBER"
IMG_A_QUERY="$SMOKE_DIR/clipdb_query_a.jpg"; frame_jpg "$SRC_A" 8 "$IMG_A_QUERY"
IMG_B_QUERY="$SMOKE_DIR/clipdb_query_b.jpg"; frame_jpg "$SRC_B" 12 "$IMG_B_QUERY"
for f in "$CLIP_A" "$CLIP_B" "$IMG_B_MEMBER" "$IMG_A_QUERY" "$IMG_B_QUERY"; do
  have_media "$f" || { skip "$C.media" "could not derive real fixtures (ffmpeg)"; exit 0; }
done

CASE=$(case_dir clip_db)

# --- build the DB (CLI leg) ---------------------------------------------------
cond "index create --type basic-clip --local makes a frame-level CLIP DB with a persisted config"
created="$(oc "$CASE" index create scenes --type basic-clip --local --granularity frame --window 5 --json)"; rc=$?
assert_eq "$C.create_exit" "0" "$rc" "local basic-clip index create exits 0"
CLIP_INDEX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.index_id" "$CLIP_INDEX" "local basic-clip index id returned"
assert_eq "$C.create_config" "frame" "$(echo "$created" | jq -r '.payload.config.granularity // empty')" "config.json granularity persisted"

cond "similar add embeds two real videos (frame-sampled) and a real image into the CLIP DB"
add_a="$(OC_TIMEOUT=600 oc "$CASE" similar add "$CLIP_A" --index "$CLIP_INDEX" --json)"
assert_eq "$C.add_video_a" "ready" "$(echo "$add_a" | jq -r '.state')" "video A embedded"
vec_a="$(echo "$add_a" | jq -r '.payload.vectors // 0')"
[ "${vec_a:-0}" -ge 2 ] && ok "$C.add_video_a_vectors" "video A produced $vec_a frame vectors" || fail "$C.add_video_a_vectors" "expected ≥2 frame vectors for video A, got $vec_a"
add_b="$(OC_TIMEOUT=600 oc "$CASE" similar add "$CLIP_B" --index "$CLIP_INDEX" --json)"
assert_eq "$C.add_video_b" "ready" "$(echo "$add_b" | jq -r '.state')" "video B embedded"
add_img="$(OC_TIMEOUT=420 oc "$CASE" similar add "$IMG_B_MEMBER" --index "$CLIP_INDEX" --json)"
assert_eq "$C.add_image" "ready" "$(echo "$add_img" | jq -r '.state')" "image member embedded"

# --- caption real frames with `see` to derive the text queries -----------------
# (falls back to generic phrases when no see backend is available)
derive_query() { # <frame> <fallback>
  local out q
  out="$(OC_TIMEOUT=180 ocrun "$CASE" see "$1" --json 2>/dev/null)"
  q="$(echo "$out" | jq -r '.payload.caption // empty' 2>/dev/null | grep -v '^#' | grep -v '^[[:space:]]*$' | head -1 | tr -s ' ' | cut -d' ' -f1-14)"
  [ -n "$q" ] && printf '%s' "$q" || printf '%s' "$2"
}
QUERY_A="$(derive_query "$IMG_A_QUERY" "${CLIP_TEXT:-a person working outdoors}")"
QUERY_B="$(derive_query "$IMG_B_QUERY" "food cooking on a grill")"
if [ "$QUERY_A" != "${CLIP_TEXT:-a person working outdoors}" ]; then
  ok "$C.caption_query" "see captioned a real frame into a search query: \"$QUERY_A\""
else
  skip "$C.caption_query" "see unavailable — using fallback query text"
fi

# --- the four cross-modal modes -----------------------------------------------
cond "text×video: a caption-derived text query ranks the right video's moments"
tv="$(OC_TIMEOUT=420 oc "$CASE" similar search "$QUERY_A" --index "$CLIP_INDEX" --limit 8 --json)"
assert_eq "$C.text_video_state" "ready" "$(echo "$tv" | jq -r '.state')" "text×video search ready"
tv_top="$(echo "$tv" | jq -r '.payload.matches[0].ref // empty')"
assert_eq "$C.text_video_top" "$CLIP_A" "$tv_top" "top text×video match is video A"
tv_at="$(echo "$tv" | jq -r '.payload.matches[0].at // empty')"
assert_nonempty "$C.text_video_at" "$tv_at" "text×video match carries a frame moment (at)"
save_json "clip_db_text_video" "$tv" >/dev/null

cond "image×video: a real frame from video A ranks video A's nearest moment first"
iv="$(OC_TIMEOUT=420 oc "$CASE" similar match "$IMG_A_QUERY" --index "$CLIP_INDEX" --limit 8 --json)"
assert_eq "$C.image_video_state" "ready" "$(echo "$iv" | jq -r '.state')" "image×video match ready"
assert_eq "$C.image_video_top" "$CLIP_A" "$(echo "$iv" | jq -r '.payload.matches[0].ref // empty')" "top image×video match is video A"
iv_sim="$(echo "$iv" | jq -r '.payload.matches[0].similarity // 0')"
[ "$(echo "$iv_sim >= 60" | bc -l)" = "1" ] && ok "$C.image_video_sim" "same-scene frame similarity is strong ($iv_sim)" || fail "$C.image_video_sim" "expected ≥60 similarity for a same-video frame, got $iv_sim"
save_json "clip_db_image_video" "$iv" >/dev/null

cond "image×image: a different frame of scene B finds the stored image member"
ii="$(OC_TIMEOUT=420 oc "$CASE" similar match "$IMG_B_QUERY" --index "$CLIP_INDEX" --limit 8 --json)"
assert_eq "$C.image_image_state" "ready" "$(echo "$ii" | jq -r '.state')" "image×image match ready"
ii_top="$(echo "$ii" | jq -r '.payload.matches[0].ref // empty')"
case "$ii_top" in "$CLIP_B"|"$IMG_B_MEMBER") ok "$C.image_image_top" "top match is scene B ($(basename "$ii_top"))" ;; *) fail "$C.image_image_top" "top match is not scene B: $ii_top" ;; esac
ii_has_img="$(echo "$ii" | jq --arg r "$IMG_B_MEMBER" '[.payload.matches[].ref] | index($r) != null')"
assert_eq "$C.image_image_member" "true" "$ii_has_img" "the stored image member appears in the matches"
save_json "clip_db_image_image" "$ii" >/dev/null

cond "text×image: a caption-derived text query surfaces the stored image member"
ti="$(OC_TIMEOUT=420 oc "$CASE" similar search "$QUERY_B" --index "$CLIP_INDEX" --limit 8 --json)"
assert_eq "$C.text_image_state" "ready" "$(echo "$ti" | jq -r '.state')" "text×image search ready"
ti_has_img="$(echo "$ti" | jq --arg r "$IMG_B_MEMBER" '[.payload.matches[:4][].ref] | index($r) != null')"
assert_eq "$C.text_image_member" "true" "$ti_has_img" "image member is in the top text×image matches"
save_json "clip_db_text_image" "$ti" >/dev/null

# --- headless agent leg ---------------------------------------------------------
cond "the headless agent (--mode json) runs a similar search and persists the record"
if have_cred CLOUDGLUE_API_KEY; then
  prompt="Use the overcast similar tool for this case: run similar search \"$QUERY_A\" --index $CLIP_INDEX --limit 3. Reply with JSON only, shaped like {\"index\":\"$CLIP_INDEX\",\"top_ref\":\"...\"}. Do not create notes."
  hout="$(OC_TIMEOUT=420 oc "$CASE" --mode json "$prompt")"
  invalid=0; nlines=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    nlines=$((nlines + 1))
    printf '%s' "$line" | jq -e . >/dev/null 2>&1 || invalid=$((invalid + 1))
  done <<<"$hout"
  assert_eq "$C.headless_json" "0" "$invalid" "headless stream is valid JSONL ($nlines line(s))"
  if printf '%s' "$hout" | grep -q "$CLIP_INDEX"; then
    ok "$C.headless_index" "agent stream references the CLIP index"
  else
    fail "$C.headless_index" "agent stream did not reference $CLIP_INDEX"
  fi
  sim_recs="$(ocrun "$CASE" case records --verb similar --json 2>/dev/null | jq -r '.payload.count // 0')"
  [ "${sim_recs:-0}" -ge 5 ] && ok "$C.headless_record" "case holds $sim_recs similar records (agent run persisted)" || fail "$C.headless_record" "expected the agent's similar record to persist (count=$sim_recs)"
else
  skip "$C.headless" "no CLOUDGLUE_API_KEY — headless agent needs a brain LLM"
fi

# --- HTML evidence page ---------------------------------------------------------
EVIDENCE="$SMOKE_DIR/clip_db_evidence.html"
b64() { base64 <"$1" | tr -d '\n'; }
thumb_for() { # <ref> <at> <out.jpg> — video ref -> frame at `at`; image ref -> as-is
  local ref="$1" at="$2" out="$3"
  case "$ref" in
    *.jpg|*.jpeg|*.png|*.webp) cp "$ref" "$out" 2>/dev/null ;;
    *) "$FFMPEG" -y -ss "${at:-0}" -i "$ref" -frames:v 1 -vf "scale=320:-2" -q:v 3 "$out" >/dev/null 2>&1 ;;
  esac
  [ -f "$out" ]
}
SECTION_N=0
section() { # <title> <query-html> <matches-json>
  local title="$1" qhtml="$2" json="$3" i=0
  SECTION_N=$((SECTION_N + 1))
  {
    printf '<section><h2>%s</h2><div class="row"><div class="q">%s</div><div class="arrow">→</div>' "$title" "$qhtml"
    while IFS=$'\t' read -r ref sim at; do
      [ -z "$ref" ] && continue
      i=$((i + 1)); [ "$i" -gt 4 ] && break
      # tmp name must NOT embed the title — caption-derived titles can contain '/'
      local t="$SMOKE_DIR/.thumb_$$_${SECTION_N}_$i.jpg"
      if thumb_for "$ref" "$at" "$t"; then
        printf '<figure><img src="data:image/jpeg;base64,%s"/><figcaption><b>%s</b> %s%s</figcaption></figure>' \
          "$(b64 "$t")" "$sim" "$(basename "$ref")" "${at:+ @${at}s}"
        rm -f "$t"
      fi
    done < <(echo "$json" | jq -r '.payload.matches[] | [.ref, .similarity, (.at // "")] | @tsv')
    printf '</div></section>\n'
  } >>"$EVIDENCE"
}
{
  printf '<!doctype html><meta charset="utf-8"><title>basic-clip live e2e evidence</title><style>body{font:14px -apple-system,sans-serif;margin:24px;background:#0e1116;color:#e6e6e6}h1{font-size:20px}h2{font-size:15px;margin:18px 0 6px}section{border-bottom:1px solid #333;padding:10px 0}.row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.q{max-width:340px}.q img{max-width:320px;border-radius:6px}.q .text{background:#1b2330;padding:12px;border-radius:6px;font-style:italic}.arrow{font-size:28px;align-self:center;color:#7aa2f7}figure{margin:0;text-align:center}figure img{width:180px;border-radius:6px}figcaption{font-size:11px;color:#aaa;margin-top:2px}figcaption b{color:#9ece6a}</style>\n'
  printf '<h1>basic-clip (`similar`) — live e2e evidence · %s</h1>\n' "$(git rev-parse --short HEAD 2>/dev/null || echo local)"
  printf '<p>Local OpenAI CLIP cross-modal search over real media. Scores are cosine×100. Queries on the left; top matches (with frame moments for videos) on the right.</p>\n'
} >"$EVIDENCE"
section "1. text × video — search: &ldquo;${QUERY_A}&rdquo;" "<div class=\"text\">&ldquo;${QUERY_A}&rdquo;</div>" "$tv"
section "2. image × video — match: $(basename "$IMG_A_QUERY")" "<img src=\"data:image/jpeg;base64,$(b64 "$IMG_A_QUERY")\"/>" "$iv"
section "3. image × image — match: $(basename "$IMG_B_QUERY")" "<img src=\"data:image/jpeg;base64,$(b64 "$IMG_B_QUERY")\"/>" "$ii"
section "4. text × image — search: &ldquo;${QUERY_B}&rdquo;" "<div class=\"text\">&ldquo;${QUERY_B}&rdquo;</div>" "$ti"
if [ -s "$EVIDENCE" ]; then ok "$C.evidence_html" "evidence page written: $EVIDENCE"; else fail "$C.evidence_html" "evidence page not written"; fi

# the cache should hold real embedding vectors on disk
if ls "$CASE/.overcast/index/$CLIP_INDEX/emb/"*.npy >/dev/null 2>&1; then
  ok "$C.cache" "embedding cache materialized under the index dir"
else
  fail "$C.cache" "expected cached .npy embeddings under .overcast/index/$CLIP_INDEX/emb/"
fi
