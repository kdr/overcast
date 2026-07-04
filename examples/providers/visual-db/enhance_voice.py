#!/usr/bin/env python3
# overcast `enhance --ops separate` (LOCAL): speaker separation by DIARIZATION.
# pyannote assigns speech to speakers; we then render one TIMELINE-PRESERVING track
# per speaker with ffmpeg (other speakers muted, this speaker's segments at original
# volume) so segment/media.at anchors stay valid. Overlapping-speech regions are
# flagged (diarization can't un-mix true overlap — see the fal sam-audio provider
# for text-prompted true separation). Emits ONE record whose payload.outputs[] is
# fanned out into a record per track by the enhance verb.
#
# Bind via local-models, then:  overcast enhance clip.mp4 --ops separate [--speakers N] [--summarize]
#
# Needs:  pyannote.audio>=4.0, torch  (scripts/visual-db-uv.sh --voice)
# Gated:  HF_TOKEN + accepted license for pyannote/speaker-diarization-community-1
# Env:    OVERCAST_DIARIZE_MODEL, OVERCAST_FFMPEG/FFPROBE, OVERCAST_MEDIA_DIR, HF_TOKEN
#
# Exec contract:  describe | init | [run] --input <ref> [--speakers N] [--ops separate]
import json
import os
import subprocess
import sys

MODEL = os.environ.get("OVERCAST_DIARIZE_MODEL", "pyannote/speaker-diarization-community-1")
FFMPEG = os.environ.get("OVERCAST_FFMPEG") or "ffmpeg"
OUTDIR = os.environ.get("OVERCAST_MEDIA_DIR", ".")
TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
GATE_URL = "https://huggingface.co/pyannote/speaker-diarization-community-1"
MERGE_GAP = 0.3  # merge a speaker's segments closer than this many seconds


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, state="error"):
    emit({"verb": "enhance", "format": "json", "payload": {"op": "separate"},
          "error": msg, "state": state})
    sys.exit(0)


def describe():
    emit({"verb": "enhance", "kind": "media.enhanced", "ops": ["separate"], "model": MODEL,
          "accepts": ["audio", "video"], "needs": ["pyannote.audio", "torch", "HF_TOKEN"]})
    sys.exit(0)


def init():
    try:
        import pyannote.audio  # noqa: F401
        import torch  # noqa: F401
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("voice separation needs: scripts/visual-db-uv.sh --voice (pyannote.audio torch) — %s\n" % e)
        sys.exit(13)
    if not TOKEN:
        sys.stderr.write("voice separation needs HF_TOKEN + accepted license: %s\n" % GATE_URL)
        sys.exit(13)
    sys.exit(0)


def parse_args(argv):
    inp, speakers = "", None

    def val(j):
        return argv[j + 1] if j + 1 < len(argv) else ""

    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--input":
            inp = val(i); i += 2
        elif a == "--speakers":
            try:
                speakers = int(val(i))
            except (ValueError, TypeError):
                speakers = None
            i += 2
        elif a in ("--ops", "--prompt"):
            i += 2  # accepted but unused here (consume the value)
        elif a in ("--masks-only", "run"):
            i += 1
        elif not a.startswith("-"):
            inp = a; i += 1
        else:
            i += 1
    return inp, speakers


def to_mono_wav(path):
    """Extract audio to mono 16k pcm wav — the diarization + split source."""
    base = os.path.splitext(os.path.basename(path))[0]
    outdir = os.path.join(OUTDIR, "separate")
    os.makedirs(outdir, exist_ok=True)
    wav = os.path.join(outdir, base + "_src.wav")
    r = subprocess.run([FFMPEG, "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
                        "-acodec", "pcm_s16le", wav], capture_output=True, timeout=600)
    if r.returncode != 0 or not os.path.exists(wav):
        return None
    return wav


