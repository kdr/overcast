#!/usr/bin/env python3
# overcast `enhance --ops ela` (LOCAL): image-forensics overlays.
# From ONE input image it derives THREE heuristic maps that make edits visible:
#   1) ELA (Error Level Analysis) — re-save as JPEG q90, amplify the per-pixel
#      abs difference vs the original; pasted/edited regions recompress at a
#      different error level and light up.
#   2) noise residual — input minus a blurred copy, normalized; a spliced patch
#      often carries a different sensor-noise floor than its surroundings.
#   3) luminance gradient — Sobel edge magnitude of the luma channel; exposes
#      cloned/feathered seams and inconsistent edge sharpness.
# Emits ONE record whose payload.outputs[] is fanned out into a record per
# overlay by the enhance verb (parent + 3 children, each a viewable image).
#
# Bind (the `ela` catalog choice), then run:
#   overcast provider setup apply --verb enhance --choice ela --yes
#   overcast enhance suspect.jpg --ops ela
#   overcast view <parent-id>            # gallery of the three overlays
#
# Needs:  pillow, numpy   (pip install pillow numpy — or the uv venv:
#         scripts/visual-db-uv.sh already installs numpy; add pillow, e.g. via
#         `scripts/visual-db-uv.sh --segment`, or `uv pip install pillow`).
# Env:    OVERCAST_MEDIA_DIR (output dir; falls back to the input's directory),
#         OVERCAST_ELA_QUALITY (JPEG re-save quality, default 90),
#         OVERCAST_ELA_BLUR (noise-residual blur radius, default 2.0)
#
# Exec contract:  describe | init | [run] --input <img> [--ops ela]
import io
import json
import os
import sys

IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")
QUALITY = 90
BLUR = 2.0
try:
    QUALITY = int(os.environ.get("OVERCAST_ELA_QUALITY", "90"))
except (ValueError, TypeError):
    QUALITY = 90
try:
    BLUR = float(os.environ.get("OVERCAST_ELA_BLUR", "2.0"))
except (ValueError, TypeError):
    BLUR = 2.0

CAVEAT = ("ELA/noise/luminance maps are HEURISTIC forensic aids — bright seams/edges "
          "can indicate edits but compression, resizing, and texture also trigger them. "
          "A lead, not proof.")


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, state="error"):
    emit({"verb": "enhance", "format": "json", "payload": {"op": "ela"},
          "error": msg, "state": state})
    sys.exit(0)


def describe():
    emit({"verb": "enhance", "kind": "media.enhanced", "ops": ["ela"],
          "accepts": ["image"], "needs": ["pillow", "numpy"]})
    sys.exit(0)


def init():
    try:
        import PIL  # noqa: F401
        import numpy  # noqa: F401
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("ela needs: pillow + numpy (pip install pillow numpy, or a uv venv) — %s\n" % e)
        sys.exit(13)
    sys.exit(0)


def parse_args(argv):
    inp = ""
    ops = ""

    def val(j):
        return argv[j + 1] if j + 1 < len(argv) else ""

    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--input":
            inp = val(i); i += 2
        elif a == "--ops":
            ops = val(i); i += 2  # the dispatch key — must be 'ela' for this provider
        elif a in ("--prompt", "--speakers"):
            i += 2  # accepted; consume the value
        elif a == "--masks-only":
            i += 1
        elif a == "run":
            i += 1
        elif not a.startswith("-"):
            inp = a; i += 1
        else:
            i += 1
    return inp, ops


def _outdir(inp):
    base = os.environ.get("OVERCAST_MEDIA_DIR") or os.path.dirname(os.path.abspath(inp)) or "."
    d = os.path.join(base, "ela")
    os.makedirs(d, exist_ok=True)
    return d


