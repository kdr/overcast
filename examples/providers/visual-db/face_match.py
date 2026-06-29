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
    p.add_argument("--fps", type=float)
    p.add_argument("--max-frames", type=int)
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


def db_faces(deepface, refs):
    out = []
    for ref in refs:
        try:
            faces = represent(deepface, ref)
        except Exception:
            continue
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
    db = db_faces(DeepFace, refs) if refs else []
    if args.op == "search" and not db:
        fail("no faces found in local reference images", inp, args.op)

    threshold = args.min_similarity
    if threshold < 0 or threshold > 100:
        fail("--min-similarity must be between 0 and 100", inp, args.op)

    is_video = inp.lower().endswith(VIDEO_EXTS)
    detections = []
    with tempfile.TemporaryDirectory() as wd:
        queries = frames(inp, args.max_frames, args.fps, wd) if is_video else [(None, Path(inp))]
        if is_video and not queries:
            fail("could not extract frames from video", inp, args.op)
        for at, path in queries:
            try:
                detections.extend(face_items(DeepFace, path, at))
            except Exception:
                continue

    results = []
    if args.op == "detect":
        for d in detections[:args.limit]:
            item = {"box": d["box"], "file": inp}
            if "at" in d:
                item["at"] = d["at"]
            results.append(item)
    else:
        if args.op == "search":
            query_faces = face_items(DeepFace, inp)
        else:
            if not args.match:
                fail("local face match needs --match <reference-image>", inp, args.op)
            if not Path(args.match).exists():
                fail("reference image not found: %s" % args.match, inp, args.op)
            query_faces = detections
            ref_faces = face_items(DeepFace, args.match)
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
            },
        },
        "media": media,
        "meta": {"provider": "local:face", "model": os.environ.get("OVERCAST_FACE_MODEL", "VGG-Face")},
        "state": "ready",
    })


if __name__ == "__main__":
    main()
