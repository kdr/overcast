#!/usr/bin/env python3
# Local CLAP audio-embedding DB (`basic-clap`) provider for overcast's `similar`
# verb. Cross-modal similarity via LAION CLAP (transformers ClapModel):
# audio->audio (`match`) and text->audio (`search`). Embeddings are precomputed +
# cached on `add` under <index-dir>/emb/<sha1(ref)>.npy (+ .json sidecar) — the
# SAME layout basic-clip uses, so removeClipEmbedding in index.ts cleans it too.
# Structural clone of clip_match.py with frame sampling replaced by 10s audio
# windowing. Same wire contract: read members from indexes.json, emit ONE record.
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

SR = 48000            # CLAP native sampling rate
MIN_CHUNK_S = 1.0     # drop a trailing chunk shorter than this (unless it's the only one)
MAX_WINDOWS = 720     # safety cap (~2h at 10s windows)


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
    p.add_argument("--index-dir", dest="index_dir", required=True)
    p.add_argument("--min-similarity", dest="min_similarity", type=float, default=0.0)
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--pooling", choices=["max", "mean"], default="mean")
    p.add_argument("--granularity", choices=["video", "frame"], default="video")
    p.add_argument("--window", type=float, default=10.0)
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


# ---- ffmpeg decode ---------------------------------------------------------

