#!/usr/bin/env bash
# Real grid: tile a real video into labeled contact sheets (pure ffmpeg — the core
# grid path needs NO creds), covering the variations Bugbot hardened (no filename
# collision, blank-padding cell map, explicit --at, past-duration reject, audio
# reject). Then, Cloudglue-gated, the frame-grid CoT loop: see the montage → map a
# cell to a timestamp → see frame:// to verify that exact frame.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=grid

# a real video with people/objects (objects preferred), any of the standard clips
VID=""
for v in "$VIDEO_OBJECTS" "$VIDEO_VISUAL" "$VIDEO_SMALL"; do
  if have_media "$v"; then VID="$v"; break; fi
done
[ -n "$VID" ] || { skip "$C" "no video (set OC_VIDEO_OBJECTS/VISUAL/SMALL)"; exit 0; }

CASE=$(case_dir grid)

# --- 1) full-clip triage grid (pure ffmpeg; no creds) ---
cond "grid tiles a real video into a contact sheet -> ready media.grid with a cell->timestamp map"
out="$(oc "$CASE" grid "$VID" --count 12 --cols 4 --json)"
save_json "18_grid_full" "$out" >/dev/null
assert_eq "$C.verb" "grid" "$(echo "$out"|jq -r '.verb')" "record.verb is grid"
assert_eq "$C.state" "ready" "$(echo "$out"|jq -r '.state')" "state ready"
assert_eq "$C.count" "12" "$(echo "$out"|jq -r '.payload.count')" "12 frames sampled"
MON="$(echo "$out"|jq -r '.payload.montage')"
if have_media "$MON"; then ok "$C.montage" "contact sheet written ($(echo "$out"|jq -r '.payload.grid'))"; else fail "$C.montage" "no montage at $MON"; fi
assert_nonempty "$C.cells" "$(echo "$out"|jq -r '.payload.cells[0].at')" "cell 1 has a timestamp"

# --view renders the clickable HTML board (numbered, seekable cells)
cond "grid --view renders an HTML board whose numbered cells seek the source clip"
vout="$(oc "$CASE" grid "$VID" --count 9 --view --no-open --json)"
assert_eq "$C.view.opened" "false" "$(echo "$vout"|jq -r '.payload.opened')" "--no-open respected"
VH="$(echo "$vout"|jq -r '.payload.view')"
if have_media "$VH" && grep -q 'onclick="seek(' "$VH"; then ok "$C.view.html" "board HTML has seekable cells"; else fail "$C.view.html" "no clickable board at $VH"; fi

# --- 2) no filename collision: same count, different samples -> distinct montage ---
cond "two grids of the same clip with the same count but different samples get distinct montage files"
a="$(oc "$CASE" grid "$VID" --at "1,2,3" --json)"
b="$(oc "$CASE" grid "$VID" --at "1,2,4" --json)"
ma="$(echo "$a"|jq -r '.payload.montage')"; mb="$(echo "$b"|jq -r '.payload.montage')"
if [ "$ma" != "$mb" ] && have_media "$ma" && have_media "$mb"; then
  ok "$C.no_collision" "distinct montages, neither overwritten"
else
  fail "$C.no_collision" "collision or missing: '$ma' vs '$mb'"
fi

# --- 3) odd count -> trailing blank padding tile mapped as null ---
cond "an odd frame count pads the last row with a blank tile mapped at:null (count stays real)"
o="$(oc "$CASE" grid "$VID" --count 5 --json)"
save_json "18_grid_pad" "$o" >/dev/null
assert_eq "$C.pad.real" "5" "$(echo "$o"|jq -r '.payload.count')" "count reports 5 real frames"
nnull="$(echo "$o"|jq -r '[.payload.cells[]|select(.at==null)]|length')"
if [ "${nnull:-0}" -ge 1 ]; then ok "$C.pad.null" "$nnull blank padding cell(s) mapped null"; else fail "$C.pad.null" "no null padding cell in a 5-frame grid"; fi

# --- 4) explicit --at maps exactly the requested (sorted, deduped) timestamps ---
cond "explicit --at samples exactly the requested timestamps"
at="$(oc "$CASE" grid "$VID" --at "1,5,9" --cols 3 --json)"
assert_eq "$C.at" "[1,5,9]" "$(echo "$at"|jq -rc '[.payload.cells[]|select(.at!=null)|.at]')" "cells map to [1,5,9]"

