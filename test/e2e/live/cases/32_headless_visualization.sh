#!/usr/bin/env bash
# Headless agent visualization export — seed a real case, ask the pi headless
# agent to run the HTML exports, then parse the JSONL trace for tool result paths.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C="headless_visualization"
require_cred "$C" CLOUDGLUE_API_KEY "headless agent needs a brain LLM" || exit 0

CLIP="$SMOKE_DIR/headless_viz_clip.mp4"
have_media "$VIDEO_VISUAL" && clip_av 10 "$VIDEO_VISUAL" "$CLIP"
[ -f "$CLIP" ] || { skip "$C" "no real visual clip configured"; exit 0; }

CASE=$(case_dir headless_visualization)
OUT_DIR="$SMOKE_DIR/headless-visualization-agent"
mkdir -p "$OUT_DIR"
STATUS_HTML="$OUT_DIR/status.html"
BRIEF_HTML="$OUT_DIR/brief.html"
RECORDS_HTML="$OUT_DIR/records.html"
EVENTS="$OUT_DIR/events.jsonl"
TRACE_EXPORTS="$OUT_DIR/tool-exports.json"

cond "seed a real case with Will Smith / Starbucks visual scope"
setup_args=(case setup --name headless_visualization --target "Will Smith,Starbucks" --source "web:Will Smith Starbucks visual evidence" --note "Investigation scope: verify whether Will Smith face evidence and Starbucks logo/image evidence appear in the configured real media." --yes --no-index --json)
have_media "$LOCAL_FACE_IMAGE" && setup_args+=(--face-ref "$LOCAL_FACE_IMAGE")
have_media "$LOCAL_IMAGE_REF" && setup_args+=(--image-target "$LOCAL_IMAGE_REF")
setup="$(oc "$CASE" "${setup_args[@]}")"
assert_eq "$C.setup.state" "true" "$(echo "$setup" | jq -sr 'all(.state == "ready")')" "case setup records ready"

cond "seed real watch evidence before the headless agent exports reports"
w="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP" --json)"
assert_eq "$C.watch.state" "ready" "$(echo "$w" | jq -r '.state')" "real watch evidence ready"
assert_nonempty "$C.watch.content" "$(echo "$w" | jq -r '.payload.content')" "watch content available"

note_text="Starbucks / Will Smith visualization trace: this case contains real video evidence plus explicit target/source scope for the headless report export path."
oc "$CASE" note "$note_text" --tag "starbucks,will-smith,headless-visualization,tldr" --confidence medium --json >/dev/null

cond "headless agent exports status, brief, and records HTML using the agent default theme"
prompt="Use overcast tools for this case and run exactly these exports without passing any theme argument: case status --export $STATUS_HTML; brief --export $BRIEF_HTML; case records --export $RECORDS_HTML. Reply with JSON only shaped like {\"status\":\"$STATUS_HTML\",\"brief\":\"$BRIEF_HTML\",\"records\":\"$RECORDS_HTML\"}."
out="$(OC_TIMEOUT=360 oc "$CASE" --mode json "$prompt")"
printf '%s' "$out" >"$EVENTS"
assert_nonempty "$C.trace.nonempty" "$out" "headless JSONL trace captured"
invalid=0; nlines=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  nlines=$((nlines + 1))
  printf '%s' "$line" | jq -e . >/dev/null 2>&1 || invalid=$((invalid + 1))
done <"$EVENTS"
assert_eq "$C.trace.valid" "0" "$invalid" "every one of $nlines event lines is valid JSON"

jq -sr '
  [
    .[]
    | select(.type == "agent_end")
    | .messages[]?
    | select(.role == "toolResult")
    | .details.records[]?
    | select(.state == "ready" and (.payload.export? != null))
    | {verb, export: .payload.export}
  ]
' "$EVENTS" >"$TRACE_EXPORTS"

status_path="$(jq -r '[.[] | select(.verb == "case" and (.export | test("status\\.html$")))] | .[0].export // empty' "$TRACE_EXPORTS")"
brief_path="$(jq -r '[.[] | select(.verb == "brief" and (.export | test("brief\\.html$")))] | .[0].export // empty' "$TRACE_EXPORTS")"
records_path="$(jq -r '[.[] | select(.verb == "case" and (.export | test("records\\.html$")))] | .[0].export // empty' "$TRACE_EXPORTS")"
assert_eq "$C.trace.status_path" "$STATUS_HTML" "$status_path" "trace exposed status export path"
assert_eq "$C.trace.brief_path" "$BRIEF_HTML" "$brief_path" "trace exposed brief export path"
assert_eq "$C.trace.records_path" "$RECORDS_HTML" "$records_path" "trace exposed records export path"

tool_names="$(jq -sr '[.[] | select(.type == "agent_end") | .messages[]? | select(.role == "assistant") | .content[]? | select(.type == "toolCall") | .name] | join(",")' "$EVENTS")"
if printf '%s' "$tool_names" | grep -q "case" && printf '%s' "$tool_names" | grep -q "brief"; then
  ok "$C.trace.tool_calls" "agent trace includes case and brief tool calls"
else
  fail "$C.trace.tool_calls" "missing expected tool calls in trace: $tool_names"
fi
theme_arg_count="$(jq -sr '[.[] | select(.type == "agent_end") | .messages[]? | select(.role == "assistant") | .content[]? | select(.type == "toolCall") | select(.arguments.theme? != null)] | length' "$EVENTS")"
assert_eq "$C.trace.no_theme_arg" "0" "${theme_arg_count:-0}" "agent did not pass an explicit theme argument"

cond "headless-exported HTML files exist and contain CSI visualization markers from the default"
if [ -f "$STATUS_HTML" ] && grep -q 'data-overcast-theme="csi"' "$STATUS_HTML" && grep -q 'data-csi-status="true"' "$STATUS_HTML" && grep -q "TL;DR" "$STATUS_HTML"; then
  ok "$C.status.html" "headless status HTML exported: $STATUS_HTML"
else
  fail "$C.status.html" "missing status CSI markers"
fi
if [ -f "$BRIEF_HTML" ] && grep -q 'data-overcast-theme="csi"' "$BRIEF_HTML" && grep -q 'data-csi-timeline="true"' "$BRIEF_HTML"; then
  ok "$C.brief.html" "headless brief HTML exported: $BRIEF_HTML"
else
  fail "$C.brief.html" "missing brief CSI markers"
fi
if [ -f "$RECORDS_HTML" ] && grep -q 'data-csi-timeline="true"' "$RECORDS_HTML" && grep -q 'watch' "$RECORDS_HTML"; then
  ok "$C.records.html" "headless records HTML exported: $RECORDS_HTML"
else
  fail "$C.records.html" "missing records CSI timeline"
fi
