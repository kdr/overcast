#!/usr/bin/env bash
# Global archive: bucket init/add/dedup/show, cross-case archive: refs
# (capture pull), ask --archive, and the archive setup wizard (plan/--yes with
# a local image-ransac index + backfill). Fully offline — an isolated
# OVERCAST_HOME keeps buckets out of the user's real home.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

export OVERCAST_HOME="$SMOKE_DIR/archive_home"
mkdir -p "$OVERCAST_HOME"
casedir="$SMOKE_DIR/case_archive"; mkdir -p "$casedir"
G=(--case "$casedir")

clip="$SMOKE_DIR/arch_clip.mp4"; printf 'fake-video-bytes' >"$clip"
img="$SMOKE_DIR/arch_ref.png"; printf 'fake-png-bytes' >"$img"

# --- init + add (tags/note/provenance) ---------------------------------------
init="$($OVERCAST archive init ref-footage --name "Reference footage" --json "${G[@]}" 2>/dev/null)"
save_json "phase9_archive_init" "$init" >/dev/null
assert_eq "archive.init_state" "ready" "$(jq -r '.state' <<<"$init")" "archive init ready"
assert_eq "archive.init_created" "true" "$(jq -r '.payload.created' <<<"$init")" "archive init created the bucket"
assert_eq "archive.init_kind" "archive" "$(jq -r '.kind' "$OVERCAST_HOME/archive/ref-footage/.overcast/case.json")" "bucket case.json stamped kind archive"

add="$($OVERCAST archive add "$clip" "$img" --to ref-footage --tags drone --note "known drone" --json "${G[@]}" 2>/dev/null)"
save_json "phase9_archive_add" "$add" >/dev/null
summary="$(jq -s '.[]|select(.verb=="archive" and .payload.op=="add")' <<<"$add" 2>/dev/null)"
assert_eq "archive.add_count" "2" "$(jq -r '.payload.added|length' <<<"$summary")" "archive add saved both files"
assert_eq "archive.add_sha" "true" "$(jq -r '.payload.added[0].sha256|length > 10' <<<"$summary")" "items carry a sha256"

# the bucket holds the capture records; the case only holds the summary
bucket_caps="$(wc -l <"$OVERCAST_HOME/archive/ref-footage/.overcast/records/capture.jsonl" | tr -d ' ')"
assert_eq "archive.bucket_manifest" "2" "$bucket_caps" "bucket capture.jsonl is the manifest"
if [ -f "$casedir/.overcast/records/capture.jsonl" ]; then
  fail "archive.case_clean" "bucket captures leaked into the case store"
else
  ok "archive.case_clean" "no capture records leaked into the case"
fi

# re-adding identical content dedupes (record + file)
dupe="$SMOKE_DIR/arch_copy.mp4"; printf 'fake-video-bytes' >"$dupe"
add2="$($OVERCAST archive add "$dupe" --to ref-footage --json "${G[@]}" 2>/dev/null)"
summary2="$(jq -s '.[]|select(.verb=="archive" and .payload.op=="add")' <<<"$add2" 2>/dev/null)"
assert_eq "archive.dedup" "1" "$(jq -r '.payload.already_archived|length' <<<"$summary2")" "identical content deduped by sha256"

list="$($OVERCAST archive list --json "${G[@]}" 2>/dev/null)"
assert_eq "archive.list_count" "1" "$(jq -r '.payload.count' <<<"$list")" "archive list sees the bucket"
assert_eq "archive.list_items" "2" "$(jq -r '.payload.buckets[0].items' <<<"$list")" "archive list counts items"

