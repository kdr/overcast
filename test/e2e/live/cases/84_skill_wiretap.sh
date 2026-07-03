#!/usr/bin/env bash
# SKILL: overcast-wiretap — the ransom-call workup (audio identity / earwitness).
# Drives the skill's audio-forensics chain against a REAL recording: diarize the
# speakers, describe the background scene, render a spectrogram, isolate voices and
# RE-TRANSCRIBE the cleaned track, then correlate content across the case and land a
# cited finding + brief. Proves the audio surface (--diarize/--describe, spectrogram,
# voice-isolate) the skill is built on.
#
# Needs a real recording (OC_AUDIO or OC_VIDEO_SPEECH) + Cloudglue for listen.
# Spectrogram + voice-isolate are bundled ffmpeg (free). ElevenLabs leg gates on key.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_wiretap
SKILL_FILE="$PWD/skills/overcast-wiretap/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE"; exit 0; }
require_cred "$C" CLOUDGLUE_API_KEY "wiretap needs a listen backend" || exit 0

# a short recording: standalone audio, else a clipped speech video
if have_media "$AUDIO_FILE"; then
  REC="$AUDIO_FILE"
elif have_media "$VIDEO_SPEECH_SRC"; then
  REC="$SMOKE_DIR/wiretap_speech.mp4"; clip_av 15 "$VIDEO_SPEECH_SRC" "$REC"
fi
[ -n "${REC:-}" ] && [ -f "$REC" ] || { skip "$C" "no OC_AUDIO or OC_VIDEO_SPEECH"; exit 0; }

CASE=$(case_dir skill_wiretap)

# 1) skill step: transcribe (speech transcript + time-anchored segments)
cond "wiretap skill: listen transcribes the recording into time-anchored segments"
diar="$(OC_TIMEOUT=300 oc "$CASE" listen "$REC" --json)"
save_json "84_listen" "$diar" >/dev/null
assert_eq "$C.listen_state" "ready" "$(echo "$diar" | jq -r '.state')" "listen ready"
assert_eq "$C.segments" "array" "$(echo "$diar" | jq -r '.payload.segments|type')" "payload.segments is an array"
LID="$(echo "$diar" | jq -r '.id // empty')"
echo "$diar" | jq -e 'has("payload") and (.payload|has("transcript"))' >/dev/null 2>&1 \
  && ok "$C.transcript" "transcript present (len $(echo "$diar"|jq -r '.payload.transcript|length'))" \
  || fail "$C.transcript" "no transcript field"

# 2) skill step: read the background scene (the "enhance the background" move)
cond "wiretap skill: listen --describe surfaces the background audio scene"
desc="$(OC_TIMEOUT=300 oc "$CASE" listen "$REC" --describe --json)"
save_json "84_describe" "$desc" >/dev/null
desc_ok=0; [ "$(echo "$desc" | jq -r '.state')" = "ready" ] && desc_ok=1
assert_eq "$C.desc_state" "ready" "$(echo "$desc" | jq -r '.state')" "audio-scene describe ready"

# 3) skill step: spectrogram as a visual inspection artifact
cond "wiretap skill: view --spectrogram renders a real spectrogram PNG"
v="$(oc "$CASE" view "$REC" --spectrogram --no-open --json)"
save_json "84_view" "$v" >/dev/null
assert_eq "$C.view_mode" "audio" "$(echo "$v" | jq -r '.payload.mode')" "view detects audio"
SPEC="$(echo "$v" | jq -r '.payload.spectrogram // empty')"
spec_ok=0
if [ -n "$SPEC" ] && [ -s "$SPEC" ]; then
  cp "$SPEC" "$SMOKE_DIR/84_spectrogram.png"; spec_ok=1
  ok "$C.spectrogram" "spectrogram PNG rendered ($(basename "$SPEC"))"
else
  fail "$C.spectrogram" "no spectrogram PNG at ${SPEC:-none}"
fi

# 4) skill step: isolate voices and re-transcribe the cleaned track
cond "wiretap skill: enhance voice-isolate,denoise then re-listen the cleaned track"
enh="$(OC_TIMEOUT=240 oc "$CASE" enhance "$REC" --ops voice-isolate,denoise --json)"
save_json "84_enhance" "$enh" >/dev/null
iso_ok=0; [ "$(echo "$enh" | jq -r '.state')" = "ready" ] && iso_ok=1
assert_eq "$C.enh_state" "ready" "$(echo "$enh" | jq -r '.state')" "voice-isolate enhance ready"
ENH_ID="$(echo "$enh" | jq -r '.id // empty')"
relisten_ok=0
if [ -n "$ENH_ID" ]; then
  re="$(OC_TIMEOUT=300 oc "$CASE" listen "$ENH_ID" --json)"
  save_json "84_relisten" "$re" >/dev/null
  [ "$(echo "$re" | jq -r '.state')" = "ready" ] && relisten_ok=1
  assert_eq "$C.relisten" "ready" "$(echo "$re" | jq -r '.state')" "re-listen of the isolated track ready"
