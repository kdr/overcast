#!/usr/bin/env python3
# Local CLIP semantic DB (`basic-clip`) provider for overcast's `similar` verb.
# Cross-modal similarity via OpenAI CLIP (open_clip): image->image (`match`) and
# text->image (`search`). Embeddings are precomputed + cached on `add` under
# <index-dir>/emb/<sha1(ref)>.npy (+ .json sidecar); queries only embed the query
# and do a cosine top-K. Same wire contract as image_match.py / face_match.py:
# read members from .overcast/indexes.json, emit ONE JSON record on stdout.
import argparse
import hashlib
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
        "verb": "similar",
        "format": "json",
        "payload": {"op": op, "matches": [], "count": 0},
        "media": {"ref": inp} if inp else None,
        "error": msg,
        "state": state,
    })
    sys.exit(0)


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--op", choices=["add", "match", "search"], required=True)
    p.add_argument("--index", required=True)
    p.add_argument("--index-dir", required=True)
    p.add_argument("--min-similarity", type=float, default=0.0)
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--pooling", choices=["max", "mean"], default="max")
    p.add_argument("--granularity", choices=["video", "frame"], default="video")
    p.add_argument("--sampling", choices=["uniform", "shots"], default="uniform")
    p.add_argument("--window", type=float, default=10.0)
    p.add_argument("--max-frames", type=int, dest="max_frames")
    p.add_argument("--fps", type=float)
    p.add_argument("--frames-at", dest="frames_at")
    p.add_argument("input")
    return p.parse_args()


def members_full(index_dir, index_id):
    idx_file = Path(index_dir).parent.parent / "indexes.json"
    try:
        store = json.loads(idx_file.read_text())
    except Exception:
        return []
    for idx in store.get("indexes", []):
        if idx.get("id") == index_id:
            return [{"ref": m.get("ref"), "recordId": m.get("recordId")} for m in idx.get("members", []) if m.get("ref")]
    return []


# ---- ffmpeg frame sampling (mirrors image_match.py) ------------------------

def duration(path):
    probe = os.environ.get("OVERCAST_FFPROBE") or "ffprobe"
    try:
        out = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def sample_times(dur, window, max_frames, fps):
    if dur <= 0:
        return [0.0]
    if fps and fps > 0:
        count = max(1, int(math.ceil(dur * fps)))
        interval = 1.0 / fps
        times = [min(dur, (i + 0.5) * interval) for i in range(count)]
    elif window and window > 0:
        count = max(1, int(math.ceil(dur / window)))
        times = [min(dur, (i + 0.5) * window) for i in range(count)]
    else:
        count = max(1, max_frames or 8)
        times = [dur * (i + 0.5) / count for i in range(count)]
    if max_frames and max_frames > 0 and len(times) > max_frames:
        # keep an even spread when capping
        step = len(times) / max_frames
        times = [times[min(len(times) - 1, int(i * step))] for i in range(max_frames)]
    return [round(t, 2) for t in times]


def extract_frames(path, times, workdir):
    ffmpeg = os.environ.get("OVERCAST_FFMPEG") or "ffmpeg"
    out = []
    for i, at in enumerate(times):
        f = Path(workdir) / ("f%d.jpg" % i)
        cmd = [ffmpeg, "-y", "-ss", "%.3f" % max(0.0, at), "-i", path, "-frames:v", "1", "-q:v", "2", str(f)]
        r = subprocess.run(cmd, capture_output=True, timeout=60)
        if r.returncode == 0 and f.exists():
            out.append((round(at, 2), f))
    return out


# ---- CLIP model (lazy) -----------------------------------------------------

_MODEL = None


def load_model():
    global _MODEL
    if _MODEL is None:
        import open_clip
        import torch
        model_name = os.environ.get("OC_CLIP_MODEL", "ViT-B-32")
        pretrained = os.environ.get("OC_CLIP_PRETRAINED", "openai")
        device = os.environ.get("OC_CLIP_DEVICE", "cpu")
        model, _, preprocess = open_clip.create_model_and_transforms(model_name, pretrained=pretrained, device=device)
        model.eval()
        tokenizer = open_clip.get_tokenizer(model_name)
        _MODEL = {"model": model, "preprocess": preprocess, "tokenizer": tokenizer, "device": device, "name": model_name, "pretrained": pretrained, "torch": torch}
    return _MODEL


