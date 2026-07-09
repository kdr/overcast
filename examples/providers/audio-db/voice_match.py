#!/usr/bin/env python3
# Local speaker-verification DB (`voice-print`) provider for overcast's `voice`
# verb. Given a reference voice sample: rank that speaker inside a clip
# (`match`, windowed cosine scoring — `--diarize` upgrades to diarize-then-match
# against pyannote pipeline speaker centroids, same embedding space), rank
# enrolled index members that contain the speaker (`search`), or enroll a member
# (`add`). Embeddings: a pyannote.audio speaker model — default the UNGATED
# pyannote/wespeaker-voxceleb-resnet34-LM (CC-BY-4.0); the diarize tier needs
# HF_TOKEN + the accepted pyannote pipeline license (same gate as
# `enhance --ops separate`) and falls back to windowed mode without it.
# Cache layout matches basic-clip/clap: <index-dir>/emb/<sha1(ref)>.npy
# (+ .json sidecar), so removeClipEmbedding in index.ts cleans it too. Same wire
# contract: read members from indexes.json, emit ONE record.
#
# Scores: `similarity` is raw cosine mapped through fixed anchors (0.25 -> 50,
# 0.60 -> 90) — a RANK score, not a probability; the raw `cosine` is emitted
# alongside. NOT liveness: a cloned/synthetic voice can score high.
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

SR = 16000              # speaker models expect 16k mono
WINDOW_S = 3.0          # seconds per embedding window
STEP_S = 0.75           # query hop for pairwise scans (members embed hop == window)
FRAME_S = 0.03          # RMS VAD-lite frame
SPEECH_DBFS = -40.0     # voiced = frame RMS above this dBFS
MIN_WINDOW_SPEECH_S = 1.0   # skip windows with less voiced audio
MIN_REF_SPEECH_S = 3.0      # DEFAULT reference / diarized-speaker net-speech floor
                            # (an index search overrides it with the index's
                            # persisted VoicePrintConfig.minSpeechSeconds)
MAX_QUERY_WINDOWS = 2400    # ~30 min at 0.75s hop
MAX_MEMBER_WINDOWS = 1200   # ~60 min at 3s windows
CENTROID_MAX_S = 30.0       # recomputed-centroid speech cap per speaker
MERGE_GAP = 0.3             # merge a speaker's turns closer than this (seconds)
# cosine -> 0-100 rank score. Piecewise-linear through these anchors (NOT
# (cos+1)/2 — a 50 must mean "at the accept floor", not "definite non-match").
ANCHORS = [(-1.0, 0.0), (0.0, 20.0), (0.25, 50.0), (0.60, 90.0), (0.75, 100.0)]

MODEL = os.environ.get("OVERCAST_VOICE_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
DIARIZE_MODEL = os.environ.get("OVERCAST_DIARIZE_MODEL", "pyannote/speaker-diarization-community-1")
DEVICE = os.environ.get("OC_VOICE_DEVICE", "cpu")
TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
GATE_URL = "https://huggingface.co/pyannote/speaker-diarization-community-1"
CAVEAT = ("speaker similarity is not liveness: a cloned/synthetic voice can score high and "
          "cross-language or degraded speech scores lower — corroborate before treating a match as identification")

_CTX = {"inp": "", "op": "match"}


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, state="error"):
    emit({
        "verb": "voice",
        "format": "json",
        "payload": {"op": _CTX["op"], "matches": [], "count": 0},
        "media": {"ref": _CTX["inp"]} if _CTX["inp"] else None,
        "error": msg,
        "state": state,
    })
    sys.exit(0)


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--op", choices=["add", "match", "search"], required=True)
    p.add_argument("--index")
    p.add_argument("--index-dir", dest="index_dir")
    p.add_argument("--match")
    p.add_argument("--diarize", action="store_true")
    p.add_argument("--speakers", type=int)
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("--window", type=float)
    p.add_argument("--min-similarity", dest="min_similarity", type=float, default=50.0)
    p.add_argument("--min-margin", dest="min_margin", type=float)
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--offset", type=int, default=0)
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
    # copy: frombuffer is read-only and torch.from_numpy needs a writable array
    return np.frombuffer(r.stdout, dtype=np.float32).copy()