fi

# 5) skill step: per-speaker note + cross-clip correlation ask
cond "wiretap skill: record a speaker/background note and correlate across listen records"
[ -n "$LID" ] && oc "$CASE" note "Speaker breakdown + background scene recorded from the recording" --ref "$LID" --confidence medium --json >/dev/null
ask="$(OC_TIMEOUT=180 oc "$CASE" ask "summarize the speakers and any background cues that could locate this recording; cite record.id + time" --verb listen --json)"
save_json "84_ask" "$ask" >/dev/null
assert_eq "$C.ask_state" "ready" "$(echo "$ask" | jq -r '.state')" "cross-listen ask ready"
ans="$(echo "$ask" | jq -r '(.payload.answer // .payload.text // .payload.summary // "")')"
assert_nonempty "$C.ask_answer" "$ans" "ask returned a cited answer over the listen records"

# 6) skill step: real speaker separation — listen --diarize via a diarize-capable
# provider (ElevenLabs). The default tinycloud/Cloudglue listen path does NOT accept
# --diarize; this leg proves the skill's diarization works with the right provider.
# Runs BEFORE the finding/note/brief so those honestly reflect whether diarization
# happened, and AFTER every Cloudglue listen step so the provider rebind is safe.
DIARIZED=0; el_attempted=0
if require_cred "$C.diarize" ELEVENLABS_API_KEY "speaker separation needs a diarize-capable provider (ElevenLabs)"; then
  el_attempted=1
  cond "wiretap skill: a bound ElevenLabs provider does listen --diarize (speaker separation)"
  EL="$PWD/examples/providers/elevenlabs/listen.sh"
  ocrun "$CASE" setup provider listen "exec:bash $EL {{input}}" --json >/dev/null 2>&1
  dz="$(OC_TIMEOUT=240 oc "$CASE" listen "$REC" --diarize --json)"
  save_json "84_diarize" "$dz" >/dev/null
  st="$(echo "$dz" | jq -r '.state')"
  if [ "$st" = "ready" ]; then DIARIZED=1; DZ_ID="$(echo "$dz" | jq -r '.id // empty')"; ok "$C.diarize_state" "ElevenLabs diarization ready (speaker separation)"; else fail "$C.diarize_state" "diarize state=$st err=$(echo "$dz"|jq -r '.error // empty'|head -c 80)"; fi
fi

# 7) skill step: cited finding + mandatory tldr note + brief. The claim reflects
# what actually ran — speaker separation is only asserted when diarization happened.
cond "wiretap skill: a finding cites the listen record; a tldr note (honest about every step's outcome) feeds the brief"
# name only the steps that actually succeeded, and be precise about diarization:
# separated / attempted-but-failed / not-run (no provider).
steps="transcribed the recording"
[ "$desc_ok" -eq 1 ]     && steps="$steps, described the background scene"
[ "$spec_ok" -eq 1 ]     && steps="$steps, rendered a spectrogram"
[ "$iso_ok" -eq 1 ]      && steps="$steps, voice-isolated"
[ "$relisten_ok" -eq 1 ] && steps="$steps, re-transcribed the cleaned track"
if [ "$DIARIZED" -eq 1 ]; then
  sep="separated speakers via ElevenLabs diarization"
elif [ "$el_attempted" -eq 1 ]; then
  sep="speaker separation attempted but the provider failed"
else
  sep="speaker separation not run (no diarize-capable provider)"
fi
# when diarization succeeded, cite the speaker-labeled diarize record (matches the
# skill); otherwise cite the transcript record.
finding_ref="${LID:-}"; [ "$DIARIZED" -eq 1 ] && [ -n "${DZ_ID:-}" ] && finding_ref="$DZ_ID"
oc "$CASE" finding create "audio workup: $steps; $sep" --ref "$finding_ref" --confidence medium --json >/dev/null
oc "$CASE" note "wiretap: $steps; $sep." --tag tldr --json >/dev/null
BRIEF="$SMOKE_DIR/84_wiretap_brief.html"
oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
if [ -s "$BRIEF" ] && grep -qi "<html" "$BRIEF"; then
  ok "$C.brief" "wiretap brief exported: $BRIEF ($(wc -c <"$BRIEF" | tr -d ' ') bytes)"
else
  fail "$C.brief" "no wiretap brief HTML at $BRIEF"
fi
