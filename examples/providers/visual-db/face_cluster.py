#!/usr/bin/env python3
# Local face-CLUSTER provider for overcast's `cluster` verb. Unlike the
# deepface-local matcher (face_match.py), which re-derives embeddings from a
# handful of curated reference images on every query, a cluster index is a
# PERSISTENT local face DB: it ingests faces out of clips/images, stores their
# embeddings + provenance, and groups them into people ("clusters"). Two modes:
#
#   ingest    detect faces in media, embed, ASSIGN-OR-CREATE each into a person
#             (nearest cluster centroid >= threshold → that person, else a new one)
#   identify  probe an image → the most similar person(s), no writes
#   recluster batch re-group every stored face (average-linkage agglomerative
#             at the threshold), carrying human labels forward by plurality
#   list      the people in the DB (size, time span, sources, medoid crop)
#   show      one person's member faces
#   label     name a person (the only stable identity across a recluster)
#
# The on-disk store lives under the index dir (`.overcast/index/<id>/`):
#   faces.jsonl    one row per detected face: id, cluster, source, at, box, crop, embedding
#   clusters.json  {model, detector, next_face, next_cluster, clusters:[{cluster_id,label,
#                   medoid_face_id, size, centroid, members:[face_id...]}]}
#   crops/         <face_id>.jpg thumbnails (best-effort, via ffmpeg)
#
# Pure-Python math (no numpy): the only heavy dep is deepface, imported LAZILY
# and ONLY for ingest/identify (which must embed new media). recluster/list/show/
# label read the store and never touch deepface — so they run anywhere python3 does.

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

VIDEO_EXTS = (".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".mpeg", ".mpg", ".ts", ".mts", ".m2ts", ".wmv", ".flv", ".3gp", ".3g2", ".ogv", ".mxf")

# Clustering-grade defaults (override via env). Facenet512 embeddings separate
# identities far better than the deepface library default (VGG-Face), and the
# retinaface detector yields tight, aligned crops — both hard deepface deps, so
# `scripts/visual-db-uv.sh --face` guarantees them. These matter a lot: opencv +
# VGG-Face produce a cosine space too compressed to cluster real video faces.
FACE_MODEL = os.environ.get("OVERCAST_FACE_MODEL", "Facenet512")
FACE_DETECTOR = os.environ.get("OVERCAST_FACE_DETECTOR", "retinaface")


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, inp="", op="ingest", state="error"):
    emit({
        "verb": "cluster",
        "format": "json",
        "payload": {"op": op, "clusters": [], "count": 0},
        "media": {"ref": inp} if inp else None,
        "error": msg,
        "state": state,
    })
    sys.exit(0)


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--op", choices=["ingest", "identify", "recluster", "list", "show", "label"], required=True)
    p.add_argument("--index", required=True)
    p.add_argument("--index-dir", required=True)
    p.add_argument("--cluster")            # show / label: which person
    p.add_argument("--label")              # label: the human name to set
    p.add_argument("--source-record")      # ingest: the case record id the media came from
    # Facenet512 (the default model) puts same-person cosine ~65–90 and
    # different-person ~≤35; 55 sits in that gap with margin on both sides.
    p.add_argument("--min-similarity", type=float, default=55.0)
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--fps", type=float)
    p.add_argument("--max-frames", type=int)
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("input", nargs="?")     # media for ingest/identify; ignored otherwise
    return p.parse_args()


# ---- store I/O -------------------------------------------------------------

def faces_path(index_dir):
    return Path(index_dir) / "faces.jsonl"


def clusters_path(index_dir):
    return Path(index_dir) / "clusters.json"


def crops_dir(index_dir):
    return Path(index_dir) / "crops"


def atomic_write(path, text):
    # tmp + os.replace so a reader (or a crash) never sees a half-written file.
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def load_faces(index_dir):
    fp = faces_path(index_dir)
    if not fp.exists():
        return []
    out = []
    for line in fp.read_text().splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def save_faces(index_dir, faces):
    atomic_write(faces_path(index_dir), "".join(json.dumps(f) + "\n" for f in faces))


