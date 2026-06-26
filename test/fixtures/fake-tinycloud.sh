#!/usr/bin/env bash
# Fixture tinycloud CLI for OFFLINE tests of the face + collection mappers — the
# fake lives only at the true external boundary (the tinycloud process), so the
# REAL envelope→record mapping code runs. Emulates `tinycloud <verb> … --json`
# by echoing realistic JSON envelopes (skills/tinycloud/reference/envelope.md).
# Bind via OVERCAST_TINYCLOUD_CMD="bash test/fixtures/fake-tinycloud.sh", or pass
# base:"bash …" to runFace/runTinycloud directly. Set OVERCAST_FAKE_TC_MODE=
# error|cred|ready_exit1 to exercise the failure/credential-gap/contradictory-exit mapping.
set -uo pipefail

mode="${OVERCAST_FAKE_TC_MODE:-ok}"
if [ "$mode" = "cred" ]; then
  echo '{"tinycloud":"1","status":"needs_credentials","error":{"code":"no_key","message":"set CLOUDGLUE_API_KEY"}}'
  exit 2
fi
if [ "$mode" = "error" ]; then
  echo '{"tinycloud":"1","status":"error","error":{"code":"boom","message":"something broke"}}'
  exit 1
fi
if [ "$mode" = "ready_exit1" ]; then
  # contradictory: a "ready" envelope but a non-zero exit — must NOT map to ready.
  echo '{"tinycloud":"1","status":"ready","data":{"faces":[],"count":0}}'
  exit 1
fi

top="${1:-}"; sub="${2:-}"; sub2="${3:-}"

case "$top" in
  --version|version) echo "tinycloud 0.3.4"; exit 0 ;;
esac

if [ "$top" = "face" ]; then
  case "$sub" in
    detect)  echo '{"tinycloud":"1","kind":"face","status":"ready","summary":"2 faces detected","data":{"faces":[{"timestamp":1.5,"bounding_box":{"top":0.10,"left":0.20,"width":0.30,"height":0.40}},{"timestamp":4.0,"bounding_box":{"top":0.20,"left":0.10,"width":0.20,"height":0.30}}],"count":2}}' ;;
    match)   echo '{"tinycloud":"1","kind":"face","status":"ready","summary":"1 match","data":{"matches":[{"timestamp":12.0,"similarity":92.5,"bounding_box":{"top":0.1,"left":0.1,"width":0.2,"height":0.2},"thumbnail":"data:image/jpeg;base64,AAAA"}],"count":1}}' ;;
    search)  echo '{"tinycloud":"1","kind":"face","status":"ready","data":{"matches":[{"file":"vid1.mp4","timestamp":3.2,"score":88.0},{"file":"vid2.mp4","timestamp":7.7,"score":81.0}],"count":2}}' ;;
    list)    echo '{"tinycloud":"1","kind":"face","status":"ready","data":{"faces":[{"face_id":"f_1","timestamp":2.0,"bounding_box":{"top":0.1,"left":0.1,"width":0.2,"height":0.2}}],"count":1}}' ;;
    *)       echo '{"tinycloud":"1","status":"error","error":{"message":"unknown face op"}}'; exit 1 ;;
  esac
  exit 0
fi

if [ "$top" = "library" ] && [ "$sub" = "collections" ]; then
  case "$sub2" in
    create)   echo '{"tinycloud":"1","kind":"collection","status":"ready","result_id":"col_fake123","data":{"collection_id":"col_fake123","name":"fixture","type":"media-descriptions"}}' ;;
    add)      echo '{"tinycloud":"1","kind":"collection","status":"pending","data":{"file_id":"file_abc","status":"pending"}}' ;;
    show)     echo '{"tinycloud":"1","kind":"collection","status":"ready","data":{"id":"col_fake123","files":[{"file_id":"file_abc","status":"completed"},{"file_id":"file_def","status":"pending"}]}}' ;;
    list)     echo '{"tinycloud":"1","kind":"collection","status":"ready","data":{"collections":[{"id":"col_fake123","type":"media-descriptions","name":"fixture"}]}}' ;;
    delete)   echo '{"tinycloud":"1","kind":"collection","status":"ready","data":{"deleted":true,"id":"col_fake123"}}' ;;
    remove)   echo '{"tinycloud":"1","kind":"collection","status":"ready","data":{"removed":true}}' ;;
    entities) echo '{"tinycloud":"1","kind":"collection","status":"ready","data":{"entities":[{"name":"ACME Corp","type":"organization"},{"name":"Jane Doe","type":"person"}],"count":2}}' ;;
    *)        echo '{"tinycloud":"1","status":"error","error":{"message":"unknown collections op"}}'; exit 1 ;;
  esac
  exit 0
fi

if [ "$top" = "ask" ] || [ "$top" = "probe" ]; then
  echo '{"tinycloud":"1","kind":"'"$top"'","status":"ready","summary":"answer","data":{"answer":"They objected to the price.","citations":[{"file":"vid1.mp4","timestamp":42.0}]}}'
  exit 0
fi

echo '{"tinycloud":"1","status":"error","error":{"message":"unknown command"}}'
exit 1
