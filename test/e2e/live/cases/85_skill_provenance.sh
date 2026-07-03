#!/usr/bin/env bash
# SKILL: overcast-provenance — "is this clip real?" (origin trace / debunk).
# Drives the skill's inverse-copycat chain against REAL media: fingerprint a
# distinctive mark, reverse-image-search it (lens) and keyword-sweep sources with
# NO recency floor, then CONFIRM a suspect clip carries the mark via the
# geometry-gated image matcher and REJECT an unrelated one — landing an origin
# verdict finding + brief with the RANSAC overlay embedded.
#
# Deterministic detection core needs OC_LOCAL_IMAGE_REF + the cv2/numpy venv + ffmpeg.
# The reverse-search tiers gate on APIFY_TOKEN / TAVILY_API_KEY.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_provenance
SKILL_FILE="$PWD/skills/overcast-provenance/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE"; exit 0; }
have_media "$LOCAL_IMAGE_REF" || { skip "$C" "no OC_LOCAL_IMAGE_REF (a distinctive mark to fingerprint)"; exit 0; }
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import cv2, numpy  # noqa
PY
then
  skip "$C.deps" "local image matcher deps missing in $PY (opencv-python numpy — scripts/visual-db-uv.sh)"
  exit 0
fi

CASE=$(case_dir skill_provenance)
WORK="$SMOKE_DIR/provenance"; mkdir -p "$WORK"
LOGO="$LOCAL_IMAGE_REF"

# 1) skill step: fingerprint the distinctive mark into a local image-ransac index
cond "provenance skill: fingerprint the distinctive mark into a local image-ransac index"
created="$(oc "$CASE" index create origin --type image-ransac --local --json)"
IDX="$(echo "$created" | jq -r '.payload.index // .payload.id // empty')"
assert_nonempty "$C.index" "$IDX" "local image-ransac index created ($IDX)"
add="$(oc "$CASE" image add "$LOGO" --index "$IDX" --json)"
assert_eq "$C.fingerprint" "ready" "$(echo "$add" | jq -r '.state')" "distinctive mark fingerprinted"

