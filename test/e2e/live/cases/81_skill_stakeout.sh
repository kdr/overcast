#!/usr/bin/env bash
# SKILL: overcast-stakeout — the surveillance van (standing watch + monitor wall).
# Drives the skill's chain against REAL media/sources: stand up a standing scope
# with a text target + review findings, seed a real feed, pin an evidence moment,
# then render the control-room wall (the monitor bank) and a periodic brief. The
# source-monitor tier (Apify x → capture → watch) runs when APIFY_TOKEN is present.
#
# Wall + setup base needs a real watch record (CLOUDGLUE_API_KEY + OC_VIDEO_VISUAL);
# skips cleanly otherwise. Source tier gates on APIFY_TOKEN.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_stakeout
SKILL_FILE="$PWD/skills/overcast-stakeout/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE"; exit 0; }
require_cred "$C" CLOUDGLUE_API_KEY "stakeout wall needs real watch evidence" || exit 0
have_media "$VIDEO_VISUAL" || { skip "$C" "no OC_VIDEO_VISUAL"; exit 0; }

CASE=$(case_dir skill_stakeout)
CLIP="$SMOKE_DIR/stakeout_feed.mp4"; clip_av 12 "$VIDEO_VISUAL" "$CLIP"

# 1) skill step: stand up the standing scope (text target drives review findings)
cond "stakeout skill: case setup pins a text target with --findings review + --auto-sense watch"
setup="$(oc "$CASE" case setup --name stakeout --target "surveillance target" --findings review --auto-sense watch --yes --json)"
setup_state="$(echo "$setup" | jq -rs '[.[]|select((.payload.op // "")|test("startup_setup"))][0].state // "missing"')"
assert_eq "$C.setup" "ready" "$setup_state" "stakeout case setup is ready"
mode="$(jq -r '.findings.mode // empty' "$CASE/.overcast/setup.json" 2>/dev/null)"
assert_eq "$C.findings_mode" "review" "$mode" "findings review mode persisted for auto-flagging"

# 2) skill step: a real feed joins the case (the thing the wall renders)
cond "stakeout skill: a real feed is sensed into the case as watch evidence"
wa="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP" --json)"
WID="$(echo "$wa" | jq -r '.id // empty')"
assert_eq "$C.feed" "ready" "$(echo "$wa" | jq -r '.state')" "feed watched into the case"
assert_nonempty "$C.feed_id" "$WID" "feed record id"

# 3) skill step: pin an evidence moment (drives the wall tile loop window)
cond "stakeout skill: a pinned finding marks the evidence moment"
f="$(oc "$CASE" finding create "stakeout: flagged moment on the feed" --ref "$WID" --at 4-9 --target "surveillance target" --json)"
assert_eq "$C.pin" "ready" "$(echo "$f" | jq -r '.state')" "evidence moment pinned"

# 4) skill step: the control-room monitor wall
cond "stakeout skill: wall renders the case as a CSI monitor bank anchored on the finding"
WHTML="$SMOKE_DIR/81_stakeout_wall.html"
w="$(oc "$CASE" wall --export "$WHTML" --theme csi --refresh 60 --no-open --json)"
save_json "81_wall" "$w" >/dev/null
assert_eq "$C.wall_state" "ready" "$(echo "$w" | jq -r '.state')" "wall ready"
tiles="$(echo "$w" | jq -r '.payload.tiles // 0')"
assert_nonempty "$C.wall_tiles" "$([ "${tiles:-0}" -ge 1 ] && echo "$tiles")" "wall has $tiles live tile(s)"
assert_eq "$C.wall_anchor" "4" "$(echo "$w" | jq -r '.payload.tile_refs[0].at // empty')" "top tile anchored at the pinned moment"
if [ -s "$WHTML" ] && grep -q 'data-csi-wall="true"' "$WHTML"; then
  ok "$C.wall_html" "CSI monitor wall exported: $WHTML ($(wc -c <"$WHTML" | tr -d ' ') bytes)"
else
  fail "$C.wall_html" "missing CSI wall markers in $WHTML"
fi

# 5) skill step (source tier): monitor a public source, pipe new media to watch
if require_cred "$C.monitor" APIFY_TOKEN "source-monitor tier needs Apify"; then
  cond "stakeout skill: monitor --once sweeps a real x source and pipes a new hit into watch"
  export OVERCAST_SOURCE_X_CMD="bash $PWD/examples/providers/sources/x.sh"
  ocrun "$CASE" source add 'x:video:from:NASA' --json >/dev/null 2>&1
  # snapshot the watch count BEFORE monitor so we can prove a NEW feed was piped
  # (the seed feed already makes the count 1, so a bare >=1 check proves nothing).
  pre_watches="$(ocrun "$CASE" case records --verb watch --json 2>/dev/null | jq -r '.payload.count // 0')"
  mon="$(OC_TIMEOUT=600 oc "$CASE" monitor --once --source x --limit 2 --pipe watch --json)"
  save_json "81_monitor" "$mon" >/dev/null
  hits="$(cat "$CASE/.overcast/records/scan.jsonl" 2>/dev/null | jq -s '[.[]|select((.payload.url // "") != "")]|length')"
  if [ "${hits:-0}" -ge 1 ] && [ "${hits:-0}" -le 2 ]; then
    ok "$C.monitor_hits" "monitor persisted $hits real source hit(s) within the --limit cap"
  else
    fail "$C.monitor_hits" "expected 1-2 monitor hits, got ${hits:-0}"
  fi
  post_watches="$(ocrun "$CASE" case records --verb watch --json 2>/dev/null | jq -r '.payload.count // 0')"
  # a --pipe watch that saw new media must ADD a watch record beyond the seed feed;
  # if the diff surfaced no fresh items (hits==0) there's nothing to pipe, so that's a
  # clean no-op, not a failure.
  if [ "${hits:-0}" -ge 1 ]; then
    if [ "${post_watches:-0}" -gt "${pre_watches:-0}" ]; then
      ok "$C.monitor_pipe" "--pipe watch added $((post_watches - pre_watches)) new watch record(s) beyond the seed feed"
    else
      fail "$C.monitor_pipe" "monitor found $hits hit(s) but piped no new watch record (pre=$pre_watches post=$post_watches)"
    fi
  else
    ok "$C.monitor_pipe" "no fresh items to pipe this pass (0 new hits) — clean no-op"
  fi
fi

# 6) skill step: periodic cited brief
cond "stakeout skill: a periodic brief reports the standing case"
oc "$CASE" note "stakeout: standing watch on 'surveillance target'; wall live; findings in review." --tag tldr --json >/dev/null
BRIEF="$SMOKE_DIR/81_stakeout_brief.html"
oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
if [ -s "$BRIEF" ] && grep -qi "<html" "$BRIEF"; then
  ok "$C.brief" "stakeout brief exported: $BRIEF ($(wc -c <"$BRIEF" | tr -d ' ') bytes)"
else
  fail "$C.brief" "no stakeout brief HTML at $BRIEF"
fi
