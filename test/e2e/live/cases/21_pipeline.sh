#!/usr/bin/env bash
# A REAL end-to-end OSINT pipeline: a source that points at real local videos →
# scan --pull → capture (copied into the case) → watch (real Cloudglue) → the
# analysis is queryable. Also: capture a local video by ref, then watch it.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=pipeline
require_cred "$C" CLOUDGLUE_API_KEY "skipping (watch needs Cloudglue)" || exit 0

# a short real clip so the pull → watch stays fast
CLIP="$SMOKE_DIR/pipe_clip.mp4"
SRC="$VIDEO_VISUAL"; have_media "$SRC" || SRC="$VIDEO_SMALL"
have_media "$SRC" && clip_av 12 "$SRC" "$CLIP"
[ -f "$CLIP" ] || { skip "$C" "no clip"; exit 0; }

# a tiny "folder" source provider that emits the real clip as a scan.hit
SRCSCRIPT="$SMOKE_DIR/folder_src.sh"
cat >"$SRCSCRIPT" <<EOF
#!/usr/bin/env bash
case "\${1:-enumerate}" in
  describe) echo '{"source":"folder","emits":"scan.hit"}' ;;
  init) exit 0 ;;
  enumerate) printf '[{"title":"clip","url":"%s","source":"folder","media":{"ref":"%s"}}]' "$CLIP" "$CLIP" ;;
  fetch) shift; out=""; while [ "\$#" -gt 0 ]; do [ "\$1" = "--out" ] && out="\$2"; shift; done; cp "$CLIP" "\$out" 2>/dev/null; echo "{\"kind\":\"video\",\"path\":\"\$out\",\"source\":\"folder\"}" ;;
esac
EOF
export OVERCAST_SOURCE_FOLDER_CMD="bash $SRCSCRIPT"

CASE=$(case_dir pipeline)
ocrun "$CASE" source add 'folder:clips' --json >/dev/null 2>&1

# scan --pull --pipe watch : enumerate → capture → real watch
out="$(OC_TIMEOUT=300 ocrun "$CASE" scan --source folder --pull --pipe watch --json 2>/dev/null)"
save_json "21_scan_pull" "$out" >/dev/null
n="$(echo "$out" | jq -s 'length' 2>/dev/null)"
if [ "${n:-0}" -ge 3 ]; then ok "$C.scan_stream" "scan --pull streamed $n records (scan+capture+watch)"; else fail "$C.scan_stream" "expected ≥3 records, got ${n:-0}"; fi
assert_nonempty "$C.scan_hit" "$(echo "$out"|jq -s -r '[.[]|select(.verb=="scan")][0].payload.title // empty')" "a scan.hit"
cap="$(echo "$out" | jq -s -r '[.[]|select(.verb=="capture" and .state=="ready")]|length')"
assert_eq "$C.capture" "1" "$cap" "captured the clip into the case"
w="$(echo "$out" | jq -s -r '[.[]|select(.verb=="watch" and .state=="ready")][0]')"
assert_eq "$C.pull_watch" "ready" "$(echo "$w"|jq -r '.state // "none"')" "pulled clip was watched (real Cloudglue)"
assert_nonempty "$C.pull_content" "$(echo "$w"|jq -r '.payload.content // empty')" "watch content from the pulled clip"
unset OVERCAST_SOURCE_FOLDER_CMD

# capture a local file directly, then watch it by capture path
out2="$(ocrun "$CASE" capture "$CLIP" --json 2>/dev/null)"
capref="$(echo "$out2" | jq -r '.media.ref')"
assert_eq "$C.capture_local" "ready" "$(echo "$out2"|jq -r '.state')" "local capture ready"
if [ -f "$capref" ]; then ok "$C.capture_file" "captured file present in case media"; else fail "$C.capture_file" "missing $capref"; fi