# 2) skill step: reverse-image-search the mark (lens) — origin candidates
LENS_URL=""; lens_done=0; web_done=0
if require_cred "$C.lens" APIFY_TOKEN "reverse-image tier needs Apify"; then
  cond "provenance skill: lens reverse-image-searches the mark for its earliest/original pages"
  export OVERCAST_SOURCE_LENS_CMD="bash $PWD/examples/providers/sources/lens.sh"
  cp "$LOGO" "$CASE/origin_mark.${LOGO##*.}"
  ocrun "$CASE" source add "lens:origin_mark.${LOGO##*.}" --json >/dev/null 2>&1   # register the lens source
  lout="$(OC_TIMEOUT=420 oc "$CASE" scan --source lens --query "origin_mark.${LOGO##*.}" --limit 3 --json)"
  save_json "85_lens" "$lout" >/dev/null
  lerr="$(echo "$lout" | jq -s -r '[.[]|select(.state=="error")][0].error // empty' 2>/dev/null)"
  lhits="$(echo "$lout" | jq -s '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.url // "") != "")]|length' 2>/dev/null)"
  if [ -z "$lerr" ]; then ok "$C.lens_ran" "lens reverse-image tier ran clean ($lhits page match(es))"; else fail "$C.lens_ran" "lens errored: $lerr"; fi
  [ "${lhits:-0}" -ge 1 ] && LENS_URL="$(echo "$lout" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.url // "") != "")][0].payload.url' 2>/dev/null)"
  # only claim the reverse-image search in the note if it ran clean AND matched pages
  [ -z "$lerr" ] && [ "${lhits:-0}" -ge 1 ] && lens_done=1
  unset OVERCAST_SOURCE_LENS_CMD
fi

# 3) skill step: keyword sweep with NO recency floor (older = closer to origin)
if require_cred "$C.web" TAVILY_API_KEY "keyword-sweep tier needs Tavily"; then
  cond "provenance skill: keyword sweep with no --since floor surfaces origin candidates"
  export OVERCAST_SOURCE_WEB_CMD="bash $PWD/examples/providers/sources/web.sh"
  ocrun "$CASE" source add 'web:brand logo origin history' --json >/dev/null 2>&1
  wout="$(OC_TIMEOUT=300 oc "$CASE" scan --source web --limit 3 --json)"
  save_json "85_web" "$wout" >/dev/null
  whits="$(echo "$wout" | jq -s '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.url // "") != "")]|length' 2>/dev/null)"
  if [ "${whits:-0}" -ge 1 ]; then ok "$C.web_hits" "keyword sweep returned $whits candidate page(s)"; else fail "$C.web_hits" "keyword sweep returned no pages"; fi
  # only claim the keyword sweep in the note if it actually returned pages
  [ "${whits:-0}" -ge 1 ] && web_done=1
  unset OVERCAST_SOURCE_WEB_CMD
fi

# 4) skill step: CONFIRM a suspect clip carries the mark (geometry-gated), REJECT unrelated
confirmed_ok=0; rejected_ok=0
cond "provenance skill: a suspect clip carrying the mark is CONFIRMED through the planar-projection gate"
"$FFMPEG" -y -v error -f lavfi -i "color=c=gray:s=854x480:d=6" -i "$LOGO" \
  -filter_complex "[1:v]scale=320:-1[l];[0:v][l]overlay=(W-w)/2:(H-h)/2" \
  -frames:v 90 -c:v libx264 -preset veryfast "$WORK/suspect.mp4" 2>/dev/null
if [ -s "$WORK/suspect.mp4" ]; then
  mr="$(OC_TIMEOUT=420 oc "$CASE" image match "$WORK/suspect.mp4" --index "$IDX" --max-frames 30 --draw --json)"
  save_json "85_match_suspect" "$mr" >/dev/null
  MR_ID="$(echo "$mr" | jq -r '.id // empty')"
  rc="$(echo "$mr" | jq -r '.payload.count // 0')"
  if [ "${rc:-0}" -ge 1 ]; then confirmed_ok=1; ok "$C.confirmed" "suspect clip CONFIRMED: $rc gated frame match(es) carry the mark"; else fail "$C.confirmed" "suspect clip produced 0 gated matches (expected >=1)"; fi
  draws="$(echo "$mr" | jq -r '[.payload.matches[]?.match_draw_path | select(. != null)] | length')"
  [ "${draws:-0}" -ge 1 ] && ok "$C.overlay" "wrote $draws RANSAC overlay(s) as visual proof" || fail "$C.overlay" "no --draw overlay written"
else
  fail "$C.confirmed" "ffmpeg could not build the suspect clip"
fi

cond "provenance skill: an unrelated clip is REJECTED (no degenerate false positive)"
if have_media "$LOCAL_IMAGE_VIDEO_A"; then
  clip_av 10 "$LOCAL_IMAGE_VIDEO_A" "$WORK/unrelated.mp4"; unrelated_src="OC_LOCAL_IMAGE_VIDEO_A"
else
  "$FFMPEG" -y -v error -f lavfi -i "testsrc=size=854x480:rate=15:duration=10" -c:v libx264 -preset veryfast "$WORK/unrelated.mp4" 2>/dev/null; unrelated_src="synthetic testsrc"
fi
if [ -s "$WORK/unrelated.mp4" ]; then
  mu="$(OC_TIMEOUT=420 oc "$CASE" image match "$WORK/unrelated.mp4" --index "$IDX" --max-frames 30 --json)"
  save_json "85_match_unrelated" "$mu" >/dev/null
  uc="$(echo "$mu" | jq -r '.payload.count // 0')"
  if [ "${uc:-0}" -eq 0 ]; then rejected_ok=1; ok "$C.rejected" "unrelated clip ($unrelated_src) correctly rejected: 0 gated matches"; else fail "$C.rejected" "unrelated clip false-matched $uc time(s) — gate leak"; fi
else
  skip "$C.rejected" "could not build an unrelated clip"
fi

# 5) skill step: origin verdict finding (cite the match overlay) + tldr note + brief
cond "provenance skill: an origin verdict finding cites the match overlay; the brief embeds it"
if [ -n "${MR_ID:-}" ] && [ "${rc:-0}" -ge 1 ]; then
  verdict="origin verdict: the suspect clip carries the fingerprinted mark ($rc gated matches)"
  [ -n "$LENS_URL" ] && verdict="$verdict; reverse-image surfaced $LENS_URL as an origin candidate"
  oc "$CASE" finding create "$verdict" --ref "$MR_ID" --confidence high --json >/dev/null
fi
# build the tldr strictly from what actually happened (sweep tiers + confirm/reject)
parts="fingerprinted the mark"
sw=""
[ "$lens_done" -eq 1 ] && sw="reverse-image-searched"
[ "$web_done" -eq 1 ] && { [ -n "$sw" ] && sw="$sw + keyword-swept" || sw="keyword-swept"; }
[ -n "$sw" ] && parts="$parts, $sw for origin (no recency floor)"
[ "$confirmed_ok" -eq 1 ] && parts="$parts, CONFIRMED a suspect clip through the geometry gate"
[ "$rejected_ok" -eq 1 ] && parts="$parts, REJECTED an unrelated clip"
oc "$CASE" note "provenance: $parts." --tag tldr,provenance --confidence high --json >/dev/null
BRIEF="$SMOKE_DIR/85_provenance_brief.html"
oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
if [ -s "$BRIEF" ] && grep -qi "<html" "$BRIEF"; then
  ok "$C.brief" "provenance brief exported: $BRIEF ($(wc -c <"$BRIEF" | tr -d ' ') bytes)"
else
  fail "$C.brief" "no provenance brief HTML at $BRIEF"
fi
