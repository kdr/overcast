#!/usr/bin/env python3
# overcast `enhance --ops panorama` (LOCAL): stitch a PANNING video into one wide
# still. Samples frames uniformly across the clip (skipping black + near-duplicate
# frames), then runs OpenCV's Stitcher in PANORAMA mode. The stitched image is a
# first-class media.enhanced child you can then `see`/`crop`/reverse-image-search —
# it exposes a skyline/landmark strip for geolocation that no single frame shows.
# Emits ONE record whose payload.outputs[] is fanned out by the enhance verb.
#
# Bind, then run:
#   overcast setup provider enhance "exec:python3 examples/providers/enhance/panorama.py"
#   overcast enhance pan_shot.mp4 --ops panorama
#   overcast view <parent-id>            # the stitched wide still
#
# Needs:  opencv-python, numpy   (pip install opencv-python numpy — or the uv
#         venv: `scripts/visual-db-uv.sh` installs opencv-python + numpy by default).
# Env:    OVERCAST_MEDIA_DIR (output dir; falls back to the input's directory),
#         OVERCAST_PANORAMA_FRAMES (target sample count, default 18, clamped 6-40)
#
# Exec contract:  describe | init | [run] --input <video> [--ops panorama]
import json
import os
import sys

VID_EXTS = (".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg", ".ts")
TARGET_FRAMES = 18
try:
    TARGET_FRAMES = int(os.environ.get("OVERCAST_PANORAMA_FRAMES", "18"))
except (ValueError, TypeError):
    TARGET_FRAMES = 18
TARGET_FRAMES = max(6, min(40, TARGET_FRAMES))

BLACK_MEAN = 6.0    # frames dimmer than this (0-255) are dropped as black
DUP_MEAN_ABS = 3.0  # frames within this mean-abs-diff of the last kept are dropped

CAVEAT = ("Stitched from sampled frames; parallax/moving subjects can distort geometry — "
          "use it to expose skyline/landmarks for geolocation, not for measurement.")


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, state="error"):
    emit({"verb": "enhance", "format": "json", "payload": {"op": "panorama"},
          "error": msg, "state": state})
    sys.exit(0)


def describe():
    emit({"verb": "enhance", "kind": "media.enhanced", "ops": ["panorama"],
          "accepts": ["video"], "needs": ["opencv-python", "numpy"]})
    sys.exit(0)


def init():
    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("panorama needs: opencv-python + numpy (pip install opencv-python numpy, or the uv venv) — %s\n" % e)
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
            ops = val(i); i += 2  # the dispatch key — must be 'panorama' here
        elif a in ("--prompt", "--speakers", "--at"):
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
    d = os.path.join(base, "panorama")
    os.makedirs(d, exist_ok=True)
    return d


