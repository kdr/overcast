#!/usr/bin/env bash
# Seed a persistent OFFLINE demo case for the VS Code extension dev host at
# <repo>/.dev/vscode-fixture/case — the folder launch.json opens on F5.
# Reuses the committed e2e fixture providers (test/fixtures/*) so it needs no
# network and no credentials. Prerequisites: `npm run build` at the repo root
# (dist/bin/overcast.js) and ffmpeg on PATH (or OVERCAST_FFMPEG).
#
# The fixture profile lives in an ISOLATED overcast home
# (.dev/vscode-fixture/home) so nothing leaks into ~/.overcast. Extension-
# invoked CLI runs use YOUR real profile — bind real providers (or accept
# needs_credentials prompts) when exercising senses from the UI.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

if [ ! -f "$REPO/dist/bin/overcast.js" ]; then
  echo "seed: dist/bin/overcast.js missing — run 'npm run build' at the repo root first" >&2
  exit 1
fi

oc() { node "$REPO/dist/bin/overcast.js" "$@"; }
step() { echo "seed: $*"; }
try() { # try <label> <cmd...> — non-fatal, keeps seeding on partial failure
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then step "$label ✓"; else step "$label FAILED (non-fatal)"; fi
}

FIX="$REPO/.dev/vscode-fixture"
CASE="$FIX/case"
OC_HOME="$FIX/home"
rm -rf "$FIX"
mkdir -p "$CASE" "$OC_HOME/profiles"

# --- media ------------------------------------------------------------------
FF="${OVERCAST_FFMPEG:-ffmpeg}"
step "generating fixture media via $FF"
"$FF" -y -f lavfi -i "testsrc=size=320x240:rate=10:duration=2" -pix_fmt yuv420p \
  "$CASE/harbor_cam.mp4" >/dev/null 2>&1
"$FF" -y -i "$CASE/harbor_cam.mp4" -frames:v 1 "$CASE/harbor_frame.jpg" >/dev/null 2>&1
cp "$CASE/harbor_cam.mp4" "$FIX/second_clip.mp4"
[ -f "$CASE/harbor_cam.mp4" ] || { echo "seed: ffmpeg clip generation failed" >&2; exit 1; }

# --- fixture providers (offline) ---------------------------------------------
cat >"$OC_HOME/profiles/fixture.json" <<JSON
{"name":"fixture","providers":{"watch":{"type":"exec","run":"bash $REPO/test/fixtures/fake-watch.sh {{input}}"}}}
JSON
export OVERCAST_SOURCE_FIXTURE_CMD="bash $REPO/test/fixtures/fake-source.sh"
export OVERCAST_FIXTURE_CLIP="$CASE/harbor_cam.mp4"
export OVERCAST_FIXTURE_CLIP2="$FIX/second_clip.mp4"
export OVERCAST_NO_DOTENV=1

G=(--case "$CASE" --home "$OC_HOME" --profile fixture)

# --- case skeleton: name + target + source in one shot ------------------------
try "prebrief harborwatch" oc prebrief harborwatch \
  --target "@pier9" --source "fixture:pier9" --json "${G[@]}"
try "target add (question)" oc target add "crane barge" \
  --question "Where is the crane barge moored?" --json "${G[@]}"

# --- records: scan/capture/watch round-trip (fixture source + fixture watch) --
try "scan --pull" oc scan --pull --json "${G[@]}"

# --- forensics: exif w/ GPS (fake exiftool) → map point + a suggested finding --
try "exif (fake exiftool)" env OVERCAST_EXIFTOOL_CMD="bash $REPO/test/fixtures/fake-exiftool.sh" \
  node "$REPO/dist/bin/overcast.js" exif "$CASE/harbor_frame.jpg" --json "${G[@]}"

# --- analyst layer: manual finding + thread note -------------------------------
try "finding create" oc finding create "Crane barge visible at pier 9 in fixture footage" \
  --confidence medium --json "${G[@]}"
try "note (thread)" oc note "Fixture case seeded for the VS Code extension dev host" \
  --json "${G[@]}"

# --- artifacts: player / grid board / map / graph / wall -----------------------
try "view --no-open" oc view "$CASE/harbor_cam.mp4" --no-open --json "${G[@]}"
try "grid --view --no-open" oc grid "$CASE/harbor_cam.mp4" --count 4 --cols 2 --view --no-open --json "${G[@]}"
try "map --offline --no-open" oc map --offline --no-open --json "${G[@]}"
try "graph --no-open" oc graph --no-open --json "${G[@]}"
try "wall --no-open" oc wall --no-open --json "${G[@]}"

step "done — open $FIX in the dev host (F5 uses this path)"
step "case dir: $CASE"
