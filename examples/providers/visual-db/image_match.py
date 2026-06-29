#!/usr/bin/env python3
import argparse
import math
import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

VIDEO_EXTS = (".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpeg", ".mpg", ".ts", ".mts", ".m2ts", ".wmv", ".flv", ".ogv")


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, inp="", state="error"):
    emit({
        "verb": "image",
        "format": "json",
        "payload": {"op": "match", "matches": [], "count": 0},
        "media": {"ref": inp} if inp else None,
        "error": msg,
        "state": state,
    })
    sys.exit(0)


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--op", default="match")
    p.add_argument("--index", required=True)
    p.add_argument("--index-dir", required=True)
    p.add_argument("--min-inliers", type=int, default=15)
    p.add_argument("--min-ratio", type=float, default=0.4)
    p.add_argument("--ratio-test", type=float, default=0.75)
    p.add_argument("--fps", type=float)
    p.add_argument("--max-frames", type=int)
    p.add_argument("--draw", action="store_true")
    p.add_argument("input")
    return p.parse_args()


def index_members(index_dir, index_id):
    idx_file = Path(index_dir).parent.parent / "indexes.json"
    try:
        store = json.loads(idx_file.read_text())
    except Exception:
        return []
    for idx in store.get("indexes", []):
        if idx.get("id") == index_id:
            return [m.get("ref") for m in idx.get("members", []) if m.get("ref")]
    return []


def detector(cv2):
    try:
        return cv2.SIFT_create(), True
    except Exception:
        return cv2.ORB_create(5000), False


def matcher(cv2, use_flann):
    if use_flann:
        return cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), {})
    return cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)


def image_features(cv2, det, path):
    img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None, None, None
    k, d = det.detectAndCompute(img, None)
    return img, k, d


def compare(cv2, np, det, use_flann, ref_path, ref_label, query_path, args, out_dir):
    ref_img, ref_k, ref_d = image_features(cv2, det, ref_path)
    q_img, q_k, q_d = image_features(cv2, det, query_path)
    if ref_d is None or q_d is None:
        return None
    raw = matcher(cv2, use_flann).knnMatch(ref_d, q_d, k=2)
    good = [m for pair in raw if len(pair) == 2 for m, n in [pair] if m.distance < args.ratio_test * n.distance]
    if len(good) < 4:
        return None
    src = np.float32([ref_k[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([q_k[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    h, mask = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
    if h is None:
        return None
    inliers = int(mask.sum())
    ratio = inliers / len(good)
    if inliers < args.min_inliers or ratio < args.min_ratio:
        return None
    vis_path = None
    if args.draw:
        out_dir.mkdir(parents=True, exist_ok=True)
        vis = cv2.drawMatches(ref_img, ref_k, q_img, q_k, good, None, matchesMask=mask.ravel().tolist(), flags=cv2.DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS)
        vis_path = out_dir / ("%s.jpg" % uuid.uuid4().hex)
        cv2.imwrite(str(vis_path), vis)
    return {
        "label": ref_label,
        "db_img_path": str(Path(ref_path).resolve()),
        "query_path": str(Path(query_path).resolve()),
        "num_matches": len(good),
        "num_inliers": inliers,
        "inlier_ratio": round(float(ratio), 4),
        "homography": h.tolist(),
        "match_draw_path": str(vis_path.resolve()) if vis_path else None,
    }


def duration(path):
    probe = os.environ.get("OVERCAST_FFPROBE") or "ffprobe"
    try:
        out = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def sample_times(dur, max_frames, fps):
    if fps and fps > 0:
        count = max(1, int(math.ceil(dur * fps)))
        if max_frames and max_frames > 0:
            count = min(count, max_frames)
        interval = 1.0 / fps
        return [min(dur, (i + 0.5) * interval) for i in range(count)]
    count = max(1, max_frames or 8)
    return [dur * (i + 0.5) / count for i in range(count)]


def frames(path, max_frames, fps, workdir):
    ffmpeg = os.environ.get("OVERCAST_FFMPEG") or "ffmpeg"
    dur = duration(path)
    out = []
    if dur <= 0:
        f = Path(workdir) / "f0.jpg"
        r = subprocess.run([ffmpeg, "-y", "-i", path, "-frames:v", "1", "-q:v", "2", str(f)], capture_output=True, timeout=60)
        if r.returncode == 0 and f.exists():
            out.append((0.0, f))
        return out
    for i, at in enumerate(sample_times(dur, max_frames, fps)):
        f = Path(workdir) / ("f%d.jpg" % i)
        r = subprocess.run([ffmpeg, "-y", "-ss", "%.3f" % at, "-i", path, "-frames:v", "1", "-q:v", "2", str(f)], capture_output=True, timeout=60)
        if r.returncode == 0 and f.exists():
            out.append((round(at, 2), f))
    return out


def main():
    args = parse()
    inp = args.input
    if inp.startswith("http://") or inp.startswith("https://"):
        fail("local image matcher only supports local files; capture remote media first", inp)
    if not Path(inp).exists():
        fail("input not found: %s" % inp, inp)
    try:
        import cv2
        import numpy as np
    except Exception as e:
        fail("image matcher deps missing: %s (pip install opencv-python numpy)" % e, inp)

    refs = [Path(r) for r in index_members(args.index_dir, args.index) if Path(r).exists()]
    if not refs:
        fail("local image index has no readable reference images", inp)
    det, use_flann = detector(cv2)
    out_dir = Path(os.environ.get("OVERCAST_MEDIA_DIR") or args.index_dir) / "image-matches"
    is_video = inp.lower().endswith(VIDEO_EXTS)
    matches = []
    with tempfile.TemporaryDirectory() as wd:
        queries = frames(inp, args.max_frames, args.fps, wd) if is_video else [(None, Path(inp))]
        if not queries:
            fail("could not extract frames from video", inp)
        for at, q in queries:
            for ref in refs:
                m = compare(cv2, np, det, use_flann, ref, ref.stem, q, args, out_dir)
                if m:
                    if at is not None:
                        m["at"] = at
                    matches.append(m)
    matches.sort(key=lambda x: x.get("num_inliers", 0), reverse=True)
    emit({
        "verb": "image",
        "format": "json",
        "payload": {
            "op": "match",
            "index": args.index,
            "summary": "no image matches" if not matches else "%d image match%s" % (len(matches), "" if len(matches) == 1 else "es"),
            "matches": matches,
            "count": len(matches),
            "sampling": {
                "fps": args.fps,
                "max_frames": args.max_frames if args.max_frames is not None else (None if args.fps else 8),
                "sampled_frames": len(queries) if is_video else 1,
            },
        },
        "media": {"ref": inp, "at": matches[0]["at"]} if matches and "at" in matches[0] else {"ref": inp},
        "meta": {"provider": "local:image-ransac", "model": "opencv-sift-or-orb"},
        "state": "ready",
    })


if __name__ == "__main__":
    main()
