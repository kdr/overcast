#!/usr/bin/env bash
# fake yt-dlp for offline tests — impersonates the yt-dlp CLI just enough for
# the doctor probe (OVERCAST_YTDLP_CMD override): `--version` → a date-based
# version (FAKE_YTDLP_VERSION overrides; defaults to today so the staleness
# nudge never fires), `--list-impersonate-targets` → an available curl_cffi
# table, or the "(unavailable)" form when FAKE_YTDLP_IMPERSONATION=0 (the
# brew/apt-build shape).
set -uo pipefail
case "${1:-}" in
  --version)
    echo "${FAKE_YTDLP_VERSION:-$(date -u +%Y.%m.%d)}"; exit 0 ;;
  --list-impersonate-targets)
    echo "[info] Available impersonate targets"
    echo "Client   OS       Source"
    echo "-------------------------------"
    if [ "${FAKE_YTDLP_IMPERSONATION:-1}" = "0" ]; then
      echo "Chrome   -        curl_cffi (unavailable)"
      echo "Safari   -        curl_cffi (unavailable)"
    else
      echo "chrome   -        curl_cffi"
      echo "safari   -        curl_cffi"
    fi
    exit 0 ;;
esac
echo "fake-ytdlp: unsupported args: $*" >&2
exit 2
