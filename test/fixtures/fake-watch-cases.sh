#!/usr/bin/env bash
# Parametrized fixture sense provider for exercising runWatch's failure/pending
# mapping offline. Usage: fake-watch-cases.sh <mode> <input>
#   ok        -> valid envelope, exit 0
#   exit7     -> valid-looking envelope but exit 7 (e.g. quota error)
#   error     -> error envelope (status:error), exit 0
#   pending   -> pending marker nested under data, exit 0
set -uo pipefail
mode="${1:-ok}"
case "$mode" in
  ok)      echo '{"kind":"watch","data":{"summary":"hi","title":"t"}}' ;;
  exit7)   echo '{"kind":"watch","data":{}}'; exit 7 ;;
  error)   echo '{"status":"error","error":"quota exceeded","data":{}}' ;;
  pending) echo '{"kind":"watch","data":{"state":"pending","summary":"x"}}' ;;
  *)       echo "{}"; exit 1 ;;
esac
