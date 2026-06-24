#!/usr/bin/env python3
# overcast `see` provider: open-vocabulary OBJECT DETECTION (zero-shot) run
# LOCALLY via transformers. Takes a list of target objects + an image OR a video
# (frames sampled with ffmpeg) and returns bounding boxes.
#
# Default model: OWLv2 (google/owlv2-base-patch16-ensemble) — small, CPU-friendly,
# open-vocabulary. Switch to Grounding DINO with DETECT_MODEL=IDEA-Research/grounding-dino-tiny.
# Both run through the transformers `zero-shot-object-detection` pipeline, so they
# take your `--detect` list as candidate labels (no fixed COCO vocabulary).
#
# Bind it as the `see` provider, then drive detection with `see --detect`:
#   overcast setup provider see "exec:python3 examples/providers/detect/detect.py"
#   overcast see ./scene.jpg --detect "car, person, license plate" --json
#   overcast see ./clip.mp4  --detect "weapon, backpack" --json       # video → frames sampled
#
# Needs:  pip install torch transformers pillow   (Grounding DINO also needs `timm`)
# Env:    DETECT_MODEL (default google/owlv2-base-patch16-ensemble),
#         DETECT_THRESHOLD (default 0.1), DETECT_MAX_FRAMES (default 8),
#         OVERCAST_FFMPEG (ffmpeg path; set by overcast — else `ffmpeg` on PATH),
#         OVERCAST_MEDIA_DIR (set by overcast; annotated frames are written here).
#
# Exec contract:  <cmd> describe | init | [run] --input <ref> --detect "a,b"
#                                          [--threshold F] [--max-frames N]
import json
import os
import shutil
import subprocess
import sys
import tempfile

def _envnum(name, default, cast):  # tolerant env parse — never crash at import
    try:
        return cast(os.environ.get(name, default))
    except (ValueError, TypeError):
        return cast(default)

MODEL = os.environ.get("DETECT_MODEL", "google/owlv2-base-patch16-ensemble")
THRESHOLD = _envnum("DETECT_THRESHOLD", "0.1", float)
MAX_FRAMES = _envnum("DETECT_MAX_FRAMES", "8", int)
FFMPEG = os.environ.get("OVERCAST_FFMPEG") or "ffmpeg"
VIDEO_EXTS = (".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v")


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, state="error"):
    emit({"verb": "see", "format": "json",
          "payload": {"caption": "", "ocr": "", "detections": []},
          "error": msg, "state": state})
    sys.exit(0)


def describe():
    emit({"verb": "see", "kind": "image.analysis",
          "payload": ["detections"], "model": MODEL,
          "task": "zero-shot-object-detection", "accepts": ["image", "video"],
          "needs": ["torch", "transformers", "pillow"]})
    sys.exit(0)


def init():
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        import PIL  # noqa: F401
    except Exception as e:
        sys.stderr.write("object-detection provider needs: pip install torch transformers pillow (%s)\n" % e)
        sys.exit(13)
    sys.exit(0)


def parse_args(argv):
    inp, detect, thr, maxf = "", "", THRESHOLD, MAX_FRAMES
    i = 0
    # value for a flag at index i, or "" if it's the last token (no IndexError on
    # a truncated invocation like `… --detect`)
    def val(j):
        return argv[j + 1] if j + 1 < len(argv) else ""
    def num(s, default, cast):  # tolerant numeric parse (no ValueError crash)
        try:
            return cast(s)
        except (ValueError, TypeError):
            return default
    while i < len(argv):
        a = argv[i]
        if a == "--input":
            inp = val(i); i += 2
        elif a == "--detect":
            detect = val(i); i += 2
        elif a == "--threshold":
            thr = num(val(i), thr, float); i += 2
        elif a == "--max-frames":
            maxf = num(val(i), maxf, int); i += 2
        elif a in ("--prompt", "--embed"):
            i += 2 if a == "--prompt" else 1
        elif a in ("--ocr", "run"):
            i += 1
        elif not a.startswith("-"):
            inp = a; i += 1  # last positional wins (input contract)
        else:
            i += 1
    return inp, detect, thr, maxf