def embed_images(paths):
    import numpy as np
    m = load_model()
    torch = m["torch"]
    from PIL import Image
    tensors = []
    for p in paths:
        img = Image.open(p).convert("RGB")
        tensors.append(m["preprocess"](img))
    batch = torch.stack(tensors).to(m["device"])
    with torch.no_grad():
        feats = m["model"].encode_image(batch)
        feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.cpu().numpy().astype("float32")


def embed_text(text):
    m = load_model()
    torch = m["torch"]
    tokens = m["tokenizer"]([text]).to(m["device"])
    with torch.no_grad():
        feats = m["model"].encode_text(tokens)
        feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.cpu().numpy().astype("float32")


def l2norm(v):
    import numpy as np
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return (v / n).astype("float32")


def pool(vectors, method):
    import numpy as np
    v = vectors.mean(axis=0, keepdims=True) if method == "mean" else vectors.max(axis=0, keepdims=True)
    return l2norm(v)


def is_video(path):
    return str(path).lower().endswith(VIDEO_EXTS)


def config_hash(args):
    m = load_model()
    payload = json.dumps({
        "pooling": args.pooling, "granularity": args.granularity, "sampling": args.sampling,
        "window": args.window, "max_frames": args.max_frames, "fps": args.fps,
        "model": m["name"], "pretrained": m["pretrained"],
    }, sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()


# ---- embedding cache -------------------------------------------------------

def cache_paths(index_dir, ref):
    key = hashlib.sha1(ref.encode()).hexdigest()
    emb_dir = Path(index_dir) / "emb"
    return emb_dir / ("%s.npy" % key), emb_dir / ("%s.json" % key)


def embed_media(ref, args, frames_at=None):
    """Return (vectors (N,D) float32, ats [N] with None for images/pooled)."""
    import numpy as np
    path = Path(ref)
    if not is_video(path):
        vecs = embed_images([str(path)])
        return vecs, [None]
    dur = duration(str(path))
    if frames_at:
        times = [t for t in frames_at if t is not None]
        if dur > 0:
            times = [min(dur, max(0.0, t)) for t in times]
    else:
        times = sample_times(dur, args.window, args.max_frames, args.fps)
    with tempfile.TemporaryDirectory() as wd:
        frames = extract_frames(str(path), times, wd)
        if not frames:
            return np.zeros((0, 1), dtype="float32"), []
        vecs = embed_images([str(f) for _, f in frames])
        ats = [at for at, _ in frames]
    if args.granularity == "frame":
        return l2norm(vecs), ats
    return pool(vecs, args.pooling), [None]


def build_member(ref, args, index_dir, frames_at=None):
    """Load a member's cached vectors (fresh) or embed + cache them. Returns
    (vectors, ats, granularity) or None when the ref is unreadable."""
    import numpy as np
    path = Path(ref)
    if not path.exists():
        return None
    npy, sidecar = cache_paths(index_dir, ref)
    chash = config_hash(args)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    if npy.exists() and sidecar.exists():
        try:
            meta = json.loads(sidecar.read_text())
            fresh = meta.get("config_hash") == chash and abs(float(meta.get("mtime", -1)) - mtime) < 1e-6
            # frames_at is NOT part of config_hash, so an explicit marker list (a
            # fresh `add` with new shot boundaries) must also match what was
            # cached — otherwise re-adding with different markers would appear
            # successful while silently keeping the old vectors.
            if fresh and frames_at is not None and meta.get("frames_at") != frames_at:
                fresh = False
            if fresh:
                vecs = np.load(str(npy))
                return vecs, meta.get("ats", [None] * len(vecs)), meta.get("granularity", args.granularity)
            # stale rebuild (query-time cache miss): reuse the shot markers the
            # member was ORIGINALLY embedded with, so a shots-sampled member is
            # not silently re-embedded on a uniform grid. An explicit frames_at
            # (a fresh `add`) always wins.
            if frames_at is None:
                prior = meta.get("frames_at")
                if isinstance(prior, list) and prior:
                    frames_at = [float(x) for x in prior]
        except Exception:
            pass
    vecs, ats = embed_media(ref, args, frames_at=frames_at)
    if vecs.shape[0] == 0:
        return None
    npy.parent.mkdir(parents=True, exist_ok=True)
    np.save(str(npy), vecs)
    sidecar.write_text(json.dumps({
        "ref": ref, "kind": "video" if is_video(path) else "image",
        "granularity": args.granularity, "ats": ats, "frames_at": frames_at,
        "config_hash": chash, "mtime": mtime,
        "model": load_model()["name"],
    }))
    return vecs, ats, args.granularity


# ---- ops -------------------------------------------------------------------

def op_add(args):
    ref = args.input
    if not Path(ref).exists():
        fail("input not found: %s" % ref, ref, "add")
    frames_at = None
    if args.frames_at:
        try:
            frames_at = [float(x) for x in args.frames_at.split(",") if x.strip() != ""]
        except ValueError:
            frames_at = None
    built = build_member(ref, args, args.index_dir, frames_at=frames_at)
    if not built:
        fail("could not embed media (no readable frames): %s" % ref, ref, "add")
    vecs, ats, granularity = built
    emit({
        "verb": "similar",
        "format": "json",
        "payload": {
            "op": "add", "index": args.index, "file": ref,
            "granularity": granularity, "vectors": int(vecs.shape[0]),
            "sampling": {"mode": args.sampling, "window": args.window, "max_frames": args.max_frames, "fps": args.fps, "frames_at": frames_at},
            "summary": "embedded %s into %s (%d vector%s)" % (Path(ref).name, args.index, vecs.shape[0], "" if vecs.shape[0] == 1 else "s"),
        },
        "media": {"ref": ref},
        "meta": {"provider": "local:basic-clip", "model": load_model()["name"]},
        "state": "ready",
    })


def query_vector(args, op):
    if op == "search":
        return embed_text(args.input)
    # match: an image, or a video pooled to one vector
    ref = args.input
    if not Path(ref).exists():
        fail("input not found: %s" % ref, ref, "match")
    if not is_video(ref):
        return embed_images([ref])
    frames_at = None
    if args.frames_at:
        try:
            frames_at = [float(x) for x in args.frames_at.split(",") if x.strip() != ""]
        except ValueError:
            frames_at = None
    vecs, _ = embed_media(ref, argparse.Namespace(**{**vars(args), "granularity": "frame"}), frames_at=frames_at)
    if vecs.shape[0] == 0:
        fail("could not extract frames from query video", ref, "match")
    return pool(vecs, args.pooling)


def op_query(args):
    import numpy as np
    op = args.op
    members = members_full(args.index_dir, args.index)
    if not members:
        fail("local basic-clip index has no members — add some with `similar add ... --index %s`" % args.index, args.input, op)
    qv = query_vector(args, op)[0]
    if args.min_similarity < 0 or args.min_similarity > 100:
        fail("--min-similarity must be between 0 and 100", args.input, op)
    if args.limit <= 0:
        fail("--limit must be positive", args.input, op)
    if args.offset < 0:
        fail("--offset must be non-negative", args.input, op)
    results = []
    for mem in members:
        built = build_member(mem["ref"], args, args.index_dir)
        if not built:
            continue
        vecs, ats, granularity = built
        for j in range(vecs.shape[0]):
            score = float(np.dot(qv, vecs[j]) * 100.0)
            if score < args.min_similarity:
                continue
            item = {"ref": mem["ref"], "similarity": round(score, 2), "granularity": granularity}
            if mem.get("recordId"):
                item["recordId"] = mem["recordId"]
            at = ats[j] if j < len(ats) else None
            if at is not None:
                item["at"] = at
            results.append(item)
    results.sort(key=lambda x: x.get("similarity", 0), reverse=True)
    results = results[args.offset:args.offset + args.limit]
    if op == "search":
        summary = "no semantic matches for that text" if not results else "%d semantic match%s" % (len(results), "" if len(results) == 1 else "es")
    else:
        summary = "no visually-similar media" if not results else "%d visual match%s" % (len(results), "" if len(results) == 1 else "es")
    media = {"ref": args.input}
    if results and "at" in results[0]:
        media["at"] = results[0]["at"]
    payload = {
        "op": op, "index": args.index, "summary": summary,
        "matches": results, "count": len(results),
    }
    if op == "search":
        payload["query"] = args.input
    emit({
        "verb": "similar",
        "format": "json",
        "payload": payload,
        "media": media,
        "meta": {"provider": "local:basic-clip", "model": load_model()["name"]},
        "state": "ready",
    })


def main():
    args = parse()
    inp = args.input
    if args.op != "search":
        if inp.startswith("http://") or inp.startswith("https://"):
            fail("local basic-clip only supports local files; capture remote media first", inp, args.op)
    try:
        import numpy  # noqa: F401
        import open_clip  # noqa: F401
        import torch  # noqa: F401
        from PIL import Image  # noqa: F401
    except Exception as e:
        fail("basic-clip deps missing: %s (run scripts/visual-db-uv.sh --clip)" % e, inp, args.op)
    if args.op == "add":
        op_add(args)
    else:
        op_query(args)


if __name__ == "__main__":
    main()
