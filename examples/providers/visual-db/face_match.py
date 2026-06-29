#!/usr/bin/env python3
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

VIDEO_EXTS = (".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpeg", ".mpg", ".ts", ".mts", ".m2ts", ".wmv", ".flv", ".ogv")


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, inp="", op="match", state="error"):
    emit({
        "verb": "face",
        "format": "json",
        "payload": {"op": op, "faces": [], "count": 0},
        "media": {"ref": inp} if inp else None,
        "error": msg,
        "state": state,
    })
    sys.exit(0)


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--op", choices=["detect", "match", "search"], required=True)
    p.add_argument("--index", required=True)
    p.add_argument("--index-dir", required=True)
    p.add_argument("--match")
    p.add_argument("--min-similarity", type=float, default=68.0)
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--group-by", choices=["file"])
    p.add_argument("--fps", type=float)
    p.add_argument("--max-frames", type=int)
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("--thumbnails", action="store_true")
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


def duration(path):
    probe = os.environ.get("OVERCAST_FFPROBE") or "ffprobe"
    try:
        out = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def parse_time(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        pass
    parts = text.split(":")
    if not 1 <= len(parts) <= 3:
        raise ValueError("invalid timestamp: %s" % value)
    try:
        nums = [float(p) for p in parts]
    except ValueError as e:
        raise ValueError("invalid timestamp: %s" % value) from e
    total = 0.0
    for n in nums:
        total = total * 60.0 + n
    return total


def sample_times(dur, max_frames, fps, start=None, end=None):
    start = max(0.0, start or 0.0)
    end = dur if end is None else max(0.0, end)
    if dur > 0:
        end = min(dur, end)
    if end <= start:
        return []
    span = end - start
    if fps and fps > 0:
        count = max(1, int(math.ceil(span * fps)))
        if max_frames and max_frames > 0:
            count = min(count, max_frames)
        interval = 1.0 / fps
        return [min(end, start + (i + 0.5) * interval) for i in range(count)]
    count = max(1, max_frames or 8)
    return [start + span * (i + 0.5) / count for i in range(count)]


def frames(path, max_frames, fps, workdir, start=None, end=None):
    ffmpeg = os.environ.get("OVERCAST_FFMPEG") or "ffmpeg"
    dur = duration(path)
    out = []
    if dur <= 0:
        f = Path(workdir) / "f0.jpg"
        cmd = [ffmpeg, "-y"]
        if start and start > 0:
            cmd.extend(["-ss", "%.3f" % start])
        cmd.extend(["-i", path, "-frames:v", "1", "-q:v", "2", str(f)])
        r = subprocess.run(cmd, capture_output=True, timeout=60)
        if r.returncode == 0 and f.exists():
            out.append((round(start or 0.0, 2), f))
        return out
    for i, at in enumerate(sample_times(dur, max_frames, fps, start, end)):
        f = Path(workdir) / ("f%d.jpg" % i)
        r = subprocess.run([ffmpeg, "-y", "-ss", "%.3f" % at, "-i", path, "-frames:v", "1", "-q:v", "2", str(f)], capture_output=True, timeout=60)
        if r.returncode == 0 and f.exists():
            out.append((round(at, 2), f))
    return out


def represent(deepface, path):
    return deepface.represent(
        img_path=str(path),
        model_name=os.environ.get("OVERCAST_FACE_MODEL", "VGG-Face"),
        detector_backend=os.environ.get("OVERCAST_FACE_DETECTOR", "opencv"),
        align=True,
        enforce_detection=False,
    )


def cosine(a, b):
    import numpy as np
    a = np.array(a, dtype=np.float32)
    b = np.array(b, dtype=np.float32)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def box(face):
    return face.get("facial_area") or face.get("region") or {}


def db_faces(deepface, refs, inp="", op="search"):
    out = []
    for ref in refs:
        try:
            faces = represent(deepface, ref)
        except Exception as e:
            fail("local face reference analysis failed for %s: %s" % (ref, e), inp, op)
        for f in faces:
            emb = f.get("embedding")
            if emb:
                out.append({"name": Path(ref).stem, "image_path": str(ref), "embedding": emb, "box": box(f)})
    return out


def face_items(deepface, path, at=None):
    out = []
    for f in represent(deepface, path):
        emb = f.get("embedding")
        if not emb:
            continue
        item = {"embedding": emb, "box": box(f), "source": str(path)}
        if at is not None:
            item["at"] = at
        out.append(item)
    return out


def safe_face_items(deepface, path, inp, op, at=None):
    try:
        return face_items(deepface, path, at)
    except Exception as e:
        where = "frame %.2f from %s" % (at, inp) if at is not None else str(path)
        fail("local face analysis failed for %s: %s" % (where, e), inp, op)


def main():
    args = parse()
    inp = args.input
    if inp.startswith("http://") or inp.startswith("https://"):
        fail("local face matcher only supports local files; capture remote media first", inp, args.op)
    if not Path(inp).exists():
        fail("input not found: %s" % inp, inp, args.op)
    try:
        from deepface import DeepFace
        import numpy  # noqa: F401
    except Exception as e:
        fail("face matcher deps missing: %s (pip install deepface opencv-python numpy)" % e, inp, args.op)

    refs = [Path(r) for r in index_members(args.index_dir, args.index) if Path(r).exists()]
    if args.op == "search" and not refs:
        fail("local face index has no readable reference images", inp, args.op)
    db = db_faces(DeepFace, refs, inp, args.op) if refs else []
    if args.op == "search" and not db:
        fail("no faces found in local reference images", inp, args.op)

    threshold = args.min_similarity
    if threshold < 0 or threshold > 100:
        fail("--min-similarity must be between 0 and 100", inp, args.op)
    if args.limit <= 0:
        fail("--limit must be positive", inp, args.op)
    if args.offset < 0:
        fail("--offset must be non-negative", inp, args.op)
    try:
        start = parse_time(args.start)
        end = parse_time(args.end)
    except ValueError as e:
        fail(str(e), inp, args.op)
    if start is not None and start < 0:
        fail("--start must be non-negative", inp, args.op)
    if end is not None and end < 0:
        fail("--end must be non-negative", inp, args.op)
    if start is not None and end is not None and end <= start:
        fail("--end must be greater than --start", inp, args.op)

    is_video = inp.lower().endswith(VIDEO_EXTS)
    detections = []
    with tempfile.TemporaryDirectory() as wd:
        queries = frames(inp, args.max_frames, args.fps, wd, start, end) if is_video else [(None, Path(inp))]
        if is_video and not queries:
            fail("could not extract frames from video", inp, args.op)
        for at, path in queries:
            detections.extend(safe_face_items(DeepFace, path, inp, args.op, at))

    results = []
    if args.op == "detect":
        for d in detections[:args.limit]:
            item = {"box": d["box"], "file": inp}
            if "at" in d:
                item["at"] = d["at"]
            results.append(item)
    else:
        if args.op == "search":
            query_faces = safe_face_items(DeepFace, inp, inp, args.op)
        else:
            if not args.match:
                fail("local face match needs --match <reference-image>", inp, args.op)
            if not Path(args.match).exists():
                fail("reference image not found: %s" % args.match, inp, args.op)
            query_faces = detections
            ref_faces = safe_face_items(DeepFace, args.match, inp, args.op)
            if not ref_faces:
                fail("no faces found in local reference image", inp, args.op)
            db = [{"name": Path(args.match).stem, "image_path": args.match, "embedding": f["embedding"], "box": f["box"]} for f in ref_faces]
        for q in query_faces:
            for ref in db:
                sim = cosine(q["embedding"], ref["embedding"]) * 100.0
                if sim >= threshold:
                    item = {
                        "name": ref["name"],
                        "similarity": round(sim, 2),
                        "box": q.get("box", {}),
                        "file": inp if args.op == "match" else ref["image_path"],
                        "reference": ref["image_path"],
                    }
                    if "at" in q:
                        item["at"] = q["at"]
                    results.append(item)
        results.sort(key=lambda x: x.get("similarity", 0), reverse=True)
        if args.op == "search" and args.group_by == "file":
            grouped = {}
            for item in results:
                grouped.setdefault(item.get("file", ""), item)
            results = list(grouped.values())
        if args.op == "search":
            results = results[args.offset:args.offset + args.limit]
        else:
            results = results[:args.limit]

    summary = {
        "detect": "no faces detected" if not results else "%d face detection%s" % (len(results), "" if len(results) == 1 else "s"),
        "match": "reference face was not found" if not results else "%d local face match%s" % (len(results), "" if len(results) == 1 else "es"),
        "search": "no matches for that face across the local index" if not results else "%d local face index match%s" % (len(results), "" if len(results) == 1 else "es"),
    }[args.op]
    media = {"ref": inp}
    if results and "at" in results[0]:
        media["at"] = results[0]["at"]
    emit({
        "verb": "face",
        "format": "json",
        "payload": {
            "op": args.op,
            "index": args.index,
            "reference": args.match,
            "summary": summary,
            "faces": results,
            "count": len(results),
            "sampling": {
                "fps": args.fps,
                "max_frames": args.max_frames if args.max_frames is not None else (None if args.fps else 8),
                "sampled_frames": len(queries) if is_video else 1,
                "start": start,
                "end": end,
            },
        },
        "media": media,
        "meta": {"provider": "local:face", "model": os.environ.get("OVERCAST_FACE_MODEL", "VGG-Face")},
        "state": "ready",
    })


if __name__ == "__main__":
    main()
