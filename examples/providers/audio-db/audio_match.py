#!/usr/bin/env python3
# Local Shazam-style audio fingerprint DB (`audio-fp`) provider for overcast's
# `audio` verb. Exact-recording matching via the Wang 2003 constellation
# algorithm: STFT -> spectral peak picking -> anchor/target-zone pair hashing ->
# offset-histogram voting. Fingerprints are precomputed + cached on `add` under
# <index-dir>/fp/<sha1(ref)>.npz (+ .json sidecar); `match` fingerprints the query
# and votes it against each member (indexed) or a single reference (pairwise).
#
# Reimplemented from the Wang 2003 paper and MIT references (dejavu / abracadabra
# / audfprint) — no code copied from unlicensed sources. Robust to
# transcode/noise/clipping; NOT robust to pitch/speed change (classic Wang).
#
# Same wire contract as the visual-db scripts: read members from
# .overcast/indexes.json, emit exactly ONE JSON record on stdout, try-import deps
# and emit a state:"error" record on failure, ffmpeg/ffprobe via env overrides.
import argparse
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

MODEL = "wang2003"

# Fingerprint params — defaults MUST match src/providers/local/audio.ts
# defaultAudioFpConfig(); the index's config.json overrides them per-index.
DEFAULT_CONFIG = {
    "sampleRate": 11025,
    "nFft": 2048,
    "hop": 512,
    "peakNeighborhood": 15,
    "peakFloorDb": 20,
    "fanOut": 15,
    "minDt": 1,
    "maxDt": 64,
}


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, inp="", op="match", state="error"):
    emit({
        "verb": "audio",
        "format": "json",
        "payload": {"op": op, "matches": [], "count": 0},
        "media": {"ref": inp} if inp else None,
        "error": msg,
        "state": state,
    })
    sys.exit(0)


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--op", choices=["add", "match"], required=True)
    p.add_argument("--index")
    p.add_argument("--index-dir", dest="index_dir")
    p.add_argument("--against")  # pairwise: a second clip (no index)
    p.add_argument("--min-votes", dest="min_votes", type=int, default=6)
    p.add_argument("--min-ratio", dest="min_ratio", type=float, default=0.0)
    p.add_argument("--min-margin", dest="min_margin", type=float, default=1.0)
    p.add_argument("--draw", action="store_true", help="render an SVG alignment visualization per match")
    p.add_argument("input")
    return p.parse_args()


def read_config(index_dir):
    cfg = dict(DEFAULT_CONFIG)
    if index_dir:
        try:
            parsed = json.loads((Path(index_dir) / "config.json").read_text())
            for k in DEFAULT_CONFIG:
                if parsed.get(k) is not None:
                    cfg[k] = parsed[k]
        except Exception:
            pass
    return cfg


