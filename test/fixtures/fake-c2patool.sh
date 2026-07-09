#!/usr/bin/env bash
# fake c2patool for offline e2e — impersonates the c2patool CLI so the REAL
# shipped verify.sh (its manifest-store jq mapping + OVERCAST_C2PATOOL_CMD
# override) runs without a real c2patool. `--version` → a version (doctor);
# otherwise (`c2patool <file>`) → a manifest store with an INVALID validation
# state and one derived ingredient.
set -uo pipefail
case "${1:-}" in
  --version) echo "c2patool 0.9.0"; exit 0 ;;
esac
printf '%s\n' '{"active_manifest":"m1","manifests":{"m1":{"claim_generator_info":[{"name":"FakeGen","version":"1.0"}],"signature_info":{"issuer":"Fake CA","alg":"ps256"},"title":"fake.jpg","assertions":[{"label":"c2pa.actions"}],"ingredients":[{"title":"orig.jpg"}]}},"validation_state":"Invalid","validation_status":[{"code":"signingCredential.untrusted"}]}'