# ---- VAD-lite (RMS gate) ----------------------------------------------------

def voiced_mask(samples):
    """Per-FRAME_S boolean voiced mask (frame RMS above SPEECH_DBFS)."""
    import numpy as np
    frame = max(1, int(FRAME_S * SR))
    floor = 10.0 ** (SPEECH_DBFS / 20.0)
    n = samples.size // frame
    if n == 0:
        rms = float(np.sqrt(np.mean(samples.astype("float64") ** 2))) if samples.size else 0.0
        return np.array([rms > floor]), frame
    trimmed = samples[: n * frame].reshape(n, frame).astype("float64")
    rms = np.sqrt(np.mean(trimmed ** 2, axis=1))
    return rms > floor, frame


def speech_between(mask, frame, i0, i1):
    """Voiced seconds within samples[i0:i1] (frame-quantized)."""
    f0 = i0 // frame
    f1 = min(mask.size, max(f0 + 1, -(-i1 // frame)))
    if f0 >= mask.size:
        return 0.0
    return float(mask[f0:f1].sum()) * FRAME_S


def plan_windows(samples, mask, frame, window, hop, max_windows):
    """(i0, i1) sample windows with >= MIN_WINDOW_SPEECH_S voiced audio.
    Returns (wins, skipped, truncated) — skipped counts VAD-dropped windows."""
    win = max(1, int(window * SR))
    step = max(1, int(hop * SR))
    min_len = min(win, SR)  # drop a sub-second trailing window unless it's the only one
    wins = []
    skipped = 0
    truncated = False
    i = 0
    n = samples.size
    while i < n:
        j = min(n, i + win)
        if j - i < min_len and (wins or skipped):
            break
        if speech_between(mask, frame, i, j) >= MIN_WINDOW_SPEECH_S:
            if len(wins) >= max_windows:
                truncated = True
                break
            wins.append((i, j))
        else:
            skipped += 1
        i += step
    return wins, skipped, truncated


def merge_segments(times):
    out = []
    for s, e in sorted(times):
        if out and s - out[-1][1] <= MERGE_GAP:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


# ---- speaker embedding (lazy pyannote model) --------------------------------

_EMB = None


def load_embedder():
    global _EMB
    if _EMB is None:
        import torch
        from pyannote.audio import Inference, Model
        try:
            model = Model.from_pretrained(MODEL, **({"token": TOKEN} if TOKEN else {}))
        except Exception as e:  # noqa: BLE001
            m = str(e)
            if any(t in m for t in ("401", "403", "gated", "authorized", "Access")):
                fail("speaker-embedding model access denied — accept the license + set HF_TOKEN: https://huggingface.co/%s (%s)" % (MODEL, m[:200]),
                     state="needs_credentials")
            fail("could not load speaker model %s: %s" % (MODEL, m[:200]))
        inf = Inference(model, window="whole", device=torch.device(DEVICE))
        _EMB = {"inference": inf, "torch": torch}
    return _EMB


def l2norm(v):
    import numpy as np
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return (v / n).astype("float32")


def embed_windows(samples, wins):
    """One l2-normalized embedding per (i0, i1) window — (N, D) float32."""
    import numpy as np
    e = load_embedder()
    torch = e["torch"]
    inf = e["inference"]
    out = []
    for i0, i1 in wins:
        wav = torch.from_numpy(np.ascontiguousarray(samples[i0:i1]))[None, :]
        try:
            emb = inf({"waveform": wav, "sample_rate": SR})
        except Exception as ex:  # noqa: BLE001
            fail("speaker embedding failed at %.2fs: %s" % (i0 / float(SR), str(ex)[:200]))
        out.append(np.asarray(emb, dtype="float32").reshape(-1))
    if not out:
        return np.zeros((0, 1), dtype="float32")
    return l2norm(np.stack(out))


def map_score(cos):
    """Raw cosine -> 0-100 rank score via the fixed ANCHORS (clamped)."""
    if cos <= ANCHORS[0][0]:
        return ANCHORS[0][1]
    for (x0, y0), (x1, y1) in zip(ANCHORS, ANCHORS[1:]):
        if cos <= x1:
            return y0 + (y1 - y0) * ((cos - x0) / (x1 - x0))
    return ANCHORS[-1][1]


def median(values):
    vals = sorted(values)
    if not vals:
        return None
    mid = len(vals) // 2
    return vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2.0


def reference_vector(ref, window, min_speech=MIN_REF_SPEECH_S):
    """Pooled reference embedding: (vec (D,), speech_seconds, warnings). The
    reliability floor `min_speech` defaults to MIN_REF_SPEECH_S; an index search
    passes the index's persisted VoicePrintConfig.minSpeechSeconds instead."""
    if not Path(ref).exists():
        fail("reference sample not found: %s" % ref)
    if not has_audio(ref):
        fail("reference sample has no audio stream: %s" % ref)
    samples = decode_mono(ref)
    if samples is None or samples.size == 0:
        fail("could not decode audio from reference: %s" % ref)
    mask, frame = voiced_mask(samples)
    speech = float(mask.sum()) * FRAME_S
    if speech < 1.0:
        fail("reference has under 1s of speech (%.1fs) — provide a longer voice sample" % speech)
    warnings = []
    if speech < min_speech:
        warnings.append("reference has only %.1fs of speech (< %.1fs) — scores are unreliable" % (speech, min_speech))
    wins, _, _ = plan_windows(samples, mask, frame, window, window, MAX_MEMBER_WINDOWS)
    if not wins:
        wins = [(0, samples.size)]  # short/quiet sample: embed the whole thing
    vecs = embed_windows(samples, wins)
    return l2norm(vecs.mean(axis=0, keepdims=True))[0], round(speech, 2), warnings


# ---- index config + member cache (basic-clip layout) -------------------------

def index_config(args):
    """Persisted voice-print config merged over defaults, with the model guard:
    a different effective model must never score against cached embeddings."""
    cfg = {}
    try:
        cfg = json.loads((Path(args.index_dir) / "config.json").read_text())
    except Exception:
        pass
    persisted = cfg.get("model")
    if persisted and persisted != MODEL:
        fail("index %s was built with %s; unset OVERCAST_VOICE_MODEL or create a new voice-print index" % (args.index, persisted))
    return {
        "model": MODEL,
        "window": float(cfg.get("window") or WINDOW_S),
        "step": float(cfg.get("step") or STEP_S),
        "sampleRate": int(cfg.get("sampleRate") or SR),
        "minSpeechSeconds": float(cfg.get("minSpeechSeconds") or MIN_REF_SPEECH_S),
    }


def config_hash(cfg):
    payload = json.dumps({"model": cfg["model"], "window": cfg["window"], "step": cfg["step"], "sampleRate": cfg["sampleRate"]}, sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()


def cache_paths(index_dir, ref):
    key = hashlib.sha1(ref.encode()).hexdigest()
    emb_dir = Path(index_dir) / "emb"
    return emb_dir / ("%s.npy" % key), emb_dir / ("%s.json" % key)


def build_member(ref, cfg, index_dir, persist=True):
    """Load a member's cached window embeddings (fresh) or embed + cache them.
    Returns (vectors (N,D), ats, speech_seconds, truncated) or None when
    unreadable. persist=False keeps a rebuild in memory only — reads never write."""
    import numpy as np
    path = Path(ref)
    if not path.exists():
        return None
    npy, sidecar = cache_paths(index_dir, ref)
    chash = config_hash(cfg)
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
                return vecs, meta.get("ats", [None] * len(vecs)), float(meta.get("speech_seconds", 0.0)), bool(meta.get("truncated"))
        except Exception:
            pass
    if not has_audio(ref):
        return None
    samples = decode_mono(ref)
    if samples is None or samples.size == 0:
        return None
    mask, frame = voiced_mask(samples)
    speech = round(float(mask.sum()) * FRAME_S, 2)
    wins, _, truncated = plan_windows(samples, mask, frame, cfg["window"], cfg["window"], MAX_MEMBER_WINDOWS)
    if not wins:
        return None
    vecs = embed_windows(samples, wins)
    ats = [round(i0 / float(SR), 2) for i0, _ in wins]
    if persist:
        npy.parent.mkdir(parents=True, exist_ok=True)
        np.save(str(npy), vecs)
        sidecar.write_text(json.dumps({
            "ref": ref, "kind": "audio", "ats": ats,
            "speech_seconds": speech, "truncated": truncated,
            "config_hash": chash, "mtime": mtime,
            "model": cfg["model"], "window": cfg["window"],
        }))
    return vecs, ats, speech, truncated


def base_record(op, payload, ref, at=None):
    media = {"ref": ref}
    if at is not None:
        media["at"] = at
    payload["op"] = op
    payload["caveat"] = CAVEAT
    emit({
        "verb": "voice",
        "format": "json",
        "payload": payload,
        "media": media,
        "meta": {"provider": "local:voice-print", "model": MODEL},
        "state": "ready",
    })


# ---- ops --------------------------------------------------------------------

def op_add(args):
    ref = args.input
    if not Path(ref).exists():
        fail("input not found: %s" % ref)
    if not has_audio(ref):
        fail("input has no audio stream: %s" % ref)
    cfg = index_config(args)
    built = build_member(ref, cfg, args.index_dir)
    if not built:
        fail("could not embed voice windows (no readable speech): %s" % ref)
    vecs, _, speech, truncated = built
    payload = {
        "index": args.index, "file": ref, "model": MODEL,
        "vectors": int(vecs.shape[0]), "speech_seconds": speech,
        "window": cfg["window"],
        "summary": "enrolled %s into %s (%d voice window%s, %.1fs speech)"
                   % (Path(ref).name, args.index, vecs.shape[0], "" if vecs.shape[0] == 1 else "s", speech),
    }
    if truncated:
        payload["warnings"] = ["clip exceeds %d windows — only the first %.0f minutes were embedded" % (MAX_MEMBER_WINDOWS, MAX_MEMBER_WINDOWS * cfg["window"] / 60.0)]
    base_record("add", payload, ref)


def sliced(samples, start, end):
    """Slice decoded samples to [start, end] seconds; returns (slice, offset_s)."""
    i0 = int((start or 0.0) * SR)
    i1 = samples.size if end is None else min(samples.size, int(end * SR))
    i0 = max(0, min(i0, samples.size))
    if i1 <= i0:
        fail("--start/--end select no audio (clip is %.1fs)" % (samples.size / float(SR)))
    return samples[i0:i1], (start or 0.0)


def load_clip(args):
    inp = args.input
    if not Path(inp).exists():
        fail("input not found: %s" % inp)
    if not has_audio(inp):
        fail("input has no audio stream: %s" % inp)
    samples = decode_mono(inp)
    if samples is None or samples.size == 0:
        fail("could not decode audio from %s" % inp)
    try:
        start = parse_time(args.start)
        end = parse_time(args.end)
    except ValueError as e:
        fail(str(e))
    return sliced(samples, start, end)


def windowed_match(args, warnings):
    """Pairwise windowed mode: score every voiced query window vs the reference."""
    window = args.window or WINDOW_S
    ref_vec, ref_speech, ref_warn = reference_vector(args.match, window)
    warnings.extend(ref_warn)
    samples, offset = load_clip(args)
    mask, frame = voiced_mask(samples)
    wins, skipped, truncated = plan_windows(samples, mask, frame, window, STEP_S, MAX_QUERY_WINDOWS)
    if truncated:
        warnings.append("clip exceeds %d scan windows — only the first ~%.0f minutes were scored" % (MAX_QUERY_WINDOWS, MAX_QUERY_WINDOWS * STEP_S / 60.0))
    payload = {
        "mode": "windowed", "reference": args.match, "model": MODEL,
        "windows": len(wins), "skipped_windows": skipped,
        "reference_speech_seconds": ref_speech,
        "params": {"window": window, "step": STEP_S, "start": args.start, "end": args.end},
    }
    if not wins:
        payload.update({"matches": [], "count": 0, "margin": None,
                        "summary": "no voiced audio windows to score"})
        warnings.append("no windows with >= %.0fs of speech — nothing to match against" % MIN_WINDOW_SPEECH_S)
        payload["warnings"] = warnings
        base_record("match", payload, args.input)
        return
    vecs = embed_windows(samples, wins)
    import numpy as np
    cosines = np.dot(vecs, ref_vec)
    scores = [map_score(float(cv)) for cv in cosines]
    entries = []
    for (i0, i1), cv, s in zip(wins, cosines, scores):
        if s < args.min_similarity:
            continue
        entries.append({
            "file": args.input,
            "at": round(offset + i0 / float(SR), 2),
            "duration": round((i1 - i0) / float(SR), 2),
            "similarity": round(s, 2),
            "cosine": round(float(cv), 4),
        })
    entries.sort(key=lambda x: x["similarity"], reverse=True)
    entries = entries[: args.limit]
    margin = round(max(scores) - median(scores), 2) if len(scores) > 1 else None
    if entries and args.min_margin is not None and margin is not None and margin < args.min_margin:
        warnings.append("margin %.1f below --min-margin %.1f — match rejected (speaker may dominate the clip, or scores are flat)" % (margin, args.min_margin))
        entries = []
    if entries:
        summary = "best voice match %.1f at %.1fs (%d window%s >= floor)" % (
            entries[0]["similarity"], entries[0]["at"], len(entries), "" if len(entries) == 1 else "s")
    else:
        summary = "reference voice was not found in the clip"
    payload.update({"matches": entries, "count": len(entries), "margin": margin, "summary": summary})
    if warnings:
        payload["warnings"] = warnings
    base_record("match", payload, args.input, at=entries[0]["at"] if entries else None)


def diarized_match(args, warnings):
    """Diarize-then-match: compare the reference vs per-speaker centroids."""
    window = args.window or WINDOW_S
    ref_vec, ref_speech, ref_warn = reference_vector(args.match, window)
    warnings.extend(ref_warn)
    samples, offset = load_clip(args)

    import numpy as np
    from pyannote.audio import Pipeline
    e = load_embedder()  # embedder first: needed for the recompute fallback + model guard
    torch = e["torch"]
    try:
        pipe = Pipeline.from_pretrained(DIARIZE_MODEL, token=TOKEN)
    except Exception as ex:  # noqa: BLE001
        m = str(ex)
        if any(t in m for t in ("401", "403", "gated", "authorized", "Access")):
            fail("pyannote access denied — accept the license + set HF_TOKEN: %s (%s)" % (GATE_URL, m[:200]),
                 state="needs_credentials")
        fail("could not load %s: %s" % (DIARIZE_MODEL, m[:200]))
    try:
        kwargs = {"num_speakers": args.speakers} if args.speakers and args.speakers > 0 else {}
        wav = torch.from_numpy(np.ascontiguousarray(samples))[None, :]
        diar = pipe({"waveform": wav, "sample_rate": SR}, **kwargs)
    except Exception as ex:  # noqa: BLE001
        fail("diarization failed: %s" % str(ex)[:200])

    # pyannote 4.x returns a DiarizeOutput wrapper (.speaker_diarization is the
    # Annotation, .speaker_embeddings the per-speaker centroids row-aligned with
    # labels()); 3.x returned the Annotation directly. Support both.
    annotation = getattr(diar, "speaker_diarization", diar)
    if not hasattr(annotation, "itertracks"):
        fail("unexpected diarization output %s (no speaker_diarization/itertracks)" % type(diar).__name__)
    spk = {}
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        spk.setdefault(speaker, []).append((float(turn.start), float(turn.end)))
    if not spk:
        fail("no speech/speakers detected")

    labels = list(annotation.labels())
    embs = getattr(diar, "speaker_embeddings", None)
    centroids = {}
    embedding_source = "pipeline"
    if embs is not None and getattr(embs, "shape", (0,))[0] == len(labels):
        norm = l2norm(np.asarray(embs, dtype="float32"))
        centroids = {label: norm[i] for i, label in enumerate(labels)}
    else:
        # 3.x / API drift: recompute each speaker's centroid with our own model
        # over up to CENTROID_MAX_S of their concatenated turns (same space as
        # the reference by construction).
        embedding_source = "recomputed"
        for label, turns in spk.items():
            parts = []
            budget = int(CENTROID_MAX_S * SR)
            for s, t in merge_segments(turns):
                seg = samples[int(s * SR): int(t * SR)]
                if seg.size == 0:
                    continue
                parts.append(seg[:budget])
                budget -= parts[-1].size
                if budget <= 0:
                    break
            if not parts:
                continue
            concat = np.concatenate(parts)
            centroids[label] = embed_windows(concat, [(0, concat.size)])[0]

    ranked = []
    skipped_speakers = []
    for label in sorted(spk):
        merged = merge_segments(spk[label])
        speech = round(sum(t - s for s, t in merged), 2)
        if speech < MIN_REF_SPEECH_S:
            skipped_speakers.append({"speaker": label, "speech_seconds": speech, "reason": "insufficient_speech"})
            continue
        if label not in centroids:
            skipped_speakers.append({"speaker": label, "speech_seconds": speech, "reason": "no_embedding"})
            continue
        cv = float(np.dot(centroids[label], ref_vec))
        longest = max(merged, key=lambda seg: seg[1] - seg[0])
        ranked.append({
            "speaker": label,
            "similarity": round(map_score(cv), 2),
            "cosine": round(cv, 4),
            "speech_seconds": speech,
            "at": [round(offset + longest[0], 2), round(offset + longest[1], 2)],
            "turns": [{"at": [round(offset + s, 2), round(offset + t, 2)]} for s, t in merged],
        })
    ranked.sort(key=lambda x: x["similarity"], reverse=True)
    margin = round(ranked[0]["similarity"] - ranked[1]["similarity"], 2) if len(ranked) > 1 else None

    matches = [r for r in ranked if r["similarity"] >= args.min_similarity][: args.limit]
    if matches and args.min_margin is not None:
        if margin is None:
            warnings.append("single scored speaker — no competitor, margin gate not applied")
        elif margin < args.min_margin:
            warnings.append("margin %.1f below --min-margin %.1f — match rejected (another speaker scores nearly as high)" % (margin, args.min_margin))
            matches = []
    if matches:
        summary = "%s matches the reference at %.1f%s" % (
            matches[0]["speaker"], matches[0]["similarity"],
            " (margin %.1f)" % margin if margin is not None else "")
    else:
        summary = "no diarized speaker matched the reference voice"
    payload = {
        "mode": "diarized", "reference": args.match, "model": MODEL,
        "diarization_model": DIARIZE_MODEL, "embedding_source": embedding_source,
        "matches": matches, "count": len(matches), "margin": margin,
        "speakers": [{k: r[k] for k in ("speaker", "similarity", "cosine", "speech_seconds")} for r in ranked],
        "reference_speech_seconds": ref_speech,
        "params": {"window": window, "speakers": args.speakers, "start": args.start, "end": args.end},
        "summary": summary,
    }
    if skipped_speakers:
        payload["skipped_speakers"] = skipped_speakers
    if warnings:
        payload["warnings"] = warnings
    base_record("match", payload, args.input, at=matches[0]["at"][0] if matches else None)


def op_match(args):
    if not args.match:
        fail("voice match needs --match <reference voice sample>")
    warnings = []
    if args.diarize and not TOKEN:
        warnings.append("diarization skipped: HF_TOKEN + accepted license required (%s); ran windowed match" % GATE_URL)
    if args.diarize and TOKEN:
        diarized_match(args, warnings)
    else:
        windowed_match(args, warnings)


def op_search(args):
    members = members_full(args.index_dir, args.index)
    if not members:
        fail("local voice-print index has no members — enroll some with `voice add <clip> --index %s`" % args.index)
    cfg = index_config(args)
    # honor the index's persisted speech floor (VoicePrintConfig.minSpeechSeconds)
    ref_vec, ref_speech, warnings = reference_vector(args.input, cfg["window"], cfg["minSpeechSeconds"])
    import numpy as np
    results = []
    unreadable = 0
    for mem in members:
        built = build_member(mem["ref"], cfg, args.index_dir, persist=False)
        if not built:
            unreadable += 1
            continue
        vecs, ats, _, _ = built
        cosines = np.dot(vecs, ref_vec)
        scores = [map_score(float(cv)) for cv in cosines]
        j = int(np.argmax(cosines))
        best = scores[j]
        mem_margin = round(best - median(scores), 2) if len(scores) > 1 else None
        if best < args.min_similarity:
            continue
        if args.min_margin is not None and mem_margin is not None and mem_margin < args.min_margin:
            continue
        item = {
            "ref": mem["ref"],
            "similarity": round(best, 2),
            "cosine": round(float(cosines[j]), 4),
            "duration": cfg["window"],
            "windows_over_floor": int(sum(1 for s in scores if s >= args.min_similarity)),
            "margin": mem_margin,
        }
        if mem.get("recordId"):
            item["recordId"] = mem["recordId"]
        at = ats[j] if j < len(ats) else None
        if at is not None:
            item["at"] = at
        results.append(item)
    results.sort(key=lambda x: x["similarity"], reverse=True)
    results = results[args.offset: args.offset + args.limit]
    summary = ("no voice matches across the local index" if not results
               else "%d member%s matched the reference voice" % (len(results), "" if len(results) == 1 else "s"))
    payload = {
        "index": args.index, "reference": args.input, "model": MODEL,
        "matches": results, "count": len(results),
        "reference_speech_seconds": ref_speech,
        "summary": summary,
    }
    if unreadable:
        warnings.append("%d member%s unreadable (file missing or no speech) — not scored" % (unreadable, "" if unreadable == 1 else "s"))
    if warnings:
        payload["warnings"] = warnings
    base_record("search", payload, args.input)


def main():
    args = parse()
    _CTX["inp"] = args.input
    _CTX["op"] = args.op
    for label, value in (("input", args.input), ("--match reference", args.match)):
        if value and (value.startswith("http://") or value.startswith("https://")):
            fail("local voice match only supports local files; capture remote media first (%s)" % label)
    try:
        import numpy  # noqa: F401
        import torch  # noqa: F401
        import pyannote.audio  # noqa: F401
    except Exception as e:  # noqa: BLE001
        fail("voice deps missing: %s (run scripts/visual-db-uv.sh --voice)" % e)
    if args.min_similarity < 0 or args.min_similarity > 100:
        fail("--min-similarity must be between 0 and 100")
    if args.min_margin is not None and args.min_margin < 0:
        fail("--min-margin must be non-negative")
    if args.limit <= 0:
        fail("--limit must be positive")
    if args.offset < 0:
        fail("--offset must be non-negative")
    if args.window is not None and args.window <= 0:
        fail("--window must be a positive number of seconds")
    if args.op in ("add", "search") and (not args.index or not args.index_dir):
        fail("voice %s needs --index/--index-dir" % args.op)
    if args.op == "match" and args.index:
        fail("internal: voice match is pairwise — index search is op=search")
    if args.op == "add":
        op_add(args)
    elif args.op == "search":
        op_search(args)
    else:
        op_match(args)


if __name__ == "__main__":
    main()