def has_audio(path):
    probe = os.environ.get("OVERCAST_FFPROBE") or "ffprobe"
    try:
        out = subprocess.run(
            [probe, "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30,
        )
        return "audio" in out.stdout
    except Exception:
        return True


def decode_mono(path):
    import numpy as np
    ffmpeg = os.environ.get("OVERCAST_FFMPEG") or "ffmpeg"
    cmd = [ffmpeg, "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=600)
    except Exception:
        return None
    if r.returncode != 0 or not r.stdout:
        return None
    return np.frombuffer(r.stdout, dtype=np.float32)


def window_audio(samples, window):
    """Split into consecutive `window`-second chunks (hop == window). Returns
    (chunks [np arrays], ats [start seconds], truncated bool)."""
    win = max(1, int(window * SR))
    min_len = int(MIN_CHUNK_S * SR)
    chunks = []
    ats = []
    i = 0
    n = samples.size
    while i < n:
        chunk = samples[i:i + win]
        if chunk.size < min_len and chunks:
            break  # drop a short trailing chunk unless it's the only one
        chunks.append(chunk)
        ats.append(round(i / float(SR), 2))
        i += win
    if not chunks:
        chunks = [samples]
        ats = [0.0]
    truncated = len(chunks) > MAX_WINDOWS
    if truncated:
        chunks = chunks[:MAX_WINDOWS]
        ats = ats[:MAX_WINDOWS]
    return chunks, ats, truncated


# ---- CLAP model (lazy) -----------------------------------------------------

_MODEL = None


def load_model():
    global _MODEL
    if _MODEL is None:
        import torch
        from transformers import ClapModel, ClapProcessor
        name = os.environ.get("OC_CLAP_MODEL", "laion/larger_clap_general")
        device = os.environ.get("OC_CLAP_DEVICE", "cpu")
        model = ClapModel.from_pretrained(name).to(device)
        model.eval()
        processor = ClapProcessor.from_pretrained(name)
        _MODEL = {"model": model, "processor": processor, "device": device, "name": name, "torch": torch}
    return _MODEL


def l2norm(v):
    import numpy as np
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return (v / n).astype("float32")


def pool(vectors, method):
    v = vectors.mean(axis=0, keepdims=True) if method == "mean" else vectors.max(axis=0, keepdims=True)
    return l2norm(v)


def _process_audio(processor, batch):
    # transformers renamed the ClapProcessor kwarg `audios` -> `audio` in v5;
    # prefer the new name and fall back to the old one for pinned <5 installs.
    try:
        return processor(audio=batch, sampling_rate=SR, return_tensors="pt")
    except (TypeError, ValueError):
        return processor(audios=batch, sampling_rate=SR, return_tensors="pt")


def _features(out):
    # transformers <5 returns the projected (B, 512) embedding tensor directly;
    # v5's get_audio_features/get_text_features return an output object whose
    # pooler_output (== audio_embeds/text_embeds) is that projected embedding.
    if hasattr(out, "shape"):
        return out
    for attr in ("audio_embeds", "text_embeds", "pooler_output"):
        v = getattr(out, attr, None)
        if v is not None:
            return v
    return out


def embed_audio_chunks(chunks):
    import numpy as np
    m = load_model()
    torch = m["torch"]
    processor = m["processor"]
    model = m["model"]
    out = []
    for i in range(0, len(chunks), 8):
        batch = [c.astype("float32") for c in chunks[i:i + 8]]
        inputs = _process_audio(processor, batch)
        inputs = {k: v.to(m["device"]) for k, v in inputs.items()}
        with torch.no_grad():
            feats = _features(model.get_audio_features(**inputs))
        out.append(feats.cpu().numpy().astype("float32"))
    return l2norm(np.concatenate(out, axis=0))


def embed_text(text):
    m = load_model()
    torch = m["torch"]
    processor = m["processor"]
    model = m["model"]
    inputs = processor(text=[text], return_tensors="pt", padding=True)
    inputs = {k: v.to(m["device"]) for k, v in inputs.items()}
    with torch.no_grad():
        feats = _features(model.get_text_features(**inputs))
    return l2norm(feats.cpu().numpy().astype("float32"))


def config_hash(args):
    m = load_model()
    payload = json.dumps({
        "pooling": args.pooling, "granularity": args.granularity,
        "window": args.window, "model": m["name"],
    }, sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()


# ---- embedding cache (basic-clip layout) -----------------------------------

def cache_paths(index_dir, ref):
    key = hashlib.sha1(ref.encode()).hexdigest()
    emb_dir = Path(index_dir) / "emb"
    return emb_dir / ("%s.npy" % key), emb_dir / ("%s.json" % key)


def embed_media(ref, args):
    """Return (vectors (N,D) float32, ats [N] with None for pooled, truncated)."""
    import numpy as np
    samples = decode_mono(ref)
    if samples is None or samples.size == 0:
        return np.zeros((0, 1), dtype="float32"), [], False
    chunks, ats, truncated = window_audio(samples, args.window)
    vecs = embed_audio_chunks(chunks)
    if args.granularity == "frame":
        return vecs, ats, truncated
    return pool(vecs, args.pooling), [None], truncated


def index_config_args(args):
    """Member-side config = the PERSISTED index config (config.json), not the
    per-query flags (mirrors clip_match.py). Falls back to clap defaults."""
    cfg = {}
    try:
        cfg = json.loads((Path(args.index_dir) / "config.json").read_text())
    except Exception:
        pass
    return argparse.Namespace(**{
        **vars(args),
        "pooling": cfg.get("pooling") or "mean",
        "granularity": cfg.get("granularity") or "video",
        "window": float(cfg.get("window") or 10.0),
    })


def build_member(ref, args, index_dir, persist=True):
    """Load a member's cached vectors (fresh) or embed + cache them. Returns
    (vectors, ats, granularity) or None when unreadable. persist=False keeps a
    rebuilt embedding in memory only — reads never write."""
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
            if fresh:
                vecs = np.load(str(npy))
                return vecs, meta.get("ats", [None] * len(vecs)), meta.get("granularity", args.granularity)
        except Exception:
            pass
    if not has_audio(ref):
        return None
    vecs, ats, _ = embed_media(ref, args)
    if vecs.shape[0] == 0:
        return None
    if persist:
        npy.parent.mkdir(parents=True, exist_ok=True)
        np.save(str(npy), vecs)
        sidecar.write_text(json.dumps({
            "ref": ref, "kind": "audio",
            "granularity": args.granularity, "ats": ats,
            "config_hash": chash, "mtime": mtime,
            "model": load_model()["name"],
        }))
    return vecs, ats, args.granularity


# ---- ops -------------------------------------------------------------------

def op_add(args):
    ref = args.input
    if not Path(ref).exists():
        fail("input not found: %s" % ref, ref, "add")
    if not has_audio(ref):
        fail("input has no audio stream: %s" % ref, ref, "add")
    member_args = index_config_args(args)
    built = build_member(ref, member_args, args.index_dir)
    if not built:
        fail("could not embed audio (no readable audio): %s" % ref, ref, "add")
    vecs, ats, granularity = built
    emit({
        "verb": "similar",
        "format": "json",
        "payload": {
            "op": "add", "index": args.index, "file": ref,
            "granularity": granularity, "vectors": int(vecs.shape[0]),
            "window": member_args.window,
            "summary": "embedded %s into %s (%d vector%s)" % (Path(ref).name, args.index, vecs.shape[0], "" if vecs.shape[0] == 1 else "s"),
        },
        "media": {"ref": ref},
        "meta": {"provider": "local:basic-clap", "model": load_model()["name"]},
        "state": "ready",
    })


def query_vector(args, op):
    if op == "search":
        return embed_text(args.input)
    ref = args.input
    if not Path(ref).exists():
        fail("input not found: %s" % ref, ref, "match")
    if not has_audio(ref):
        fail("query has no audio stream: %s" % ref, ref, "match")
    # match: window the query and pool to one vector
    vecs, _, _ = embed_media(ref, argparse.Namespace(**{**vars(args), "granularity": "frame"}))
    if vecs.shape[0] == 0:
        fail("could not decode audio from query", ref, "match")
    return pool(vecs, args.pooling)


def op_query(args):
    import numpy as np
    op = args.op
    members = members_full(args.index_dir, args.index)
    if not members:
        fail("local basic-clap index has no members — add some with `similar add ... --index %s`" % args.index, args.input, op)
    if args.min_similarity < 0 or args.min_similarity > 100:
        fail("--min-similarity must be between 0 and 100", args.input, op)
    if args.limit <= 0:
        fail("--limit must be positive", args.input, op)
    if args.offset < 0:
        fail("--offset must be non-negative", args.input, op)
    qv = query_vector(args, op)[0]
    results = []
    member_args = index_config_args(args)
    for mem in members:
        built = build_member(mem["ref"], member_args, args.index_dir, persist=False)
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
        summary = "no acoustically-similar audio" if not results else "%d audio match%s" % (len(results), "" if len(results) == 1 else "es")
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
        "media": {"ref": args.input},
        "meta": {"provider": "local:basic-clap", "model": load_model()["name"]},
        "state": "ready",
    })


def main():
    args = parse()
    inp = args.input
    if args.op != "search":
        if inp.startswith("http://") or inp.startswith("https://"):
            fail("local basic-clap only supports local files; capture remote media first", inp, args.op)
    try:
        import numpy  # noqa: F401
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except Exception as e:
        fail("basic-clap deps missing: %s (run scripts/visual-db-uv.sh --clap)" % e, inp, args.op)
    if args.op == "add":
        op_add(args)
    else:
        op_query(args)


if __name__ == "__main__":
    main()