# --- capture archive:<bucket>/<item> pulls a copy into the case --------------
item="$(jq -r '.payload.added[0].path' <<<"$summary" | xargs basename)"
pull="$($OVERCAST capture "archive:ref-footage/$item" --json "${G[@]}" 2>/dev/null)"
save_json "phase9_archive_pull" "$pull" >/dev/null
assert_eq "archive.pull_source" "archive" "$(jq -r '.payload.source' <<<"$pull")" "pull stamped source archive"
assert_eq "archive.pull_origin" "ref-footage" "$(jq -r '.payload.origin.bucket' <<<"$pull")" "pull carries bucket provenance"
case "$(jq -r '.media.ref' <<<"$pull")" in
  "$casedir"/*) ok "archive.pull_copied" "pulled copy landed in the case media dir" ;;
  *) fail "archive.pull_copied" "pulled copy not under the case dir: $(jq -r '.media.ref' <<<"$pull")" ;;
esac
pull2="$($OVERCAST capture "archive:ref-footage/$item" --json "${G[@]}" 2>/dev/null)"
assert_eq "archive.pull_dedup" "true" "$(jq -r '.payload.already_present' <<<"$pull2")" "second pull dedupes"

# --- ask --archive over the bucket (local-grep, zero setup) -------------------
answer="$($OVERCAST ask "drone" --archive ref-footage --json "${G[@]}" 2>/dev/null)"
save_json "phase9_archive_ask" "$answer" >/dev/null
cites="$(jq -r '.payload.citations|length' <<<"$answer")"
[ "${cites:-0}" -ge 1 ] && ok "archive.ask_cites" "ask --archive cites bucket items" || fail "archive.ask_cites" "ask --archive found no citations"
assert_eq "archive.ask_meta" "ref-footage" "$(jq -r '.meta.archive' <<<"$answer")" "answer stamped with the bucket"

# --- setup wizard: guidance → plan → apply (local index + backfill) ----------
wizard="$($OVERCAST archive setup ref-footage --json "${G[@]}" 2>/dev/null)"
assert_eq "archive.setup_wizard" "pending" "$(jq -r '.state' <<<"$wizard")" "no-flag setup returns wizard guidance"
assert_eq "archive.setup_steps" "6" "$(jq -r '.payload.wizard_steps|length' <<<"$wizard")" "wizard has 6 steps"

plan="$($OVERCAST archive setup ref-footage plan --index stills:image-ransac --json "${G[@]}" 2>/dev/null)"
save_json "phase9_archive_setup_plan" "$plan" >/dev/null
assert_eq "archive.setup_plan" "false" "$(jq -r '.payload.saved' <<<"$plan")" "plan does not save"
if [ -f "$OVERCAST_HOME/archive/ref-footage/.overcast/setup.json" ]; then
  fail "archive.setup_plan_no_file" "plan unexpectedly saved setup.json"
else
  ok "archive.setup_plan_no_file" "plan did not save setup.json"
fi

apply="$($OVERCAST archive setup ref-footage --index stills:image-ransac --memory local-grep --auto-index-new --yes --json "${G[@]}" 2>/dev/null)"
save_json "phase9_archive_setup_apply" "$apply" >/dev/null
setup_rec="$(jq -s '.[]|select(.verb=="archive" and .payload.op=="archive_setup")' <<<"$apply" 2>/dev/null)"
assert_eq "archive.setup_saved" "true" "$(jq -r '.payload.saved' <<<"$setup_rec")" "setup apply saved"
assert_eq "archive.setup_backend" "local" "$(jq -r '.indexes[0].backend' "$OVERCAST_HOME/archive/ref-footage/.overcast/indexes.json")" "local index mirrored with backend local"
# backfill routed the archived png into the image index (the mp4 route errors — not an image — and that's fine)
members="$(jq -r '.indexes[0].members|length' "$OVERCAST_HOME/archive/ref-footage/.overcast/indexes.json")"
[ "${members:-0}" -ge 1 ] && ok "archive.setup_backfill" "backfill registered the archived image" || fail "archive.setup_backfill" "backfill registered no members"

status="$($OVERCAST archive setup ref-footage status --json "${G[@]}" 2>/dev/null)"
assert_eq "archive.setup_status_items" "2" "$(jq -r '.payload.items' <<<"$status")" "setup status counts items"

# --- doctor lists the bucket ---------------------------------------------------
doc="$($OVERCAST doctor --json "${G[@]}" 2>/dev/null)"
arch_check="$(jq -r '.payload.checks[]|select(.name=="archive")|.detail' <<<"$doc")"
case "$arch_check" in
  *ref-footage*) ok "archive.doctor" "doctor reports the bucket" ;;
  *) fail "archive.doctor" "doctor archive check missing bucket: $arch_check" ;;
esac
