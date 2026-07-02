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
if [ "$mode" = "cred_no_json" ]; then
  echo 'set CLOUDGLUE_API_KEY' >&2
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
if [ "$mode" = "pending_error" ]; then
  # a "pending" envelope that ALSO carries an error (exit 0) — a failed ingest, not
  # in-progress; must map to error, never satisfy accepted().
  echo '{"tinycloud":"1","status":"pending","error":{"code":"ingest","message":"ingest failed"}}'
  exit 0
fi
if [ "$mode" = "low_match" ] && [ "${1:-}" = "face" ] && [ "${2:-}" = "match" ]; then
  echo '{"tinycloud":"1","kind":"face","status":"ready","summary":"1 weak match","data":{"matches":[{"timestamp":5.0,"similarity":4.1,"bounding_box":{"top":0.1,"left":0.1,"width":0.2,"height":0.2}}],"count":1}}'
  exit 0
fi

top="${1:-}"; sub="${2:-}"; sub2="${3:-}"

case "$top" in
  --version|version)
    # default: an old plain-text version (drives the doctor recommended-version
    # warning). OVERCAST_FAKE_TC_FEATURES (a JSON array, e.g. '["see.v1"]')
    # switches to the 0.3.7 JSON form for feature-probe tests (see.sh init).
    if [ -n "${OVERCAST_FAKE_TC_FEATURES:-}" ]; then
      echo "{\"name\":\"tinycloud\",\"version\":\"0.3.7\",\"features\":${OVERCAST_FAKE_TC_FEATURES}}"
    else
      echo "tinycloud 0.3.4"
    fi
    exit 0 ;;
esac

if [ "$top" = "see" ]; then
  # image `see` (0.3.7+): field-for-field the real shape — title/summary/
  # description/scene_text under data.
  case "$mode" in
    no_status) echo '{"tinycloud":"1","kind":"see","summary":"A fixture image of a test pattern.","data":{"title":"Fixture Image","summary":"A fixture image of a test pattern.","description":"A fixture image showing a colorful SMPTE-style test pattern.","scene_text":"HELLO FIXTURE"}}' ;;
    completed) echo '{"tinycloud":"1","kind":"see","status":"completed","summary":"A fixture image of a test pattern.","data":{"title":"Fixture Image","summary":"A fixture image of a test pattern.","description":"A fixture image showing a colorful SMPTE-style test pattern.","scene_text":"HELLO FIXTURE"}}' ;;
    processing) echo '{"tinycloud":"1","kind":"see","status":"processing","data":{"title":"Fixture Image"}}' ;;
    needs_auth) echo '{"tinycloud":"1","kind":"see","status":"needs_auth","error":{"message":"refresh tinycloud auth"}}' ;;
    ready_exit3) echo '{"tinycloud":"1","kind":"see","status":"ready","data":{"title":"Fixture Image"}}'; exit 3 ;;
    nested_error) echo '{"tinycloud":"1","kind":"see","data":{"status":"error","error":{"message":"nested tinycloud failure"}}}' ;;
    *) echo '{"tinycloud":"1","kind":"see","status":"ready","summary":"A fixture image of a test pattern.","data":{"title":"Fixture Image","summary":"A fixture image of a test pattern.","description":"A fixture image showing a colorful SMPTE-style test pattern.","scene_text":"HELLO FIXTURE"}}' ;;
  esac
  exit 0
fi

if [ "$top" = "extract" ]; then
  # image/video `extract` (prompt mode): data.result.entities keyed by
  # snake_cased label, as the real CLI returns for a checklist prompt.
  case "$mode" in
    no_status) echo '{"tinycloud":"1","kind":"extract","summary":"Extracted result for: fixture query","data":{"mode":"prompt","result":{"entities":{"cat":{"present":true,"approximate_count":2,"one_line_evidence":"Two cats sit on the fixture pattern."},"dog":{"present":false,"approximate_count":0,"one_line_evidence":"No dog is visible."}},"segment_entities":[]}}}' ;;
    completed) echo '{"tinycloud":"1","kind":"extract","status":"success","summary":"Extracted result for: fixture query","data":{"mode":"prompt","result":{"entities":{"cat":{"present":true,"approximate_count":2,"one_line_evidence":"Two cats sit on the fixture pattern."},"dog":{"present":false,"approximate_count":0,"one_line_evidence":"No dog is visible."}},"segment_entities":[]}}}' ;;
    processing) echo '{"tinycloud":"1","kind":"extract","status":"processing","data":{"mode":"prompt"}}' ;;
    needs_auth) echo '{"tinycloud":"1","kind":"extract","status":"needs_auth","error":{"message":"refresh tinycloud auth"}}' ;;
    ready_exit3) echo '{"tinycloud":"1","kind":"extract","status":"ready","data":{"mode":"prompt"}}'; exit 3 ;;
    nested_error) echo '{"tinycloud":"1","kind":"extract","data":{"status":"error","error":{"message":"nested tinycloud failure"}}}' ;;
    *) echo '{"tinycloud":"1","kind":"extract","status":"ready","summary":"Extracted result for: fixture query","data":{"mode":"prompt","result":{"entities":{"cat":{"present":true,"approximate_count":2,"one_line_evidence":"Two cats sit on the fixture pattern."},"dog":{"present":false,"approximate_count":0,"one_line_evidence":"No dog is visible."}},"segment_entities":[]}}}' ;;
  esac
  exit 0
fi

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

if [ "$top" = "watch" ]; then
  echo '{"tinycloud":"1","kind":"watch","status":"ready","data":{"title":"Fixture Watch","summary":"A fixture video indexed for local case search.","duration_seconds":5,"segments":[{"start_time":0,"end_time":5,"description":"Fixture scene","summary":"Fixture local watch analysis"}]}}'
  exit 0
fi

if [ "$top" = "library" ] && [ "$sub" = "collections" ]; then
  case "$sub2" in
    create)   echo '{"tinycloud":"1","kind":"collection","status":"ready","result_id":"col_fake123","data":{"collection_id":"col_fake123","name":"fixture","type":"media-descriptions"}}' ;;
    add)      echo '{"tinycloud":"1","kind":"collection","status":"pending","data":{"file_id":"file_abc","status":"pending"}}' ;;
    show)     echo '{"tinycloud":"1","kind":"collection","status":"ready","data":{"id":"col_fake123","files":[{"file_id":"file_abc","status":"completed"},{"file_id":"file_def","status":"pending"}]}}' ;;
    list)     echo '{"tinycloud":"1","kind":"collection","status":"ready","data":{"collections":[{"id":"col_fake123","type":"media-descriptions","name":"fixture"}]}}' ;;
    delete)   echo '{"tinycloud":"1","kind":"collection","status":"ready","data":{"deleted":true,"id":"col_fake123"}}' ;;
    remove)   echo '{"tinycloud":"1","kind":"collection","status":"pending","data":{"status":"pending"}}' ;;
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
