#!/usr/bin/env python3
# overcast `enhance --ops segment` (LOCAL): text-prompted INSTANCE segmentation.
# GroundingDINO (grounding-dino-tiny) turns the --prompt into boxes; SAM 2.1
# (sam2.1-hiera-tiny) turns each box into a mask. Per instance we write a binary
# mask PNG + an RGBA cutout (only those pixels). Both models are Apache-2.0 and
# ungated. Emits ONE record whose payload.outputs[] is fanned out into a record
# per instance by the enhance verb; the parent also carries payload.detections[]
# so `overcast crop <parent> --all` works.
#
# Bind via local-models, then:  overcast enhance photo.jpg --ops segment --prompt "the red car"
#   comma-separate the prompt for multiple classes: --prompt "car, person"
#   --masks-only emits binary masks instead of cutouts.
#
# Needs:  transformers>=4.56, torch, pillow, numpy  (scripts/visual-db-uv.sh --segment)
# Env:    SEGMENT_DETECT_MODEL, SEGMENT_SAM_MODEL, SEGMENT_THRESHOLD,
#         SEGMENT_TEXT_THRESHOLD, SEGMENT_MAX_INSTANCES, OVERCAST_MEDIA_DIR
#
# Exec contract:  describe | init | [run] --input <img> --prompt "<thing>" [--masks-only]
import json
import os
import sys


def _envnum(name, default, cast):
    try:
        return cast(os.environ.get(name, default))
    except (ValueError, TypeError):
        return cast(default)


DET_MODEL = os.environ.get("SEGMENT_DETECT_MODEL", "IDEA-Research/grounding-dino-tiny")
SAM_MODEL = os.environ.get("SEGMENT_SAM_MODEL", "facebook/sam2.1-hiera-tiny")
BOX_THRESHOLD = _envnum("SEGMENT_THRESHOLD", "0.3", float)
TEXT_THRESHOLD = _envnum("SEGMENT_TEXT_THRESHOLD", "0.25", float)
MAX_INSTANCES = _envnum("SEGMENT_MAX_INSTANCES", "8", int)
OUTDIR = os.environ.get("OVERCAST_MEDIA_DIR", ".")
IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


def emit(rec):
    sys.stdout.write(json.dumps(rec) + "\n")


def fail(msg, state="error"):
    emit({"verb": "enhance", "format": "json", "payload": {"op": "segment"},
          "error": msg, "state": state})
    sys.exit(0)


def describe():
    emit({"verb": "enhance", "kind": "media.enhanced", "ops": ["segment"],
          "detect_model": DET_MODEL, "sam_model": SAM_MODEL, "accepts": ["image"],
          "needs": ["transformers", "torch", "pillow", "numpy"]})
    sys.exit(0)


def init():
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        import PIL  # noqa: F401
        import numpy  # noqa: F401
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("segmentation needs: scripts/visual-db-uv.sh --segment (transformers torch pillow numpy) — %s\n" % e)
        sys.exit(13)
    sys.exit(0)


def parse_args(argv):
    inp, prompt, masks_only = "", "", False

    def val(j):
        return argv[j + 1] if j + 1 < len(argv) else ""

    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--input":
            inp = val(i); i += 2
        elif a == "--prompt":
            prompt = val(i); i += 2
        elif a in ("--ops", "--speakers"):
            i += 2  # accepted; --ops is the dispatch key, consume its value
        elif a == "--masks-only":
            masks_only = True; i += 1
        elif a == "run":
            i += 1
        elif not a.startswith("-"):
            inp = a; i += 1
        else:
            i += 1
    return inp, prompt, masks_only