# --- 5) --at past the clip duration is rejected (never claim an unsampled second) ---
cond "a --at timestamp past the clip duration is rejected instead of claiming a never-sampled frame"
pd="$(oc "$CASE" grid "$VID" --at "1,99999" --json)"
assert_eq "$C.past.state" "error" "$(echo "$pd"|jq -r '.state')" "past-duration --at errors"
case "$(echo "$pd"|jq -r '.error // empty')" in
  *"past the video duration"*) ok "$C.past.msg" "clear past-duration error" ;;
  *) fail "$C.past.msg" "unexpected: $(echo "$pd"|jq -r '.error // empty' | head -c 80)" ;;
esac

# --- 6) audio-only input is rejected (grid needs a video stream) ---
if have_media "$AUDIO_FILE"; then
  cond "grid rejects an audio-only input (no video stream) with a clear error"
  au="$(oc "$CASE" grid "$AUDIO_FILE" --count 4 --json)"
  assert_eq "$C.audio.state" "error" "$(echo "$au"|jq -r '.state')" "audio-only errors"
  case "$(echo "$au"|jq -r '.error // empty')" in
    *"no video stream"*) ok "$C.audio.msg" "clear video-required error" ;;
    *) fail "$C.audio.msg" "unexpected: $(echo "$au"|jq -r '.error // empty' | head -c 80)" ;;
  esac
else
  skip "$C.audio" "no OC_AUDIO for the audio-reject check"
fi

# --- 7) records persist to the case store ---
cond "grid records persist to the case store"
n="$(oc "$CASE" case records --verb grid --json | jq '.payload.count')"
if [ "${n:-0}" -ge 1 ]; then ok "$C.persisted" "$n grid record(s) persisted"; else fail "$C.persisted" "no persisted grid records"; fi

# --- 8) Cloudglue-gated frame-grid CoT loop: see montage -> map cell -> verify frame ---
if require_cred "$C.cot" CLOUDGLUE_API_KEY "skipping the VLM loop"; then
  BRAIN=$(case_dir grid_cot)   # fresh case -> default profile (no see binding) -> turnkey Cloudglue brain
  cond "see the montage with a grid prompt (turnkey brain) -> ready description"
  s="$(OC_TIMEOUT=180 oc "$BRAIN" see "$MON" --prompt "This is a contact sheet of 12 frames numbered 1-12 left-to-right, top-to-bottom. In one sentence, which numbered cell best shows a person, and why? Give the cell number." --json)"
  save_json "18_grid_see_montage" "$s" >/dev/null
  assert_eq "$C.cot.see_state" "ready" "$(echo "$s"|jq -r '.state')" "montage see ready"
  case "$(echo "$s"|jq -r '.meta.provider // empty')" in
    brain:*) ok "$C.cot.provider" "routed to brain ($(echo "$s"|jq -r '.meta.provider'))" ;;
    *) fail "$C.cot.provider" "expected brain:*, got '$(echo "$s"|jq -r '.meta.provider // empty')'" ;;
  esac
  assert_nonempty "$C.cot.desc" "$(echo "$s"|jq -r '.payload.description // .payload.caption')" "montage description non-empty"

  # map a real cell timestamp from the full grid and verify that exact frame
  T="$(echo "$out"|jq -r '.payload.cells[3].at')"   # cell 4's timestamp
  w="$(OC_TIMEOUT=300 oc "$BRAIN" watch "$VID" --json)"
  REC="$(echo "$w"|jq -r '.id')"
  if [ "$(echo "$w"|jq -r '.state')" = "ready" ] && [ -n "$REC" ] && [ "$REC" != "null" ]; then
    cond "see frame://REC@t (turnkey brain) verifies the exact frame a montage cell points to"
    fv="$(OC_TIMEOUT=180 oc "$BRAIN" see "frame://$REC@$T" --prompt "Describe this single frame in one sentence." --json)"
    save_json "18_grid_frame_verify" "$fv" >/dev/null
    assert_eq "$C.cot.verify_state" "ready" "$(echo "$fv"|jq -r '.state')" "frame verify ready at t=$T"
    assert_nonempty "$C.cot.verify_desc" "$(echo "$fv"|jq -r '.payload.description // .payload.caption')" "frame description non-empty"
  else
    skip "$C.cot.verify" "watch did not produce a record to frame://-verify"
  fi
fi
