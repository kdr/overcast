#!/usr/bin/env bash
# Fixture watch provider that emits a proper overcast RECORD (the exec wire
# contract) — used to test the custom-provider pass-through path end to end.
# (The tinycloud ENVELOPE→record mapping is covered by the unit mapper test.)
set -euo pipefail
input="${1:-clip.mp4}"
cat <<JSON
{"verb":"watch","format":"json",
 "payload":{"content":"# $input\nA fixture watch record with content.","transcript":"","detailed":{"title":"fixture","segments":[]}},
 "media":{"ref":"$input"},"meta":{"provider":"fixture-watch"},"state":"ready"}
JSON