def video_duration(path):
    """Best-effort duration via ffprobe sibling of OVERCAST_FFMPEG (or ffmpeg -i)."""
    probe = (os.environ.get("OVERCAST_FFPROBE")
             or (FFMPEG[:-6] + "ffprobe" if FFMPEG.endswith("ffmpeg") else "ffprobe"))
    try:
        out = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=nw=1:nk=1", path],
                             capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def extract_frames(path, n, workdir):
    """Sample up to n frames evenly across the video → list of (time_s, frame_path)."""
    dur = video_duration(path)
    frames = []
    if dur <= 0:
        # fallback: a single frame near the start
        f = os.path.join(workdir, "f0.jpg")
        r = subprocess.run([FFMPEG, "-y", "-i", path, "-frames:v", "1", "-q:v", "2", f],
                           capture_output=True, timeout=60)
        if r.returncode == 0 and os.path.exists(f):
            frames.append((0.0, f))
        return frames
    n = max(1, n)
    for k in range(n):
        t = dur * (k + 0.5) / n
        f = os.path.join(workdir, "f%d.jpg" % k)
        r = subprocess.run([FFMPEG, "-y", "-ss", "%.3f" % t, "-i", path,
                            "-frames:v", "1", "-q:v", "2", f],
                           capture_output=True, timeout=60)
        if r.returncode == 0 and os.path.exists(f):
            frames.append((round(t, 2), f))
    return frames


def run():
    argv = sys.argv[1:]
    inp, detect, thr, maxf = parse_args(argv)
    if not inp or not os.path.exists(inp):
        fail("input not found: %r" % inp)
    labels = [s.strip() for s in detect.split(",") if s.strip()]
    if not labels:
        fail("object detection needs --detect \"<comma-separated target objects>\"")

    try:
        from PIL import Image
        from transformers import pipeline
    except Exception as e:
        # missing python deps is a broken environment, not a credential gap →
        # state:error (not needs_credentials, which would exit 3 = "needs a key")
        fail("detector deps missing: %s (pip install torch transformers pillow)" % e, state="error")

    try:
        detector = pipeline("zero-shot-object-detection", model=MODEL)
    except Exception as e:
        fail("could not load model %s: %s" % (MODEL, e))

    is_video = inp.lower().endswith(VIDEO_EXTS)
    media_dir = os.environ.get("OVERCAST_MEDIA_DIR")
    detections = []

    def detect_image(img_path, t=None):
        img = Image.open(img_path).convert("RGB")
        res = detector(img, candidate_labels=labels, threshold=thr)
        for r in res:
            b = r["box"]
            d = {"label": r["label"], "score": round(float(r["score"]), 4),
                 "box": {"xmin": int(b["xmin"]), "ymin": int(b["ymin"]),
                         "xmax": int(b["xmax"]), "ymax": int(b["ymax"])}}
            if t is not None:
                d["at"] = t
            detections.append(d)

    if is_video:
        with tempfile.TemporaryDirectory() as wd:
            frames = extract_frames(inp, maxf, wd)
            if not frames:
                fail("could not extract frames (need ffmpeg — OVERCAST_FFMPEG or on PATH)")
            frame_ok = 0
            for t, fp in frames:
                try:
                    detect_image(fp, t)
                    frame_ok += 1
                except Exception as e:
                    sys.stderr.write("frame %.2fs failed: %s\n" % (t, e))
            # if EVERY sampled frame failed, that's a detection error — not a
            # successful "no objects found" scan with an empty detections list.
            if frame_ok == 0:
                fail("object detection failed on all %d sampled frames" % len(frames))
        frames_used = frame_ok
    else:
        try:
            detect_image(inp)
        except Exception as e:
            fail("detection failed: %s" % e)
        frames_used = 1

    # copy the analyzed media into the case store (so `view <see-rec>` works)
    out_ref = inp
    if media_dir:
        try:
            os.makedirs(media_dir, exist_ok=True)
            dst = os.path.join(media_dir, "detect_" + os.path.basename(inp))
            shutil.copyfile(inp, dst)
            out_ref = dst
        except Exception:
            pass

    detections.sort(key=lambda d: -d["score"])
    by_label = {}
    for d in detections:
        by_label[d["label"]] = by_label.get(d["label"], 0) + 1
    emit({"verb": "see", "format": "json",
          "payload": {"caption": "", "ocr": "",
                      "detections": detections,
                      "counts": by_label,
                      "categories": labels,
                      "model": MODEL,
                      "threshold": thr,
                      "frames": frames_used},
          "media": {"ref": out_ref},
          "meta": {"provider": "object-detect", "model": MODEL},
          "state": "ready"})


def main():
    argv = sys.argv[1:]
    # the subcommand is ONLY the first token — so object labels that happen to be
    # "describe"/"init" (e.g. `run --detect describe`) don't trigger a subcommand.
    op = argv[0] if argv else "run"
    if op == "describe":
        return describe()
    if op == "init":
        return init()
    run()


main()