def run():
    inp, ops = parse_args(sys.argv[1:])
    # this provider handles ONLY --ops ela; a different provider-only op routed here
    # (because it is the bound enhance provider) must fail loudly, not silently
    # return an ELA result for, say, a requested panorama.
    if ops and ops.strip().lower() != "ela":
        fail("this provider only handles --ops ela (got %r) — bind the provider that implements %r" % (ops, ops))
    if not inp or not os.path.exists(inp):
        fail("input not found: %r" % inp)
    if not inp.lower().endswith(IMG_EXTS):
        fail("ela is image-only (%s); run it on a frame:// still of a video first" % os.path.basename(inp))

    try:
        import numpy as np
        from PIL import Image, ImageFilter
    except Exception as e:  # noqa: BLE001
        fail("ela deps missing: %s (pip install pillow numpy)" % e)

    try:
        orig = Image.open(inp).convert("RGB")
    except Exception as e:  # noqa: BLE001
        fail("could not read image %r: %s" % (inp, e))

    rgb = np.asarray(orig, dtype=np.float64)

    def normalize_u8(arr):
        """Min/max stretch to 0-255 (uint8)."""
        arr = arr.astype(np.float64)
        lo, hi = float(arr.min()), float(arr.max())
        if hi - lo < 1e-9:
            return np.zeros(arr.shape, dtype=np.uint8)
        return np.clip((arr - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)

    outdir = _outdir(inp)
    base = os.path.splitext(os.path.basename(inp))[0]

    # 1) ELA — re-save as JPEG q90 in memory, diff vs the original, scale so the
    #    MAX per-pixel difference maps to 255 (edited regions recompress hotter).
    buf = io.BytesIO()
    orig.save(buf, format="JPEG", quality=QUALITY)
    buf.seek(0)
    resaved = np.asarray(Image.open(buf).convert("RGB"), dtype=np.float64)
    diff = np.abs(rgb - resaved)
    mx = float(diff.max())
    scale = (255.0 / mx) if mx > 0 else 1.0
    ela = np.clip(diff * scale, 0, 255).astype(np.uint8)
    ela_path = os.path.join(outdir, base + "_ela.png")
    Image.fromarray(ela, mode="RGB").save(ela_path)

    # 2) noise residual — input minus a blurred copy, min/max normalized. A
    #    spliced patch often carries a different high-frequency noise floor.
    blurred = np.asarray(orig.filter(ImageFilter.GaussianBlur(radius=BLUR)), dtype=np.float64)
    residual = normalize_u8(rgb - blurred)
    noise_path = os.path.join(outdir, base + "_noise.png")
    Image.fromarray(residual, mode="RGB").save(noise_path)

    # 3) luminance gradient — Sobel edge magnitude of the luma channel (pure
    #    numpy, edge-padded), normalized. Exposes cloned/feathered seams.
    lum = np.asarray(orig.convert("L"), dtype=np.float64)
    lp = np.pad(lum, 1, mode="edge")
    gx = ((lp[:-2, 2:] + 2 * lp[1:-1, 2:] + lp[2:, 2:])
          - (lp[:-2, :-2] + 2 * lp[1:-1, :-2] + lp[2:, :-2]))
    gy = ((lp[2:, :-2] + 2 * lp[2:, 1:-1] + lp[2:, 2:])
          - (lp[:-2, :-2] + 2 * lp[:-2, 1:-1] + lp[:-2, 2:]))
    mag = normalize_u8(np.sqrt(gx * gx + gy * gy))
    lum_path = os.path.join(outdir, base + "_luminance.png")
    Image.fromarray(mag, mode="L").save(lum_path)

    emit({
        "verb": "enhance", "format": "json",
        "payload": {
            "op": "ela", "ops": ["ela"], "input": inp,
            "quality": QUALITY, "blur": BLUR,
            "outputs": [
                {"kind": "ela", "ref": ela_path, "label": "ELA q%d" % QUALITY},
                {"kind": "noise", "ref": noise_path, "label": "noise residual"},
                {"kind": "luminance", "ref": lum_path, "label": "luminance gradient"},
            ],
            "caveat": CAVEAT,
        },
        "media": {"ref": inp},
        "meta": {"provider": "local:ela"},
        "state": "ready",
    })


def main():
    argv = sys.argv[1:]
    op = argv[0] if argv else "run"
    if op == "describe":
        return describe()
    if op == "init":
        return init()
    run()


main()