def sample_frames(cv2, np, inp):
    """Uniformly sample ~TARGET_FRAMES across the clip, dropping black +
    near-duplicate frames. Returns a list of BGR frames (in temporal order)."""
    cap = cv2.VideoCapture(inp)
    if not cap.isOpened():
        return []
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frames = []
    prev_gray = None

    def consider(frame):
        nonlocal prev_gray
        if frame is None:
            return
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if float(gray.mean()) < BLACK_MEAN:
            return  # black/near-black frame
        if prev_gray is not None and prev_gray.shape == gray.shape:
            if float(cv2.absdiff(gray, prev_gray).mean()) < DUP_MEAN_ABS:
                return  # near-duplicate of the last kept frame
        prev_gray = gray
        frames.append(frame)

    if total > 1:
        # oversample positions across the FULL clip so black/dup filtering still
        # leaves a healthy overlap set. Do NOT stop at TARGET_FRAMES mid-scan — that
        # would keep only the first ~half of a pan; walk every position, then thin
        # evenly below so the kept frames span the whole clip.
        n = min(total, TARGET_FRAMES * 3)
        idxs = sorted({int(round(k * (total - 1) / (n - 1))) for k in range(n)})
        for idx in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if ok:
                consider(frame)
    else:
        # unreliable metadata (frame_count 0/1): COUNT frames with a cheap grab pass
        # (no decode), then reopen and keep uniformly-spaced indices across the FULL
        # clip by COUNTING (not seeking — unreliable metadata often means seeking is
        # unreliable too). This spans the whole pan instead of just its opening slice.
        count = 0
        while cap.grab():
            count += 1
        cap.release()
        cap = cv2.VideoCapture(inp)
        if count > 1:
            n = min(count, TARGET_FRAMES * 3)
            want = {int(round(k * (count - 1) / (n - 1))) for k in range(n)}
            idx = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if idx in want:
                    consider(frame)
                idx += 1
        else:
            ok, frame = cap.read()
            if ok:
                consider(frame)
    cap.release()

    # thin an oversampled set down to TARGET_FRAMES, evenly across its span, so the
    # stitch input covers the full pan rather than a contiguous early slice.
    if len(frames) > TARGET_FRAMES:
        keep = sorted({int(round(k * (len(frames) - 1) / (TARGET_FRAMES - 1))) for k in range(TARGET_FRAMES)})
        frames = [frames[j] for j in keep]
    return frames


def run():
    inp, ops = parse_args(sys.argv[1:])
    # this provider handles ONLY --ops panorama; a different provider-only op routed
    # here (because it is the bound enhance provider) must fail loudly, not silently
    # stitch a panorama for, say, a requested ela.
    if ops and ops.strip().lower() != "panorama":
        fail("this provider only handles --ops panorama (got %r) — bind the provider that implements %r" % (ops, ops))
    if not inp or not os.path.exists(inp):
        fail("input not found: %r" % inp)
    if not inp.lower().endswith(VID_EXTS):
        fail("panorama is video-only (%s); give it a panning clip" % os.path.basename(inp))

    try:
        import cv2
        import numpy as np
    except Exception as e:  # noqa: BLE001
        fail("panorama deps missing: %s (pip install opencv-python numpy)" % e)

    frames = sample_frames(cv2, np, inp)
    if len(frames) < 2:
        fail("panorama needs at least 2 usable frames from %s (got %d after dropping "
             "black/duplicate frames)" % (os.path.basename(inp), len(frames)))

    mode = getattr(cv2, "Stitcher_PANORAMA", getattr(cv2, "STITCHER_PANORAMA", 0))
    if hasattr(cv2, "Stitcher_create"):
        stitcher = cv2.Stitcher_create(mode)
    else:
        stitcher = cv2.Stitcher.create(mode)

    try:
        status, pano = stitcher.stitch(frames)
    except cv2.error as e:  # noqa: BLE001
        fail("stitching failed (OpenCV error): %s" % str(e)[:200])

    ok_code = getattr(cv2, "Stitcher_OK", getattr(cv2, "STITCHER_OK", 0))
    if status != ok_code or pano is None:
        fail("stitching failed (status %s) — the frames likely have too little overlap "
             "or too much camera motion/parallax; try a slower, steadier pan" % status)

    outdir = _outdir(inp)
    base = os.path.splitext(os.path.basename(inp))[0]
    pano_path = os.path.join(outdir, base + "_panorama.jpg")
    if not cv2.imwrite(pano_path, pano):
        fail("could not write stitched image to %s" % pano_path)

    h, w = int(pano.shape[0]), int(pano.shape[1])
    emit({
        "verb": "enhance", "format": "json",
        "payload": {
            "op": "panorama", "ops": ["panorama"], "input": inp,
            "frames_used": len(frames),
            "outputs": [
                {"kind": "panorama", "ref": pano_path, "label": "panorama",
                 "width": w, "height": h},
            ],
            "caveat": CAVEAT,
        },
        "media": {"ref": inp},
        "meta": {"provider": "local:panorama-cv2"},
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