def load_clusters(index_dir):
    cp = clusters_path(index_dir)
    if not cp.exists():
        return {"model": None, "next_face": 1, "next_cluster": 1, "clusters": []}
    data = json.loads(cp.read_text())
    data.setdefault("next_face", 1)
    data.setdefault("next_cluster", 1)
    data.setdefault("clusters", [])
    return data


def save_clusters(index_dir, data):
    atomic_write(clusters_path(index_dir), json.dumps(data, indent=2) + "\n")


def commit_store(index_dir, store, faces):
    # One commit path for every mutation. clusters.json (which carries the
    # next_face/next_cluster COUNTERS) is replaced FIRST: if we crash between
    # the two renames, the counters have already advanced, so a retry can never
    # mint a duplicate face_id — the worst case is member ids in clusters.json
    # that faces.jsonl doesn't have yet, which reconcile() self-heals on the
    # next load.
    save_clusters(index_dir, store)
    save_faces(index_dir, faces)


def store_lock(index_dir, exclusive=True):
    # Cross-process advisory lock. Mutators (ingest/recluster/label) hold it
    # EXCLUSIVE for their whole read-modify-write — without that, two concurrent
    # ingests both read next_face=N and mint duplicate ids. Readers take it
    # SHARED just long enough to snapshot both files (see load_store).
    # POSIX uses flock; Windows falls back to msvcrt.locking on the same file
    # (no shared mode there, so readers serialize with writers — held briefly,
    # that's fine). Only if BOTH are unavailable does it degrade to a no-op.
    Path(index_dir).mkdir(parents=True, exist_ok=True)
    fh = open(Path(index_dir) / ".lock", "a+")
    try:
        import fcntl
        fcntl.flock(fh, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        return fh
    except ImportError:
        pass
    try:
        import msvcrt
        import time
        while True:
            try:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                time.sleep(0.2)
    except ImportError:
        pass
    return fh


def load_store(index_dir):
    # Snapshot BOTH store files under a shared lock, so a reader can't pair
    # clusters.json from after a commit with faces.jsonl from before it
    # (commit_store replaces them one after the other under the exclusive
    # lock). Released immediately — readers never block writers for long.
    fh = store_lock(index_dir, exclusive=False)
    try:
        return load_clusters(index_dir), load_faces(index_dir)
    finally:
        fh.close()


def guard_model(store, faces, inp, op):
    # Embeddings only compare within one embedding CONFIG — the model (vector
    # space) AND the detector (crop/alignment feeding it). Guard whenever ANY
    # embedding-derived state exists (face rows OR cluster centroids —
    # clusters.json can outrun faces.jsonl across the documented crash window).
    # A MISSING stamp is refused like a mismatch: every ingest writes both, so
    # absence means unknown provenance (hand-edited / foreign store) whose
    # embeddings can't be verified against the current config.
    if not (faces or store.get("clusters")):
        return
    problems = []
    for field, env, current in (("model", "OVERCAST_FACE_MODEL", FACE_MODEL), ("detector", "OVERCAST_FACE_DETECTOR", FACE_DETECTOR)):
        stored = store.get(field)
        if not stored:
            problems.append("the index has embeddings but no recorded %s" % field)
        elif stored != current:
            problems.append("%s is %s but the index was built with %s" % (env, current, stored))
    if problems:
        fail(
            "embedding config mismatch: %s — embeddings won't compare; restore the stored config or rebuild the index" % "; ".join(problems),
            inp,
            op,
        )


def reconcile(store, faces):
    # Self-heal the documented partial-commit window (clusters.json replaced,
    # faces.jsonl write lost) in ONE place instead of trusting every reader to
    # filter: drop member ids with no face row, recompute size/medoid/centroid
    # for touched clusters, and drop clusters left with no real members — so
    # ingest can't assign new faces to ghost people and list/view stats can't
    # count faces that don't exist. In-memory only; mutating ops persist the
    # healed state on their normal commit.
    by_id = {f["face_id"]: f for f in faces}
    kept = []
    for cl in store["clusters"]:
        members = [fid for fid in cl.get("members", []) if fid in by_id]
        if not members:
            continue
        if len(members) != len(cl.get("members", [])) or not cl.get("centroid"):
            cl["members"] = members
            recompute(cl, by_id)
        # size is ALWAYS re-derived from surviving members (not just when
        # membership changed) so every downstream reader — list's sort, show's
        # summary, cluster_view — sees one consistent count even if the stored
        # field drifted.
        cl["size"] = len(members)
        # keep the DENORMALIZED face-row cluster_id true to the authoritative
        # membership (clusters.json members) — mutators persist the healed rows.
        for fid in members:
            by_id[fid]["cluster_id"] = cl["cluster_id"]
        kept.append(cl)
    store["clusters"] = kept


# ---- vector math (pure python) ---------------------------------------------

def norm(v):
    return math.sqrt(sum(x * x for x in v))


def cosine(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    denom = norm(a) * norm(b)
    if denom == 0:
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / denom


def mean(vectors):
    if not vectors:
        return []
    n = len(vectors)
    dim = len(vectors[0])
    acc = [0.0] * dim
    for v in vectors:
        for i in range(dim):
            acc[i] += v[i]
    return [x / n for x in acc]


def as_list(embedding):
    # deepface returns numpy arrays in prod, plain lists in tests — normalize.
    try:
        return [float(x) for x in embedding]
    except TypeError:
        return list(embedding)


# ---- embedding extraction (deepface) ---------------------------------------

def load_deepface(inp, op):
    try:
        from deepface import DeepFace
        return DeepFace
    except Exception as e:
        fail("face cluster deps missing: %s (run scripts/visual-db-uv.sh --face)" % e, inp, op)


def represent(deepface, path):
    return deepface.represent(
        img_path=str(path),
        model_name=FACE_MODEL,
        detector_backend=FACE_DETECTOR,
        align=True,
        enforce_detection=False,
    )


def box_of(face):
    return face.get("facial_area") or face.get("region") or {}


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
    nums = [float(p) for p in parts]
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


def detections_from(deepface, path, inp, op, at=None):
    # (embedding, box, frame_path, at) for every face deepface finds in `path`.
    try:
        faces = represent(deepface, path)
    except Exception as e:
        where = "frame %.2f from %s" % (at, inp) if at is not None else str(path)
        fail("local face analysis failed for %s: %s" % (where, e), inp, op)
    out = []
    for f in faces:
        emb = f.get("embedding")
        if not emb:
            continue
        out.append({"embedding": as_list(emb), "box": box_of(f), "frame": str(path), "at": at})
    return out


def crop_face(frame_path, box, dst):
    # best-effort square-ish crop of the detected box via ffmpeg; on any failure
    # the face is still stored with crop=None (the gallery just skips the image).
    try:
        x = int(box.get("x", 0)); y = int(box.get("y", 0))
        w = int(box.get("w", 0)); h = int(box.get("h", 0))
        if w <= 0 or h <= 0:
            return None
        ffmpeg = os.environ.get("OVERCAST_FFMPEG") or "ffmpeg"
        dst.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(
            [ffmpeg, "-y", "-i", str(frame_path), "-vf",
             "crop=%d:%d:%d:%d" % (max(1, w), max(1, h), max(0, x), max(0, y)),
             "-q:v", "2", str(dst)],
            capture_output=True, timeout=60,
        )
        if r.returncode == 0 and dst.exists():
            return str(dst)
    except Exception:
        pass
    return None


# ---- media resolution ------------------------------------------------------

def resolve_media(inp, op):
    if inp is None:
        fail("cluster %s needs a media file (video or image)" % op, "", op)
    if inp.startswith("http://") or inp.startswith("https://"):
        fail("local face cluster only supports local files; capture remote media first", inp, op)
    if not Path(inp).exists():
        fail("input not found: %s" % inp, inp, op)
    return inp


def sampled_detections(deepface, inp, args, op):
    is_video = inp.lower().endswith(VIDEO_EXTS)
    dets = []
    with tempfile.TemporaryDirectory() as wd:
        try:
            start = parse_time(args.start)
            end = parse_time(args.end)
        except ValueError as e:
            fail(str(e), inp, op)
        if is_video:
            queries = frames(inp, args.max_frames, args.fps, wd, start, end)
            if not queries:
                fail("could not extract frames from video", inp, op)
        else:
            queries = [(None, Path(inp))]
        for at, path in queries:
            dets.extend(detections_from(deepface, path, inp, op, at))
    return dets, is_video, len(queries) if is_video else 1


# ---- centroid / medoid maintenance -----------------------------------------

def recompute(cluster, faces_by_id):
    embs = [faces_by_id[fid]["embedding"] for fid in cluster["members"] if fid in faces_by_id]
    if not embs:
        cluster["centroid"] = []
        cluster["size"] = 0
        return
    c = mean(embs)
    cluster["centroid"] = c
    cluster["size"] = len(embs)
    best_fid, best_sim = cluster["members"][0], -1.0
    for fid in cluster["members"]:
        if fid not in faces_by_id:
            continue
        s = cosine(faces_by_id[fid]["embedding"], c)
        if s > best_sim:
            best_sim, best_fid = s, fid
    cluster["medoid_face_id"] = best_fid


# ---- ops -------------------------------------------------------------------

def op_ingest(args):
    inp = resolve_media(args.input, "ingest")
    threshold = args.min_similarity
    deepface = load_deepface(inp, "ingest")

    # serialize the whole read-modify-write against concurrent ingests/reclusters
    lock = store_lock(args.index_dir)  # noqa: F841 — held until process exit
    # re-extract inside a temp dir so frames survive long enough to crop.
    is_video = inp.lower().endswith(VIDEO_EXTS)
    store = load_clusters(args.index_dir)
    existing = load_faces(args.index_dir)
    guard_model(store, existing, inp, "ingest")
    reconcile(store, existing)
    # the orphan state (stored face rows but zero surviving people) must be
    # rebuilt BEFORE ingesting more: assign-or-create against an empty people
    # list would mint a new person per face while the stored embeddings sit
    # unmatched — the same guard identify/list surface, applied to the writer.
    if existing and not store["clusters"]:
        fail("this face-cluster index has %d stored face%s but no people; run `cluster recluster` to rebuild the groups before ingesting more" % (len(existing), "" if len(existing) == 1 else "s"), inp, "ingest")
    store["model"] = FACE_MODEL
    store["detector"] = FACE_DETECTOR
    by_id = {f["face_id"]: f for f in existing}
    clusters = store["clusters"]

    assigned = []
    new_rows = []
    with tempfile.TemporaryDirectory() as wd:
        try:
            start = parse_time(args.start)
            end = parse_time(args.end)
        except ValueError as e:
            fail(str(e), inp, "ingest")
        queries = frames(inp, args.max_frames, args.fps, wd, start, end) if is_video else [(None, Path(inp))]
        if is_video and not queries:
            fail("could not extract frames from video", inp, "ingest")
        sampled = len(queries) if is_video else 1
        for at, frame_path in queries:
            for det in detections_from(deepface, frame_path, inp, "ingest", at):
                fid = "f_%06d" % store["next_face"]
                store["next_face"] += 1
                emb = det["embedding"]
                # assign-or-create against current centroids
                best, best_sim = None, -1.0
                for cl in clusters:
                    s = cosine(emb, cl["centroid"]) * 100.0
                    if s > best_sim:
                        best_sim, best = s, cl
                is_new = best is None or best_sim < threshold
                if is_new:
                    cid = "p_%d" % store["next_cluster"]
                    store["next_cluster"] += 1
                    cl = {"cluster_id": cid, "label": None, "medoid_face_id": fid, "size": 0, "centroid": [], "members": []}
                    clusters.append(cl)
                else:
                    cl = best
                crop = crop_face(frame_path, det["box"], crops_dir(args.index_dir) / (fid + ".jpg"))
                row = {
                    "face_id": fid,
                    "cluster_id": cl["cluster_id"],
                    "source": inp,
                    "source_record": args.source_record,
                    "at": at,
                    "box": det["box"],
                    "crop": crop,
                    "embedding": emb,
                }
                by_id[fid] = row
                new_rows.append(row)
                cl["members"].append(fid)
                recompute(cl, by_id)
                # a matched face reports its score against the matched person; a
                # NEW person has no match to score, so similarity is null and the
                # nearest_* fields explain what it did NOT match (and how close),
                # rather than a fake 100 that reads as a perfect match.
                item = {
                    "face_id": fid,
                    "cluster_id": cl["cluster_id"],
                    "label": cl.get("label"),
                    "similarity": None if is_new else round(best_sim, 2),
                    "is_new_cluster": is_new,
                    "at": at,
                    "box": det["box"],
                    "crop": crop,
                }
                if is_new and best is not None:
                    item["nearest_cluster_id"] = best["cluster_id"]
                    item["nearest_similarity"] = round(best_sim, 2)
                assigned.append(item)

    commit_store(args.index_dir, store, existing + new_rows)

    new_people = sum(1 for a in assigned if a["is_new_cluster"])
    if not assigned:
        summary = "no faces detected in %s" % Path(inp).name
    else:
        summary = "ingested %d face%s → %d new %s, %d matched existing (%d people total)" % (
            len(assigned), "" if len(assigned) == 1 else "s",
            new_people, "person" if new_people == 1 else "people",
            len(assigned) - new_people, len(clusters),
        )
    media = {"ref": inp}
    if assigned and assigned[0]["at"] is not None:
        media["at"] = assigned[0]["at"]
    emit({
        "verb": "cluster",
        "format": "json",
        "payload": {
            "op": "ingest",
            "index": args.index,
            "summary": summary,
            "faces": assigned,
            "count": len(assigned),
            "new_clusters": new_people,
            "clusters_total": len(clusters),
            "sampling": {"fps": args.fps, "max_frames": args.max_frames, "sampled_frames": sampled, "start": args.start, "end": args.end},
        },
        "media": media,
        "meta": {"provider": "local:face-cluster", "model": store["model"]},
        "state": "ready",
    })


def op_identify(args):
    inp = resolve_media(args.input, "identify")
    threshold = args.min_similarity
    deepface = load_deepface(inp, "identify")
    store, face_rows = load_store(args.index_dir)
    faces = {f["face_id"]: f for f in face_rows}
    # the probe is embedded with FACE_MODEL/FACE_DETECTOR — comparing it against
    # a store built with a different config would be silently meaningless.
    guard_model(store, face_rows, inp, "identify")
    reconcile(store, face_rows)
    clusters = store["clusters"]
    if not clusters:
        # distinguish "nothing ingested yet" from "faces exist but no people
        # survived reconcile" (partial write / hand-edit) — the remedies differ:
        # more ingests never rebuild groups from stored rows, recluster does.
        if face_rows:
            fail("this face-cluster index has %d stored face%s but no people; run `cluster recluster` to rebuild the groups" % (len(face_rows), "" if len(face_rows) == 1 else "s"), inp, "identify")
        fail("this face-cluster index is empty; ingest media first with `cluster add`", inp, "identify")

    dets, _is_video, _sampled = sampled_detections(deepface, inp, args, "identify")
    matches = []
    for det in dets:
        ranked = sorted(
            ({"cluster_id": cl["cluster_id"], "label": cl.get("label"), "size": cl["size"],
              "similarity": round(cosine(det["embedding"], cl["centroid"]) * 100.0, 2),
              "medoid_crop": (faces.get(cl["medoid_face_id"]) or {}).get("crop")} for cl in clusters),
            key=lambda m: m["similarity"], reverse=True,
        )
        top = ranked[: max(1, args.limit)]
        best = ranked[0]["similarity"] if ranked else 0.0
        matches.append({"at": det["at"], "confident": best >= threshold, "would_be_new": best < threshold, "candidates": top})

    best_overall = max((m["candidates"][0]["similarity"] for m in matches if m["candidates"]), default=0.0)
    if not matches:
        summary = "no faces found in the probe image"
    else:
        confident = [m for m in matches if m["confident"]]
        if confident:
            # headline the STRONGEST confident match across all probe faces, not
            # whichever face happened to be detected first.
            c0 = max((m["candidates"][0] for m in confident), key=lambda c: c["similarity"])
            who = c0["label"] or c0["cluster_id"]
            summary = "closest person: %s (%.1f%% similar)" % (who, c0["similarity"])
        else:
            summary = "no confident match (best %.1f%% < %.0f%%); this reads as a NEW person" % (best_overall, threshold)
    emit({
        "verb": "cluster",
        "format": "json",
        "payload": {"op": "identify", "index": args.index, "summary": summary, "matches": matches, "count": len(matches)},
        "media": {"ref": inp},
        "meta": {"provider": "local:face-cluster", "model": store.get("model")},
        "state": "ready",
    })


def op_recluster(args):
    threshold = args.min_similarity
    lock = store_lock(args.index_dir)  # noqa: F841 — held until process exit
    faces = load_faces(args.index_dir)
    prev = load_clusters(args.index_dir)
    if not faces:
        fail("this face-cluster index has no faces to recluster", "", "recluster")
    # recluster computes with the stored embedding VALUES (pairwise
    # similarities), so it enforces the config stamps like ingest/identify — an
    # unstamped/foreign store may hold mixed vector spaces, and regrouping those
    # yields garbage. (list/show/label only shuffle metadata; they don't guard.)
    guard_model(prev, faces, "", "recluster")
    prev_label = {}     # face_id -> previous human label (to carry forward)
    prev_by_face = {}   # face_id -> previous cluster_id
    for cl in prev["clusters"]:
        for fid in cl.get("members", []):
            prev_by_face[fid] = cl["cluster_id"]
            if cl.get("label"):
                prev_label[fid] = cl["label"]

    # Average-linkage agglomerative clustering at the cosine threshold: repeatedly
    # merge the two clusters with the highest MEAN cross-similarity until none
    # reach the threshold. Average linkage (vs single linkage) avoids the chaining
    # that merges distinct people through one borderline pair — the failure mode
    # on real, noisy video-frame crops. O(n^2) sim matrix + up to O(n^3) merges;
    # fine for case-scale DBs.
    n = len(faces)
    sim = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            s = cosine(faces[i]["embedding"], faces[j]["embedding"]) * 100.0
            sim[i][j] = sim[j][i] = s

    groups_list = [[i] for i in range(n)]

    def avg_link(a, b):
        total = 0.0
        for x in a:
            for y in b:
                total += sim[x][y]
        return total / (len(a) * len(b))

    while len(groups_list) > 1:
        best_s, bi, bj = -1e9, -1, -1
        for x in range(len(groups_list)):
            for y in range(x + 1, len(groups_list)):
                s = avg_link(groups_list[x], groups_list[y])
                if s > best_s:
                    best_s, bi, bj = s, x, y
        if best_s < threshold or bi < 0:
            break
        groups_list[bi].extend(groups_list[bj])
        del groups_list[bj]

    # biggest people first → stable p_1..p_k numbering
    ordered = sorted(groups_list, key=len, reverse=True)
    by_id = {f["face_id"]: f for f in faces}
    new_clusters = []
    next_cluster = 1
    for members_idx in ordered:
        member_ids = [faces[i]["face_id"] for i in members_idx]
        cid = "p_%d" % next_cluster
        next_cluster += 1
        # carry a label forward by plurality of the members' previous labels
        votes = {}
        for fid in member_ids:
            lbl = prev_label.get(fid)
            if lbl:
                votes[lbl] = votes.get(lbl, 0) + 1
        label = max(votes, key=votes.get) if votes else None
        cl = {"cluster_id": cid, "label": label, "medoid_face_id": member_ids[0], "size": 0, "centroid": [], "members": member_ids}
        recompute(cl, by_id)
        for fid in member_ids:
            by_id[fid]["cluster_id"] = cid
        new_clusters.append(cl)

    moved = sum(1 for f in faces if prev_by_face.get(f["face_id"]) != f["cluster_id"])
    # carry the WHOLE previous store forward and replace only what recluster
    # owns — enumerating fields here once dropped `detector`, silently reopening
    # the embedding-config guard after any recluster.
    store = dict(prev)
    store["next_cluster"] = next_cluster
    store["clusters"] = new_clusters
    commit_store(args.index_dir, store, faces)
    emit({
        "verb": "cluster",
        "format": "json",
        "payload": {
            "op": "recluster",
            "index": args.index,
            "summary": "reclustered %d faces: %d → %d people (%d reassigned)" % (n, len(prev["clusters"]), len(new_clusters), moved),
            "clusters_before": len(prev["clusters"]),
            "clusters_after": len(new_clusters),
            "faces": n,
            "reassigned": moved,
            "threshold": threshold,
        },
        "media": None,
        "meta": {"provider": "local:face-cluster", "model": store.get("model")},
        "state": "ready",
    })


def cluster_view(cl, faces_by_id, sample=6):
    members = [faces_by_id[fid] for fid in cl.get("members", []) if fid in faces_by_id]
    ats = [m["at"] for m in members if m.get("at") is not None]
    sources = sorted({m["source"] for m in members if m.get("source")})
    medoid = faces_by_id.get(cl.get("medoid_face_id"))
    # a handful of member crops (medoid first) so a gallery can show real faces
    sample_crops = [c for c in ([(medoid or {}).get("crop")] + [m.get("crop") for m in members]) if c]
    seen, uniq = set(), []
    for c in sample_crops:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return {
        "cluster_id": cl["cluster_id"],
        "label": cl.get("label"),
        # size from the surviving member rows, never the stored field — a
        # non-reconciled/stale size would count faces that don't exist.
        "size": len(members),
        "medoid_face_id": cl.get("medoid_face_id"),
        "medoid_crop": (medoid or {}).get("crop"),
        "sample_crops": uniq[:sample],
        "at_span": [min(ats), max(ats)] if ats else None,
        "sources": sources,
    }


def op_list(args):
    store, face_rows = load_store(args.index_dir)
    faces_by_id = {f["face_id"]: f for f in face_rows}
    reconcile(store, face_rows)
    clusters = sorted(store["clusters"], key=lambda c: c.get("size", 0), reverse=True)[: max(1, args.limit)]
    views = [cluster_view(cl, faces_by_id) for cl in clusters]
    # count named people over the WHOLE store, not the --limit page, so the
    # summary's "(N named)" agrees with its total-people count.
    labeled = sum(1 for cl in store["clusters"] if cl.get("label"))
    # the orphan state (face rows but zero surviving people — partial commit or
    # stale clusters) is actionable: recluster rebuilds the groups; say so here
    # like identify does, instead of a generic empty-DB line.
    if not store["clusters"] and face_rows:
        summary = "%d stored face%s but no people; run `cluster recluster` to rebuild the groups" % (len(face_rows), "" if len(face_rows) == 1 else "s")
    else:
        summary = "%d %s in this face DB (%d named)" % (len(store["clusters"]), "person" if len(store["clusters"]) == 1 else "people", labeled)
    emit({
        "verb": "cluster",
        "format": "json",
        "payload": {
            "op": "list",
            "index": args.index,
            "summary": summary,
            "clusters": views,
            # count = the whole store; clusters is the --limit page and
            # `returned` says how big the page is (same convention as show).
            "count": len(store["clusters"]),
            "returned": len(views),
            "named": labeled,
            "stored_faces": len(face_rows),
        },
        "media": None,
        "meta": {"provider": "local:face-cluster", "model": store.get("model")},
        "state": "ready",
    })


def op_show(args):
    if not args.cluster:
        fail("cluster show needs --cluster <person-id>", "", "show")
    store, face_rows = load_store(args.index_dir)
    faces_by_id = {f["face_id"]: f for f in face_rows}
    reconcile(store, face_rows)
    cl = next((c for c in store["clusters"] if c["cluster_id"] == args.cluster), None)
    if cl is None:
        fail("no such person '%s' in this index (see `cluster list`)" % args.cluster, "", "show")
    members = []
    for fid in cl.get("members", [])[: max(1, args.limit)]:
        f = faces_by_id.get(fid)
        if not f:
            continue
        members.append({"face_id": fid, "source": f.get("source"), "at": f.get("at"), "box": f.get("box"), "crop": f.get("crop")})
    emit({
        "verb": "cluster",
        "format": "json",
        "payload": {
            "op": "show",
            "index": args.index,
            "cluster": cluster_view(cl, faces_by_id),
            "faces": members,
            # count = the person's FULL face count (list's convention: count is
            # the whole, faces is the --limit page) so it can't contradict the
            # summary/cluster.size when the person has more faces than the page.
            "count": cl.get("size", len(members)),
            "returned": len(members),
            "summary": "%s: %d face%s" % (cl.get("label") or cl["cluster_id"], cl.get("size", 0), "" if cl.get("size") == 1 else "s"),
        },
        "media": None,
        "meta": {"provider": "local:face-cluster", "model": store.get("model")},
        "state": "ready",
    })


def op_label(args):
    if not args.cluster:
        fail("cluster label needs --cluster <person-id>", "", "label")
    name = (args.label or "").strip()
    if not name:
        fail("cluster label needs a --label <name>", "", "label")
    lock = store_lock(args.index_dir)  # noqa: F841 — held until process exit
    store = load_clusters(args.index_dir)
    faces = load_faces(args.index_dir)
    reconcile(store, faces)
    cl = next((c for c in store["clusters"] if c["cluster_id"] == args.cluster), None)
    if cl is None:
        fail("no such person '%s' in this index (see `cluster list`)" % args.cluster, "", "label")
    prev = cl.get("label")
    cl["label"] = name
    # the uniform commit path (like ingest/recluster): both files persist, so a
    # reconcile that pruned ghosts can't leave faces.jsonl rows pointing at them.
    commit_store(args.index_dir, store, faces)
    emit({
        "verb": "cluster",
        "format": "json",
        "payload": {
            "op": "label",
            "index": args.index,
            "cluster_id": cl["cluster_id"],
            "label": name,
            "previous_label": prev,
            "summary": "named %s → '%s'" % (cl["cluster_id"], name),
        },
        "media": None,
        "meta": {"provider": "local:face-cluster"},
        "state": "ready",
    })


def main():
    args = parse()
    if args.min_similarity < 0 or args.min_similarity > 100:
        fail("--min-similarity must be between 0 and 100", args.input or "", args.op)
    if args.limit <= 0:
        fail("--limit must be positive", args.input or "", args.op)
    Path(args.index_dir).mkdir(parents=True, exist_ok=True)
    {
        "ingest": op_ingest,
        "identify": op_identify,
        "recluster": op_recluster,
        "list": op_list,
        "show": op_show,
        "label": op_label,
    }[args.op](args)


if __name__ == "__main__":
    main()