def config_hash(cfg):
    payload = json.dumps({**cfg, "model": MODEL}, sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()


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
        # can't probe → let the decode attempt surface the real error
        return True


def decode_mono(path, sr):
    """Decode a file's first audio stream to a mono float32 numpy array at `sr`.
    Streams f32le over a pipe (no temp files). Returns None on failure."""
    import numpy as np
    ffmpeg = os.environ.get("OVERCAST_FFMPEG") or "ffmpeg"
    cmd = [ffmpeg, "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(int(sr)), "-f", "f32le", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=600)
    except Exception:
        return None
    if r.returncode != 0 or not r.stdout:
        return None
    return np.frombuffer(r.stdout, dtype=np.float32)


# ---- fingerprint (Wang 2003) -----------------------------------------------

def fingerprint(samples, cfg):
    """Return (hashes uint32[N], times uint32[N], n_frames). Constellation-map
    peak pairs hashed into 32-bit ints, each tagged with its anchor time frame."""
    import numpy as np
    from scipy.signal import stft
    from scipy.ndimage import maximum_filter

    sr = cfg["sampleRate"]
    nfft = cfg["nFft"]
    hop = cfg["hop"]
    if samples.size < nfft:
        return np.zeros(0, dtype=np.uint32), np.zeros(0, dtype=np.uint32), 0

    _, _, Z = stft(samples, fs=sr, nperseg=nfft, noverlap=nfft - hop, boundary=None, padded=False)
    S = 20.0 * np.log10(np.abs(Z) + 1e-10)  # (freq, time) dB magnitude
    n_frames = S.shape[1]

    neigh = cfg["peakNeighborhood"]
    local_max = maximum_filter(S, size=(neigh, neigh), mode="constant") == S
    thresh = np.median(S) + cfg["peakFloorDb"]
    peak_mask = local_max & (S > thresh)
    freqs, frames = np.where(peak_mask)
    if freqs.size == 0:
        return np.zeros(0, dtype=np.uint32), np.zeros(0, dtype=np.uint32), n_frames

    # sort peaks by time frame for target-zone scanning
    order = np.argsort(frames, kind="stable")
    tf = frames[order]
    ff = freqs[order]

    fan_out = cfg["fanOut"]
    min_dt = cfg["minDt"]
    max_dt = cfg["maxDt"]
    hashes = []
    times = []
    n = tf.size
    for i in range(n):
        t1 = int(tf[i])
        f1 = int(ff[i]) & 0x3FF  # 10 bits
        paired = 0
        j = i + 1
        while j < n and paired < fan_out:
            dt = int(tf[j]) - t1
            if dt > max_dt:
                break
            if dt >= min_dt:
                f2 = int(ff[j]) & 0x3FF  # 10 bits
                h = ((f1 & 0x3FF) << 22) | ((f2 & 0x3FF) << 12) | (dt & 0xFFF)
                hashes.append(h)
                times.append(t1)
                paired += 1
            j += 1
    return (
        np.asarray(hashes, dtype=np.uint32),
        np.asarray(times, dtype=np.uint32),
        n_frames,
    )


def fingerprint_file(path, cfg, op):
    """Decode + fingerprint a file. fail()s with a clear message on any problem."""
    import numpy as np  # noqa: F401
    if not has_audio(path):
        fail("input has no audio stream: %s" % path, path, op)
    samples = decode_mono(path, cfg["sampleRate"])
    if samples is None or samples.size == 0:
        fail("could not decode audio from: %s" % path, path, op)
    hashes, times, n_frames = fingerprint(samples, cfg)
    duration = round(len(samples) / float(cfg["sampleRate"]), 2)
    return hashes, times, n_frames, duration


# ---- fingerprint cache -----------------------------------------------------

def cache_paths(index_dir, ref):
    key = hashlib.sha1(ref.encode()).hexdigest()
    fp_dir = Path(index_dir) / "fp"
    return fp_dir / ("%s.npz" % key), fp_dir / ("%s.json" % key)


def build_member(ref, cfg, index_dir, op, persist=True):
    """Load a member's cached fingerprint (fresh) or compute + cache it. Returns
    (hashes, times, duration) or None when the ref is unreadable. persist=False
    (query-time) keeps a recomputed fingerprint in memory only — reads never
    write. Freshness keys on config_hash + file mtime (mirrors clip_match.py)."""
    import numpy as np
    path = Path(ref)
    if not path.exists():
        return None
    npz, sidecar = cache_paths(index_dir, ref)
    chash = config_hash(cfg)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    if npz.exists() and sidecar.exists():
        try:
            meta = json.loads(sidecar.read_text())
            fresh = meta.get("config_hash") == chash and abs(float(meta.get("mtime", -1)) - mtime) < 1e-6
            if fresh:
                data = np.load(str(npz))
                return data["hashes"], data["times"], float(meta.get("duration_seconds", 0.0))
        except Exception:
            pass
    if not has_audio(ref):
        return None
    samples = decode_mono(ref, cfg["sampleRate"])
    if samples is None or samples.size == 0:
        return None
    hashes, times, _ = fingerprint(samples, cfg)
    duration = round(len(samples) / float(cfg["sampleRate"]), 2)
    if persist:
        npz.parent.mkdir(parents=True, exist_ok=True)
        np.savez(str(npz), hashes=hashes, times=times)
        sidecar.write_text(json.dumps({
            "ref": ref, "config_hash": chash, "mtime": mtime,
            "n_hashes": int(hashes.size), "duration_seconds": duration, "model": MODEL,
        }))
    return hashes, times, duration


# ---- offset-histogram scoring ----------------------------------------------

def score_member(q_hashes, q_times, m_hashes, m_times, cfg, min_votes, min_ratio, min_margin=1.0):
    """Vote query hashes against a member; return a match dict (offset, votes,
    ratio, margin, span) or None. Merges +/-1 delta bins so frame quantization
    doesn't split a true alignment across the confirm threshold.

    A true exact match aligns almost all of its hashes into ONE offset bin, so it
    has an overwhelming margin over the second-best bin (real matches score
    500-1600x). A pitch/speed-changed copy drifts out of alignment and leaves only
    a small scattered cluster (margin ~1.2-1.7, low ratio, short span) — `min_margin`
    lets exact-copy detection reject those partial alignments the raw vote floor
    would otherwise confirm."""
    if q_hashes.size == 0 or m_hashes.size == 0:
        return None
    mdict = defaultdict(list)
    for h, t in zip(m_hashes.tolist(), m_times.tolist()):
        mdict[h].append(t)
    deltas = []
    tqs = []
    for h, t in zip(q_hashes.tolist(), q_times.tolist()):
        hits = mdict.get(h)
        if not hits:
            continue
        for tdb in hits:
            deltas.append(tdb - t)
            tqs.append(t)
    if not deltas:
        return None

    counts = Counter(deltas)
    centers = sorted(counts.keys())

    def window(c):
        return counts.get(c - 1, 0) + counts.get(c, 0) + counts.get(c + 1, 0)

    best_c = max(centers, key=window)
    aligned_votes = window(best_c)
    second = 0
    for c in centers:
        if abs(c - best_c) >= 3:
            w = window(c)
            if w > second:
                second = w

    hop = cfg["hop"]
    sr = cfg["sampleRate"]
    aligned_tqs = [tq for d, tq in zip(deltas, tqs) if abs(d - best_c) <= 1]
    span_frames = (max(aligned_tqs) - min(aligned_tqs)) if aligned_tqs else 0
    total_query_hashes = int(q_hashes.size)
    match_ratio = aligned_votes / max(1, total_query_hashes)
    margin = aligned_votes / max(1, second)
    return {
        "offset_seconds": round(best_c * hop / float(sr), 2),
        "aligned_votes": int(aligned_votes),
        "total_query_hashes": total_query_hashes,
        "match_ratio": round(match_ratio, 4),
        "margin": round(margin, 2),
        "span_seconds": round(span_frames * hop / float(sr), 2),
        "_confirmed": aligned_votes >= min_votes and match_ratio >= min_ratio and margin >= min_margin,
        # plotting data for --draw (stripped from the public payload by _public):
        # every matching (query-time, member-time) hash pair + the winning offset.
        "_tqs": tqs, "_deltas": deltas, "_best_c": best_c,
    }


# ---- match visualization (dependency-free SVG) -----------------------------
# The Shazam analog of image_match.py's cv2.drawMatches: a scatter of every
# matching (query-time, member-time) hash pair — a true match is a tight bright
# diagonal at the offset, a spurious/speed-drift match is scattered — plus the
# offset-vote histogram (one sharp spike for a real match). Hand-rolled SVG so it
# needs no matplotlib; the .svg file drops into the case media store and the brief
# HTML embeds it exactly like the image-match overlays.

def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_match_svg(query_name, member_name, s, cfg, out_dir):
    tqs = s.get("_tqs") or []
    deltas = s.get("_deltas") or []
    best_c = s.get("_best_c", 0)
    if not tqs:
        return None
    hop = cfg["hop"]
    sr = cfg["sampleRate"]
    to_s = hop / float(sr)
    # (query_time, member_time) pairs in seconds; flag the aligned ones (the votes)
    pts = [(tq * to_s, (tq + d) * to_s, abs(d - best_c) <= 1) for tq, d in zip(tqs, deltas)]
    # cap plotted dots so the SVG stays small on dense audio (keep all aligned)
    aligned = [p for p in pts if p[2]]
    noise = [p for p in pts if not p[2]]
    if len(noise) > 3000:
        step = len(noise) / 3000.0
        noise = [noise[int(i * step)] for i in range(3000)]
    if len(aligned) > 3000:
        step = len(aligned) / 3000.0
        aligned = [aligned[int(i * step)] for i in range(3000)]

    W, H = 720, 460
    pad = 44
    sc_h = 300  # scatter panel height
    qmax = max((p[0] for p in pts), default=1.0) or 1.0
    mmax = max((p[1] for p in pts), default=1.0) or 1.0

    def sx(q):
        return pad + (q / qmax) * (W - 2 * pad)

    def sy(m):
        return pad + (1 - m / mmax) * (sc_h - pad)

    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" font-family="monospace">' % (W, H, W, H)]
    parts.append('<rect width="%d" height="%d" fill="#0a0f0d"/>' % (W, H))
    off = best_c * to_s
    conf = "CONFIRMED" if s.get("_confirmed") else "rejected"
    color = "#39ff14" if s.get("_confirmed") else "#ff5f56"
    parts.append('<text x="%d" y="20" fill="%s" font-size="13">%s  %s -> %s</text>' % (pad, color, conf, _esc(query_name), _esc(member_name)))
    parts.append('<text x="%d" y="36" fill="#8fa" font-size="11">offset=%.2fs  votes=%d  ratio=%.3f  margin=%.1fx  span=%.1fs</text>'
                 % (pad, off, s["aligned_votes"], s["match_ratio"], s["margin"], s["span_seconds"]))
    # scatter axes
    parts.append('<rect x="%d" y="%d" width="%d" height="%d" fill="none" stroke="#1e3b30"/>' % (pad, pad, W - 2 * pad, sc_h - pad))
    parts.append('<text x="%d" y="%d" fill="#5a7" font-size="10">member time (s) ^   |   query time (s) ></text>' % (pad + 4, sc_h + 2))
    # the offset diagonal member_t = query_t + offset (the true-match line)
    x0, x1 = 0.0, qmax
    parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#2f6" stroke-dasharray="4 4" opacity="0.5"/>'
                 % (sx(x0), sy(x0 + off), sx(x1), sy(min(mmax, x1 + off))))
    for q, m, _a in noise:
        parts.append('<circle cx="%.1f" cy="%.1f" r="1" fill="#3a5" opacity="0.35"/>' % (sx(q), sy(m)))
    for q, m, _a in aligned:
        parts.append('<circle cx="%.1f" cy="%.1f" r="1.6" fill="%s" opacity="0.9"/>' % (sx(q), sy(m), color))

    # offset histogram (bottom strip)
    hist = Counter(int(round(d * to_s)) for d in deltas)  # 1-second offset bins
    hy0, hy1 = sc_h + 24, H - 16
    hmax = max(hist.values()) if hist else 1
    keys = sorted(hist.keys())
    kmin, kmax = (keys[0], keys[-1]) if keys else (0, 1)
    span = max(1, kmax - kmin)
    bw = max(1.0, (W - 2 * pad) / (span + 1))
    parts.append('<text x="%d" y="%d" fill="#5a7" font-size="10">offset-vote histogram (spike = the match)</text>' % (pad, hy0 - 4))
    for k, v in hist.items():
        bx = pad + ((k - kmin) / span) * (W - 2 * pad - bw)
        bh = (v / hmax) * (hy1 - hy0)
        bc = color if abs(k - int(round(off))) <= 1 else "#2a6"
        parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s"/>' % (bx, hy1 - bh, bw, bh, bc))
    parts.append('</svg>')

    out_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(("%s|%s" % (query_name, member_name)).encode()).hexdigest()[:16]
    path = out_dir / ("match_%s.svg" % key)
    path.write_text("\n".join(parts))
    return str(path.resolve())


def draw_dir(args):
    base = os.environ.get("OVERCAST_MEDIA_DIR") or args.index_dir or "."
    return Path(base) / "audio-matches"


# ---- ops -------------------------------------------------------------------

def op_add(args):
    ref = args.input
    if not Path(ref).exists():
        fail("input not found: %s" % ref, ref, "add")
    if not args.index or not args.index_dir:
        fail("audio add requires --index/--index-dir", ref, "add")
    cfg = read_config(args.index_dir)
    hashes, times, duration = _member_or_fail(ref, cfg, args.index_dir)
    payload = {
        "op": "add", "index": args.index, "file": ref,
        "hashes": int(hashes.size), "duration_seconds": duration,
        "summary": "fingerprinted %s into %s (%d hashes, %.1fs)" % (Path(ref).name, args.index, int(hashes.size), duration),
    }
    # a member with no (or barely any) constellation hashes is effectively
    # silent/tonal and will never match — surface it rather than registering a
    # dead member the user thinks is searchable.
    if hashes.size == 0:
        payload["warning"] = "no fingerprint hashes — the audio is silent or too quiet/tonal to fingerprint; this member cannot be matched"
        payload["summary"] = "fingerprinted %s into %s but produced 0 hashes (silent/unmatchable audio)" % (Path(ref).name, args.index)
    emit({
        "verb": "audio",
        "format": "json",
        "payload": payload,
        "media": {"ref": ref},
        "meta": {"provider": "local:audio-fp", "model": MODEL},
        "state": "ready",
    })


def _member_or_fail(ref, cfg, index_dir):
    built = build_member(ref, cfg, index_dir, "add")
    if not built:
        fail("could not fingerprint audio (no readable audio): %s" % ref, ref, "add")
    return built


def op_match(args):
    op = "match"
    if args.min_votes < 1:
        fail("--min-votes must be at least 1", args.input, op)
    if args.min_ratio < 0 or args.min_ratio > 1:
        fail("--min-ratio must be between 0 and 1", args.input, op)
    if args.min_margin < 1:
        fail("--min-margin must be at least 1", args.input, op)

    if args.against:
        # ---- pairwise: fingerprint both, no index ----
        cfg = read_config(None)
        if not Path(args.input).exists():
            fail("input not found: %s" % args.input, args.input, op)
        if not Path(args.against).exists():
            fail("reference not found: %s" % args.against, args.input, op)
        q_hashes, q_times, _, q_dur = fingerprint_file(args.input, cfg, op)
        m_hashes, m_times, _, m_dur = fingerprint_file(args.against, cfg, op)
        matches = []
        best_rejected = None
        s = score_member(q_hashes, q_times, m_hashes, m_times, cfg, args.min_votes, args.min_ratio, args.min_margin)
        if s:
            item = {"ref": args.against, "duration_seconds": m_dur, **_public(s)}
            if args.draw:
                p = render_match_svg(Path(args.input).name, Path(args.against).name, s, cfg, draw_dir(args))
                if p:
                    item["match_draw_path"] = p
            if s["_confirmed"]:
                matches.append(item)
            else:
                best_rejected = item
        _emit_match(args, op, matches, q_hashes.size, q_dur, cfg, reference=args.against, best_rejected=best_rejected)
        return

    # ---- indexed ----
    if not args.index or not args.index_dir:
        fail("audio match requires --index/--index-dir or --against <clip>", args.input, op)
    cfg = read_config(args.index_dir)
    members = members_full(args.index_dir, args.index)
    if not members:
        fail("local audio-fp index has no members — add some with `audio add ... --index %s`" % args.index, args.input, op)
    q_hashes, q_times, _, q_dur = fingerprint_file(args.input, cfg, op)

    scored = []          # (item, s) for confirmed matches
    best = None          # (item, s) for the single best rejected candidate
    for mem in members:
        built = build_member(mem["ref"], cfg, args.index_dir, op, persist=False)
        if not built:
            continue
        m_hashes, m_times, m_dur = built
        s = score_member(q_hashes, q_times, m_hashes, m_times, cfg, args.min_votes, args.min_ratio, args.min_margin)
        if not s:
            continue
        item = {"ref": mem["ref"], "duration_seconds": m_dur, **_public(s)}
        if mem.get("recordId"):
            item["recordId"] = mem["recordId"]
        if s["_confirmed"]:
            scored.append((item, s))
        elif best is None or item["aligned_votes"] > best[0]["aligned_votes"]:
            best = (item, s)
    scored.sort(key=lambda pair: pair[0]["aligned_votes"], reverse=True)
    # render only the confirmed matches + the single best rejected (bounds the
    # SVG count regardless of how many members share a few coincidental hashes)
    if args.draw:
        for it, sc in scored + ([best] if best else []):
            p = render_match_svg(Path(args.input).name, Path(it["ref"]).name, sc, cfg, draw_dir(args))
            if p:
                it["match_draw_path"] = p
    matches = [it for it, _ in scored]
    best_rejected = best[0] if best else None
    _emit_match(args, op, matches, q_hashes.size, q_dur, cfg, index=args.index, best_rejected=best_rejected)


def _public(s):
    return {k: v for k, v in s.items() if not k.startswith("_")}


def _emit_match(args, op, matches, n_hashes, q_dur, cfg, index=None, reference=None, best_rejected=None):
    if matches:
        top = matches[0]
        summary = "query matches %s at %s (%d aligned votes)" % (
            Path(top["ref"]).name, _fmt_offset(top["offset_seconds"]), top["aligned_votes"],
        )
    else:
        summary = "no confident audio match"
    payload = {
        "op": op,
        "summary": summary,
        "matches": matches,
        "count": len(matches),
        "query": {"duration_seconds": q_dur, "n_hashes": int(n_hashes)},
        "fingerprint": {"sample_rate": cfg["sampleRate"], "n_fft": cfg["nFft"], "hop": cfg["hop"], "fan_out": cfg["fanOut"]},
    }
    if index is not None:
        payload["index"] = index
    if reference is not None:
        payload["reference"] = reference
    if not matches and best_rejected is not None:
        payload["best_rejected"] = best_rejected
    emit({
        "verb": "audio",
        "format": "json",
        "payload": payload,
        # media anchors the QUERY — a matched member's offset lives in matches[].
        "media": {"ref": args.input},
        "meta": {"provider": "local:audio-fp", "model": MODEL},
        "state": "ready",
    })


def _fmt_offset(sec):
    sec = max(0.0, float(sec))
    m = int(sec // 60)
    s = sec - m * 60
    return "%d:%05.2f" % (m, s) if m else "%.2fs" % s


def main():
    args = parse()
    inp = args.input
    if inp.startswith("http://") or inp.startswith("https://"):
        fail("local audio matcher only supports local files; capture remote media first", inp, args.op)
    try:
        import numpy  # noqa: F401
        import scipy.signal  # noqa: F401
        import scipy.ndimage  # noqa: F401
    except Exception as e:
        fail("audio-fp deps missing: %s (run scripts/visual-db-uv.sh --audio)" % e, inp, args.op)
    if args.op == "add":
        op_add(args)
    else:
        op_match(args)


if __name__ == "__main__":
    main()
