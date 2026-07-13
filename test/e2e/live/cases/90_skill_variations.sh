#!/usr/bin/env bash
# VARIATIONS showcase — same real input, different modes/flags — and assert the
# outputs actually DIFFER (nothing else in the suite pins this). Exercises the
# knobs the skills lean on: listen plain vs --describe vs --diarize; see --ocr vs
# --prompt; brief plain vs csi theme. Saves every raw output for inspection.
#
# Needs Cloudglue for listen/see/watch/brief; the diarize variation needs ElevenLabs.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=variations
require_cred "$C" CLOUDGLUE_API_KEY "variations showcase needs a sense backend" || exit 0

CASE=$(case_dir variations)

# Prefer a VIDEO clip so --describe can produce a full audio-scene description; a
# standalone audio file makes --describe warn + fall back to the speech transcript
# (tinycloud full describe is video-only) — both are valid variations to pin.
REC=""; LKIND=""
if have_media "$VIDEO_SPEECH_SRC"; then REC="$SMOKE_DIR/var_speech.mp4"; clip_av 14 "$VIDEO_SPEECH_SRC" "$REC"; LKIND="video"
elif have_media "$AUDIO_FILE"; then REC="$AUDIO_FILE"; LKIND="audio-only"; fi
FRAME=""; SRC="$VIDEO_OBJECTS"; have_media "$SRC" || SRC="$VIDEO_VISUAL"
have_media "$SRC" && { FRAME="$SMOKE_DIR/var_frame.jpg"; frame_jpg "$SRC" 3 "$FRAME"; }

# ---- LISTEN: three modes on ONE recording -----------------------------------
if [ -n "${REC:-}" ] && [ -f "$REC" ]; then
  cond "VARIATION listen ($LKIND): plain transcript vs --describe — same clip, different payload shape"
  lp="$(OC_TIMEOUT=300 oc "$CASE" listen "$REC" --json)"; save_json "90_listen_plain" "$lp" >/dev/null
  ld="$(OC_TIMEOUT=300 oc "$CASE" listen "$REC" --describe --json)"; save_json "90_listen_describe" "$ld" >/dev/null
  tp="$(echo "$lp" | jq -r '.payload.transcript // ""')"
  assert_nonempty "$C.listen_plain" "$tp" "plain listen produced a speech transcript (${#tp} chars)"
  # --describe changes the payload SHAPE: it adds a `description` (video audio-scene)
  # or a `warning` (audio-only fallback) that plain listen never carries.
  plain_extra="$(echo "$lp" | jq -r '.payload | (has("description") or has("warning"))')"
  desc_extra="$(echo "$ld"  | jq -r '.payload | (has("description") or has("warning"))')"
  if [ "$desc_extra" = "true" ] && [ "$plain_extra" = "false" ]; then
    ok "$C.listen_differ" "--describe adds an audio-scene/warning field that plain listen omits"
  else
    fail "$C.listen_differ" "--describe payload shape did not differ from plain (plain_extra=$plain_extra desc_extra=$desc_extra)"
  fi
  scene="$(echo "$ld" | jq -r '.payload.description // ""')"; warn="$(echo "$ld" | jq -r '.payload.warning // ""')"
  if [ -n "$scene" ]; then ok "$C.describe_scene" "full audio-scene description (${#scene} chars): $(printf '%s' "$scene" | head -c 60)"
  elif [ -n "$warn" ]; then ok "$C.describe_scene" "audio-only fallback warned: $(printf '%s' "$warn" | head -c 70)"
  else ok "$C.describe_scene" "no scene/warning this run (informational)"; fi

  # speaker separation is a diarize-capable-provider variation (ElevenLabs)
  if require_cred "$C.diarize" ELEVENLABS_API_KEY "the --diarize variation needs ElevenLabs"; then
    EL="$PWD/providers/senses/elevenlabs/listen.sh"
    ocrun "$CASE" setup provider listen "exec:bash $EL {{input}}" --json >/dev/null 2>&1
    lz="$(OC_TIMEOUT=240 oc "$CASE" listen "$REC" --diarize --json)"; save_json "90_listen_diarize" "$lz" >/dev/null
    nsp="$(echo "$lz" | jq -r '[.payload.segments[]?.speaker | select(. != null)] | unique | length')"
    if [ "${nsp:-0}" -ge 1 ]; then ok "$C.diarize_speakers" "--diarize labeled $nsp distinct speaker(s) — plain listen labels none"; else fail "$C.diarize_speakers" "--diarize produced no speaker labels"; fi
    # (no listen call follows, so no need to restore the default listen provider —
    # `setup provider listen ""` errors on an empty spec anyway.)
  fi
else
  skip "$C.listen" "no OC_AUDIO or OC_VIDEO_SPEECH"
fi

