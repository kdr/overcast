#!/usr/bin/env bash
# Build a uv-managed Python for Overcast's visual DB providers.
#
# Usage:
#   scripts/visual-db-uv.sh          # image matching deps: opencv + numpy
#   scripts/visual-db-uv.sh --face   # also install DeepFace stack
#   scripts/visual-db-uv.sh --clip   # also install OpenAI CLIP (open_clip + torch)
#   scripts/visual-db-uv.sh --detect # also install the OWLv2 open-vocab DETECTOR
#                                     # (torch + transformers + scipy) for `see --detect`
#   scripts/visual-db-uv.sh --all    # install DeepFace + CLIP + detector stacks
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
  --detect|detect)
    # OWLv2 open-vocabulary detector (transformers zero-shot-object-detection);
    # scipy is used by the OWLv2 post-processor. timm is only needed for the
    # optional Grounding DINO model (DETECT_MODEL=IDEA-Research/grounding-dino-tiny).
    uv pip install --python "$VENV/bin/python" torch transformers scipy pillow
    ;;
  --all|all)
    uv pip install --python "$VENV/bin/python" deepface tf-keras
    uv pip install --python "$VENV/bin/python" open-clip-torch torch pillow
    uv pip install --python "$VENV/bin/python" torch transformers scipy pillow
    ;;
  --image|image|"")
    ;;
  *)
    echo "unknown mode: $MODE (expected --image | --face | --clip | --detect | --all)" >&2
    exit 2
    ;;
esac

cat <<EOF
visual DB Python ready:
  $VENV/bin/python

Put this in .env if it is not already set:
  OC_VISUAL_DB_PY=$VENV/bin/python
EOF

case "$MODE" in
  --detect|detect|--all|all)
    cat <<EOF
  DETECT_PY=$VENV/bin/python          # OWLv2 open-vocab detector for \`see --detect\`

Bind the detector as the see provider, then detect + crop:
  overcast setup provider see "exec:$VENV/bin/python $ROOT/examples/providers/detect/detect.py"
  overcast see ./scene.jpg --detect "person, helmet, truck" --json
EOF
    ;;
esac
