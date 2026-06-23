#!/usr/bin/env bash
# Fixture sense provider (exec): emulates `tinycloud watch <input> --json` by
# echoing a captured real envelope to stdout. Used by unit tests to exercise the
# REAL mapping code offline (fake only at the true external boundary).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cat "$HERE/watch-envelope.json"
