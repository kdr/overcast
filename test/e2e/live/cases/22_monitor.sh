#!/usr/bin/env bash
# monitor: --once seen-set diff (2 passes), and --every bounded loop.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=monitor

# a cheap source emitting 2 stable hits (no cloud needed for the diff logic).
# media.ref points at a small real clip so capture (local copy) succeeds; we DON'T
# pipe a sense here (no --pipe / non-AV gate keeps it fast) — diff is the focus.
# two DISTINCT clips so the two hits are genuinely two items (monitor dedups by
# media.ref — identical refs would correctly collapse to one).
CLIP="$SMOKE_DIR/mon_clip.mp4"; CLIP2="$SMOKE_DIR/mon_clip2.mp4"
SRC="$VIDEO_SMALL"; have_media "$SRC" || SRC="$VIDEO_VISUAL"
have_media "$SRC" && { clip_av 4 "$SRC" "$CLIP"; clip_av 3 "$SRC" "$CLIP2"; }
{ [ -f "$CLIP" ] && [ -f "$CLIP2" ]; } || { skip "$C" "no clip"; exit 0; }

SRCSCRIPT="$SMOKE_DIR/mon_src.sh"
cat >"$SRCSCRIPT" <<EOF
#!/usr/bin/env bash
case "\${1:-enumerate}" in
  describe) echo '{"source":"feed","emits":"scan.hit"}' ;;
  init) exit 0 ;;
  enumerate) printf '[{"title":"a","url":"%s","source":"feed","media":{"ref":"%s"}},{"title":"b","url":"%s","source":"feed","media":{"ref":"%s"}}]' "$CLIP" "$CLIP" "$CLIP2" "$CLIP2" ;;
  fetch) shift; out=""; while [ "\$#" -gt 0 ]; do [ "\$1" = "--out" ] && out="\$2"; shift; done; cp "$CLIP" "\$out" 2>/dev/null; echo "{\"kind\":\"video\",\"path\":\"\$out\",\"source\":\"feed\"}" ;;
esac
EOF
export OVERCAST_SOURCE_FEED_CMD="bash $SRCSCRIPT"

CASE=$(case_dir monitor)
ocrun "$CASE" source add 'feed:x' --json >/dev/null 2>&1

# pass 1: 2 new (capture only; no sense pipe → AV gate means watch isn't auto-run
# since these have no --pipe and the capture is AV we still skip unless --pipe).
p1="$(OC_TIMEOUT=120 oc "$CASE" monitor --source feed --once --json)"
save_json "22_monitor_p1" "$p1" >/dev/null
new1="$(echo "$p1" | jq -s -r '[.[]|select(.verb=="monitor")][0].payload.new_items')"
assert_eq "$C.first_new" "2" "$new1" "first --once pass: 2 new items"

# pass 2: same source → 0 new (seen-set diff works)
p2="$(OC_TIMEOUT=120 oc "$CASE" monitor --source feed --once --json)"
save_json "22_monitor_p2" "$p2" >/dev/null
new2="$(echo "$p2" | jq -s -r '[.[]|select(.verb=="monitor")][0].payload.new_items')"
assert_eq "$C.second_none" "0" "$new2" "second pass: 0 new (diff works)"

# --every bounded to 1 pass via OVERCAST_MONITOR_MAX_PASSES
CASE2=$(case_dir monitor_every)
ocrun "$CASE2" source add 'feed:y' --json >/dev/null 2>&1
ev="$(OVERCAST_MONITOR_MAX_PASSES=1 OC_TIMEOUT=120 oc "$CASE2" monitor --source feed --every 1h --alert stdout --json)"
save_json "22_monitor_every" "$ev" >/dev/null
# --every streams records then returns a final summary; assert we saw a monitor summary
if echo "$ev" | jq -e -s 'any(.[]; .verb=="monitor")' >/dev/null 2>&1; then ok "$C.every" "--every ran a bounded pass and streamed records"; else fail "$C.every" "no monitor output from --every"; fi
unset OVERCAST_SOURCE_FEED_CMD
