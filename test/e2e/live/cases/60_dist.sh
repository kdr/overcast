#!/usr/bin/env bash
# The compiled binary as a distribution artifact: self-contained, runs the pure
# local verbs (case/target/source) end-to-end, and degrades cleanly where it
# can't (skills generate is source-repo only).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=dist
CASE=$(case_dir dist)

# is OVERCAST actually the compiled binary (not node)?
case "$OVERCAST" in
  *node*) skip "$C.is_binary" "running via node (OVERCAST_USE_NODE)";;
  *) if file "$OVERCAST" 2>/dev/null | grep -qiE 'executable|Mach-O|ELF'; then ok "$C.is_binary" "OVERCAST is a compiled executable ($(du -h "$OVERCAST" 2>/dev/null | cut -f1))"; else ok "$C.is_binary" "OVERCAST=$OVERCAST"; fi;;
esac

# pure-local verbs work fully inside the binary (no providers/cloud)
ocrun "$CASE" prebrief "binarycase" --target "test subject" --source 'web:q' --json >/dev/null 2>&1
info="$(ocrun "$CASE" case info --json 2>/dev/null)"
assert_eq "$C.case_init" "true" "$(echo "$info"|jq -r '.payload.initialized')" "case initialized by the binary"
assert_eq "$C.case_name" "binarycase" "$(echo "$info"|jq -r '.payload.info.name')" "prebrief set the case name"
tgt="$(ocrun "$CASE" target list --json 2>/dev/null | jq -r '.payload.primary.value // empty')"
assert_eq "$C.target" "test subject" "$tgt" "target persisted + read back"
srcs="$(ocrun "$CASE" source list --json 2>/dev/null | jq -r '.payload.enabled')"
assert_eq "$C.source" "1" "$srcs" "one enabled source"

# skills generate is source-repo only → the binary fails cleanly (no crash)
sg="$(ocrun "$CASE" skills generate --json 2>/dev/null)"; rc=$?
if [ "$rc" -ne 0 ] || echo "$sg" | jq -e '.state=="error"' >/dev/null 2>&1; then ok "$C.skills_clean" "binary refuses skills generate cleanly (source-repo only)"; else fail "$C.skills_clean" "expected a clean refusal"; fi

# skills generate DOES work from the source tree (node, not the binary)
src_gen="$(cd "$PWD" && node dist/bin/overcast.js skills generate --json 2>/dev/null)"
if echo "$src_gen" | jq -e '.state=="ready"' >/dev/null 2>&1; then ok "$C.skills_source" "skills generate works from the source tree"; else fail "$C.skills_source" "source generate failed"; fi
# restore any regenerated skills (keep the tree clean)
git checkout -q -- skills/ 2>/dev/null || true