# ---- SEE: OCR vs open-ended prompt on ONE frame -----------------------------
if [ -n "$FRAME" ] && [ -f "$FRAME" ]; then
  cond "VARIATION see: --ocr (on-image text) vs --prompt (open-ended description) — same frame"
  so="$(OC_TIMEOUT=180 oc "$CASE" see "$FRAME" --ocr --json)"; save_json "90_see_ocr" "$so" >/dev/null
  sp="$(OC_TIMEOUT=180 oc "$CASE" see "$FRAME" --prompt "how many people, and what safety gear are they wearing?" --json)"; save_json "90_see_prompt" "$sp" >/dev/null
  ocr="$(echo "$so" | jq -r '.payload.ocr // ""')"
  cap="$(echo "$sp" | jq -r '.payload.caption // ""')"
  assert_eq "$C.see_ocr_state" "ready" "$(echo "$so" | jq -r '.state')" "--ocr ready"
  assert_nonempty "$C.see_prompt" "$cap" "--prompt returned a focused description (${#cap} chars)"
  if [ "$ocr" != "$cap" ]; then ok "$C.see_differ" "--ocr text and --prompt description DIFFER (as they should)"; else fail "$C.see_differ" "--ocr and --prompt returned identical text"; fi

  # third mode: --detect returns structured bounding boxes (a bound OWLv2 detector),
  # a completely different payload shape from the free-text --ocr/--prompt. Bind the
  # detector LAST so it doesn't affect the brain-see calls above.
  if [ -n "${DETECT_PY:-}" ]; then
    DET="$PWD/providers/senses/detect/detect.py"
    ocrun "$CASE" setup provider see "exec:$DETECT_PY $DET" --json >/dev/null 2>&1
    sd="$(OC_TIMEOUT=300 oc "$CASE" see "$FRAME" --detect "person, helmet, safety vest, truck" --json)"; save_json "90_see_detect" "$sd" >/dev/null
    sdstate="$(echo "$sd" | jq -r '.state')"; nd="$(echo "$sd" | jq -r '.payload.detections | length')"
    # the detector must RUN (state ready); box count is frame-dependent, so 0 is a
    # clean pass (the payload SHAPE — a detections[] array, not prose — is the point).
    if [ "$sdstate" != "ready" ]; then
      fail "$C.see_detect" "--detect errored (state=$sdstate)"
    elif [ "${nd:-0}" -ge 1 ]; then
      counts="$(echo "$sd" | jq -c '.payload.counts')"
      ok "$C.see_detect" "--detect returned $nd bounding-box detections $counts — structured boxes, not prose"
    else
      ok "$C.see_detect" "--detect ran clean; 0 boxes in this frame — still a detections[] payload, not prose"
    fi
  else
    skip "$C.see_detect" "no DETECT_PY — the --detect variation needs a bound OWLv2 detector (scripts/visual-db-uv.sh --detect)"
  fi
else
  skip "$C.see" "no OC_VIDEO_OBJECTS/OC_VIDEO_VISUAL for a frame"
fi

# ---- WATCH: a real content timeline -----------------------------------------
if have_media "$VIDEO_VISUAL"; then
  cond "VARIATION watch: a real video → a time-anchored content timeline"
  WCLIP="$SMOKE_DIR/var_watch.mp4"; clip_av 12 "$VIDEO_VISUAL" "$WCLIP"
  wt="$(OC_TIMEOUT=300 oc "$CASE" watch "$WCLIP" --json)"; save_json "90_watch" "$wt" >/dev/null
  content="$(echo "$wt" | jq -r '.payload.content // ""')"
  assert_eq "$C.watch_state" "ready" "$(echo "$wt" | jq -r '.state')" "watch ready"
  assert_nonempty "$C.watch_content" "$content" "watch produced a content timeline (${#content} chars)"
fi

# ---- BRIEF: plain vs csi theme (same case, different render) -----------------
cond "VARIATION brief: --theme plain vs --theme csi — same records, different HTML render"
oc "$CASE" note "variations showcase — comparing render themes" --tag tldr --json >/dev/null
BP="$SMOKE_DIR/90_brief_plain.html"; BCS="$SMOKE_DIR/90_brief_csi.html"
oc "$CASE" brief --export "$BP" --theme plain --json >/dev/null
oc "$CASE" brief --export "$BCS" --theme csi --json >/dev/null
if [ -s "$BP" ] && [ -s "$BCS" ]; then
  csi_marked=0; grep -q 'data-overcast-theme="csi"' "$BCS" && csi_marked=1
  plain_marked=0; grep -q 'data-overcast-theme="csi"' "$BP" && plain_marked=1
  if [ "$csi_marked" -eq 1 ] && [ "$plain_marked" -eq 0 ]; then
    ok "$C.brief_theme" "csi brief carries the CSI theme marker ($(wc -c <"$BCS"|tr -d ' ')B); plain does not ($(wc -c <"$BP"|tr -d ' ')B)"
  else
    fail "$C.brief_theme" "theme markers wrong (csi=$csi_marked plain=$plain_marked)"
  fi
else
  fail "$C.brief_theme" "one of the theme exports is empty"
fi