def run():
    argv = sys.argv[1:]
    inp, prompt, masks_only = parse_args(argv)
    if not inp or not os.path.exists(inp):
        fail("input not found: %r" % inp)
    if not inp.lower().endswith(IMG_EXTS):
        fail("segment is image-only (%s); segment a frame:// still of a video first" % os.path.basename(inp))
    classes = [c.strip() for c in prompt.split(",") if c.strip()]
    if not classes:
        fail("segment needs --prompt (what to segment, e.g. --prompt \"the red car\")")

    try:
        import numpy as np
        import torch
        from PIL import Image
        from transformers import (AutoProcessor, AutoModelForZeroShotObjectDetection,
                                  Sam2Processor, Sam2Model)
    except Exception as e:  # noqa: BLE001
        fail("segmentation deps missing: %s (scripts/visual-db-uv.sh --segment)" % e)

    try:
        image = Image.open(inp).convert("RGB")
    except Exception as e:  # noqa: BLE001
        fail("could not read image %r: %s" % (inp, e))
    W, H = image.size

    # 1) GroundingDINO: prompt -> boxes. text is a period-separated phrase list.
    try:
        det_proc = AutoProcessor.from_pretrained(DET_MODEL)
        det_model = AutoModelForZeroShotObjectDetection.from_pretrained(DET_MODEL)
    except Exception as e:  # noqa: BLE001
        fail("could not load %s: %s" % (DET_MODEL, str(e)[:200]))
    text = ". ".join(classes) + "."
    det_inputs = det_proc(images=image, text=text, return_tensors="pt")
    with torch.no_grad():
        det_out = det_model(**det_inputs)
    try:
        results = det_proc.post_process_grounded_object_detection(
            det_out, det_inputs["input_ids"], threshold=BOX_THRESHOLD,
            text_threshold=TEXT_THRESHOLD, target_sizes=[(H, W)])
    except TypeError:
        results = det_proc.post_process_grounded_object_detection(
            det_out, threshold=BOX_THRESHOLD, text_threshold=TEXT_THRESHOLD,
            target_sizes=[(H, W)])
    res = results[0]
    boxes = [[float(v) for v in b] for b in res["boxes"].tolist()]
    scores = [float(s) for s in res["scores"].tolist()]
    labels = res.get("text_labels") or res.get("labels") or [prompt] * len(boxes)
    labels = [str(x) for x in labels]
    if not boxes:
        # a clean "nothing matched" — a ready record with zero outputs would be
        # fanned out to nothing; surface it as an explicit empty segmentation.
        emit({"verb": "enhance", "format": "json",
              "payload": {"op": "segment", "input": inp, "detect_model": DET_MODEL,
                          "sam_model": SAM_MODEL, "prompt": prompt, "count": 0,
                          "detections": [], "outputs": [],
                          "note": "no instances matched the prompt"},
              "media": {"ref": inp}, "meta": {"provider": "local:grounded-sam"}, "state": "ready"})
        return

    # rank by score, cap instances
    order = sorted(range(len(boxes)), key=lambda k: -scores[k])[:max(1, MAX_INSTANCES)]
    boxes = [boxes[k] for k in order]
    scores = [scores[k] for k in order]
    labels = [labels[k] for k in order]

    # 2) SAM 2.1: each box -> a mask.
    try:
        sam_proc = Sam2Processor.from_pretrained(SAM_MODEL)
        sam_model = Sam2Model.from_pretrained(SAM_MODEL)
    except Exception as e:  # noqa: BLE001
        fail("could not load %s: %s" % (SAM_MODEL, str(e)[:200]))
    sam_inputs = sam_proc(images=image, input_boxes=[boxes], return_tensors="pt")
    with torch.no_grad():
        sam_out = sam_model(**sam_inputs, multimask_output=False)
    masks = sam_proc.post_process_masks(sam_out.pred_masks.cpu(), sam_inputs["original_sizes"])[0]
    # masks: (num_boxes, 1, H, W) boolean
    masks_np = np.asarray(masks)
    if masks_np.ndim == 4:
        masks_np = masks_np[:, 0]

    outdir = os.path.join(OUTDIR, "segment")
    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(inp))[0]
    src_rgba = np.array(image.convert("RGBA"))

    def slug(s):
        return "".join(ch if ch.isalnum() else "_" for ch in s)[:24] or "obj"

    outputs, dets = [], []
    for idx in range(len(boxes)):
        if idx >= masks_np.shape[0]:
            break
        m = masks_np[idx].astype(bool)
        alpha = (m * 255).astype("uint8")
        x0, y0, x1, y1 = boxes[idx]
        box = {"xmin": int(round(x0)), "ymin": int(round(y0)),
               "xmax": int(round(x1)), "ymax": int(round(y1))}
        score = round(scores[idx], 4)
        label = labels[idx]
        tag = "%s_%d" % (slug(label), idx + 1)
        mask_path = os.path.join(outdir, "%s_%s_mask.png" % (base, tag))
        Image.fromarray(alpha, mode="L").save(mask_path)
        if masks_only:
            outputs.append({"kind": "mask", "ref": mask_path, "label": label, "instance": idx + 1,
                            "score": score, "box": box, "box_normalized": False})
        else:
            cut = src_rgba.copy()
            cut[..., 3] = alpha
            cut_path = os.path.join(outdir, "%s_%s.png" % (base, tag))
            Image.fromarray(cut, mode="RGBA").save(cut_path)
            outputs.append({"kind": "cutout", "ref": cut_path, "mask": mask_path, "label": label,
                            "instance": idx + 1, "score": score, "box": box, "box_normalized": False})
        dets.append({"label": label, "score": score, "box": box, "box_normalized": False})

    if not outputs:
        fail("segmentation produced no masks")

    emit({"verb": "enhance", "format": "json",
          "payload": {"op": "segment", "input": inp, "detect_model": DET_MODEL, "sam_model": SAM_MODEL,
                      "prompt": prompt, "count": len(outputs), "detections": dets, "outputs": outputs},
          "media": {"ref": inp}, "meta": {"provider": "local:grounded-sam", "model": SAM_MODEL},
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
