#!/usr/bin/env bash
# Build a uv-managed Python for Overcast's visual DB providers.
#
# Usage:
#   scripts/visual-db-uv.sh          # image matching deps: opencv + numpy
#   scripts/visual-db-uv.sh --face   # also install DeepFace stack
#   scripts/visual-db-uv.sh --clip   # also install OpenAI CLIP (open_clip + torch)
#   scripts/visual-db-uv.sh --audio  # also install audio fingerprint deps (scipy)
#   scripts/visual-db-uv.sh --clap   # also install LAION CLAP audio embeddings (transformers + torch)
#   scripts/visual-db-uv.sh --all    # install the DeepFace, CLIP, audio-fp, and CLAP stacks
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${OVERCAST_VISUAL_DB_VENV:-$ROOT/.dev/visual-db-py}"
PYVER="${OVERCAST_VISUAL_DB_PYTHON:-3.12}"
MODE="${1:-}"
if [ -z "$MODE" ]; then
  MODE="--image"
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/ or run: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

mkdir -p "$(dirname "$VENV")"
uv venv --allow-existing --python "$PYVER" "$VENV"

"$VENV/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || true
uv pip install --python "$VENV/bin/python" --upgrade pip wheel setuptools
uv pip install --python "$VENV/bin/python" opencv-python numpy

case "$MODE" in
  --face|face)
    uv pip install --python "$VENV/bin/python" deepface tf-keras
    ;;
  --clip|clip)
    uv pip install --python "$VENV/bin/python" open-clip-torch torch pillow
    ;;
  --audio|audio)
    uv pip install --python "$VENV/bin/python" scipy
    ;;
  --clap|clap)
    uv pip install --python "$VENV/bin/python" torch transformers
    ;;
  --all|all)
    # torch-owning packages first so uv resolves a single shared torch for the
    # CLIP + CLAP stacks (see docs/providers.md on the shared-venv trade).
    uv pip install --python "$VENV/bin/python" open-clip-torch torch transformers pillow
    uv pip install --python "$VENV/bin/python" deepface tf-keras
    uv pip install --python "$VENV/bin/python" scipy
    ;;
  --image|image|"")
    ;;
  *)
    echo "unknown mode: $MODE (expected --image | --face | --clip | --audio | --clap | --all)" >&2
    exit 2
    ;;
esac

cat <<EOF
visual DB Python ready:
  $VENV/bin/python

Put this in .env if it is not already set:
  OC_VISUAL_DB_PY=$VENV/bin/python
EOF
