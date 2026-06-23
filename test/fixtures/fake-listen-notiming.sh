#!/usr/bin/env bash
# Fixture: a speech segment with text but NO start/end timing.
set -euo pipefail
echo '{"kind":"watch","status":"ready","data":{"language":"en","segments":[{"speaker":"A","transcript":"a segment with no timing"}]}}'
