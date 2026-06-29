#!/usr/bin/env bash
# Phase 7 e2e: distribution (offline). The flagship skill + reference generate
# from the registry and stay in sync with `commands --json`; the .claude-plugin
# manifest is valid JSON; skills install copies into a harness skills dir.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_dist"; mkdir -p "$casedir"
shipped_skills=(
  overcast
  overcast-init
  overcast-skill-creator
  overcast-media-bug-triage
  overcast-recon-brief
  overcast-visual-target-search
)

# generate the skill + reference from the registry
gen="$($OVERCAST skills generate --json --case "$casedir" 2>/dev/null)"
save_json "phase7_generate" "$gen" >/dev/null
assert_eq "skills.generate" "ready" "$(jq -r '.state' <<<"$gen")" "skills generate ok"
[ -f "$REPO/skills/overcast/SKILL.md" ] && ok "skills.flagship" "flagship SKILL.md written" || fail "skills.flagship" "no SKILL.md"
[ -f "$REPO/skills/overcast/reference/verbs.md" ] && ok "skills.reference" "reference/verbs.md written" || fail "skills.reference" "no reference"
missing_generated=()
for skill in "${shipped_skills[@]}"; do
  [ -f "$REPO/skills/$skill/SKILL.md" ] || missing_generated+=("$skill")
done
if [ "${#missing_generated[@]}" -eq 0 ]; then
  ok "skills.generated_all" "all shipped skill folders written"
else
  fail "skills.generated_all" "missing generated skills: ${missing_generated[*]}"
fi

# the reference is IN SYNC with commands --json (same verb count) — invariant #5
n_cmd="$($OVERCAST commands --json 2>/dev/null | jq '.verbs|length')"
n_ref="$(grep -c '^### `overcast ' "$REPO/skills/overcast/reference/verbs.md")"
assert_eq "skills.in_sync" "$n_cmd" "$n_ref" "reference man pages == registry verbs"

# .claude-plugin manifests are valid JSON
if jq -e . "$REPO/.claude-plugin/plugin.json" >/dev/null 2>&1; then ok "plugin.json" "valid JSON"; else fail "plugin.json" "invalid"; fi
if jq -e '.plugins[0].name' "$REPO/.claude-plugin/marketplace.json" >/dev/null 2>&1; then ok "marketplace.json" "valid + has plugin entry"; else fail "marketplace.json" "invalid"; fi

# skills install copies into a harness skills dir (use a throwaway HOME)
fakehome="$SMOKE_DIR/fakehome"; mkdir -p "$fakehome"
inst="$(HOME="$fakehome" $OVERCAST skills install --harness claude-code --json --case "$casedir" 2>/dev/null)"
save_json "phase7_install" "$inst" >/dev/null
missing_installed=()
for skill in "${shipped_skills[@]}"; do
  [ -f "$fakehome/.claude/skills/$skill/SKILL.md" ] || missing_installed+=("$skill")
done
if [ "${#missing_installed[@]}" -eq 0 ]; then
  ok "skills.install" "all shipped skills installed to ~/.claude/skills"
else
  fail "skills.install" "missing installed skills: ${missing_installed[*]}"
fi

# bun binary smoke (gated on bun availability — compile is slow-ish)
if command -v bun >/dev/null 2>&1; then
  bin="$SMOKE_DIR/overcast-bin"
  if (cd "$REPO" && bun build --compile bin/overcast.ts --outfile "$bin") >/dev/null 2>&1 && [ -f "$bin" ]; then
    bpi="$("$bin" --version --json 2>/dev/null | jq -r '.pi')"
    bverbs="$("$bin" commands --json 2>/dev/null | jq '.verbs|length')"
    assert_eq "binary.version" "0.80.1" "$bpi" "compiled binary reports pinned pi"
    [ "${bverbs:-0}" -ge 11 ] && ok "binary.commands" "compiled binary lists verbs ($bverbs)" || fail "binary.commands" "binary verb surface broken"
    # skills has no embedded source in the binary → must fail CLEANLY (no EROFS crash)
    sk="$("$bin" skills install --json 2>/dev/null)"
    if jq -e '.state=="error"' >/dev/null 2>&1 <<<"$sk"; then ok "binary.skills_clean" "binary skills install fails cleanly (no crash)"; else fail "binary.skills_clean" "binary skills did not fail cleanly"; fi
  else
    fail "binary.compile" "bun build --compile failed"
  fi
else
  ok "binary.skipped" "bun not available; binary smoke skipped"
fi