def merge_segments(times):
    out = []
    for s, e in sorted(times):
        if out and s - out[-1][1] <= MERGE_GAP:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def render_muted_track(src_wav, segs, out):
    """Write a full-length copy of src_wav with samples OUTSIDE `segs` zeroed —
    timeline-preserving, this speaker audible only in their turns. Done on the raw
    samples (numpy), NOT an ffmpeg `enable` expression: the expression grows with
    the segment count and both the argv and ffmpeg's own evaluator overflow on long
    clips with many diarization turns. Sample-zeroing is O(samples), unbounded."""
    import wave
    import numpy as np
    with wave.open(src_wav, "rb") as w:
        sr, ch, sw, nframes = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(nframes)
    if sw != 2:
        return False  # to_mono_wav writes pcm_s16le; anything else is unexpected
    data = np.frombuffer(raw, dtype=np.int16).copy()
    total = data.shape[0] // ch if ch else data.shape[0]
    keep = np.zeros(total, dtype=bool)
    for s, e in segs:
        i0 = max(0, int(s * sr)); i1 = min(total, int(round(e * sr)))
        if i1 > i0:
            keep[i0:i1] = True
    if ch > 1:
        data = data.reshape(-1, ch)
        data[~keep, :] = 0
    else:
        data[~keep] = 0
    with wave.open(out, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(sw); w.setframerate(sr)
        w.writeframes(data.tobytes())
    return os.path.exists(out) and os.path.getsize(out) > 0


def compute_overlaps(spk):
    """Pairwise speaker-overlap intervals (evidence flags for true cross-talk)."""
    names = sorted(spk)
    merged = {n: merge_segments(spk[n]) for n in names}
    overlaps = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            for s1, e1 in merged[names[i]]:
                for s2, e2 in merged[names[j]]:
                    s, e = max(s1, s2), min(e1, e2)
                    if e - s > 0.05:
                        overlaps.append({"at": [round(s, 2), round(e, 2)],
                                         "speakers": [names[i], names[j]]})
    overlaps.sort(key=lambda o: o["at"][0])
    return overlaps


def run():
    argv = sys.argv[1:]
    inp, speakers = parse_args(argv)
    if not inp or not os.path.exists(inp):
        fail("input not found: %r" % inp)
    if not TOKEN:
        fail("voice separation needs HF_TOKEN + accepted license: %s" % GATE_URL, state="needs_credentials")

    try:
        from pyannote.audio import Pipeline
    except Exception as e:  # noqa: BLE001
        fail("voice separation deps missing: %s (scripts/visual-db-uv.sh --voice)" % e)

    src_wav = to_mono_wav(inp)
    if not src_wav:
        fail("ffmpeg could not extract audio from %r (need OVERCAST_FFMPEG or ffmpeg on PATH)" % inp)

    try:
        pipe = Pipeline.from_pretrained(MODEL, token=TOKEN)
    except Exception as e:  # noqa: BLE001
        m = str(e)
        if any(t in m for t in ("401", "403", "gated", "authorized", "Access")):
            fail("pyannote access denied — accept the license + set HF_TOKEN: %s (%s)" % (GATE_URL, m[:200]),
                 state="needs_credentials")
        fail("could not load %s: %s" % (MODEL, m[:200]))

    try:
        kwargs = {"num_speakers": speakers} if speakers and speakers > 0 else {}
        diar = pipe(src_wav, **kwargs)
    except Exception as e:  # noqa: BLE001
        fail("diarization failed: %s" % str(e)[:200])

    spk = {}
    for turn, _, speaker in diar.itertracks(yield_label=True):
        spk.setdefault(speaker, []).append((float(turn.start), float(turn.end)))
    if not spk:
        fail("no speech/speakers detected")

    overlaps = compute_overlaps(spk)
    base = os.path.splitext(os.path.basename(inp))[0]
    outdir = os.path.join(OUTDIR, "separate")
    os.makedirs(outdir, exist_ok=True)

    outputs = []
    skipped = []  # speakers whose track render failed — surfaced as a structured signal
    for speaker in sorted(spk):
        segs = merge_segments(spk[speaker])
        if not segs:
            continue
        out = os.path.join(outdir, "%s_%s.wav" % (base, speaker))
        try:
            ok = render_muted_track(src_wav, segs, out)
        except Exception as e:  # noqa: BLE001
            ok = False
            err = "%s: %s" % (type(e).__name__, str(e)[:180])
        else:
            err = "wrote no output"
        if not ok:
            sys.stderr.write("track render failed for %s: %s\n" % (speaker, err))
            skipped.append({"speaker": speaker, "error": err})
            continue
        outputs.append({
            "kind": "track", "ref": out, "speaker": speaker,
            "speech_seconds": round(sum(e - s for s, e in segs), 2),
            "segments": [{"at": [round(s, 2), round(e, 2)]} for s, e in segs],
            "overlap": [o for o in overlaps if speaker in o["speakers"]],
        })

    if not outputs:
        fail("all per-speaker track renders failed")

    # `speakers` = diarized total, `count` = rendered tracks; if they differ,
    # `skipped_speakers` names the ones whose ffmpeg render failed so downstream
    # (fan-out / --summarize) has a structured signal, not just stderr.
    payload = {"op": "separate", "input": inp, "model": MODEL,
               "speakers": len(spk), "count": len(outputs),
               "overlap": overlaps, "outputs": outputs}
    if skipped:
        payload["skipped_speakers"] = skipped
    emit({"verb": "enhance", "format": "json", "payload": payload,
          "media": {"ref": inp}, "meta": {"provider": "local:pyannote", "model": MODEL},
          "state": "ready"})


def main():
    argv = sys.argv[1:]
    op = argv[0] if argv else "run"
    if op == "describe":
        return describe()
    if op == "init":
        return init()
    run()


main()
