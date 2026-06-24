#!/usr/bin/env python3
"""overcast `enhance` provider — Hugging Face Inference Providers (real model ops).

The classic serverless image-to-image endpoint is gone; enhancement models are
served by providers like fal-ai/replicate. The huggingface_hub InferenceClient
handles provider routing, LoRA adapters, and async polling — so this is a Python
provider (deps: huggingface_hub, pillow). Image upscale/unblur is verified working
via fal-ai. Opt-in: `overcast setup provider enhance "exec:python3 .../hf/enhance.py"`
(the default `enhance` stays the internal ffmpeg toolkit).

Contract: init | describe | run --input <file> [--prompt "<edit>"]
Models: HF_ENHANCE_IMAGE_MODEL / HF_ENHANCE_AUDIO_MODEL ; provider HF_ENHANCE_PROVIDER.
Output is written to $OVERCAST_MEDIA_DIR and returned as a media.enhanced record.
"""
import json
import os
import sys

IMG_MODEL = os.environ.get("HF_ENHANCE_IMAGE_MODEL", "prithivMLmods/Qwen-Image-Edit-2511-Unblur-Upscale")
AUD_MODEL = os.environ.get("HF_ENHANCE_AUDIO_MODEL", "")  # most audio models aren't on providers yet
PROVIDER = os.environ.get("HF_ENHANCE_PROVIDER", "fal-ai")
TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
OUTDIR = os.environ.get("OVERCAST_MEDIA_DIR", ".")

IMG_EXT = {"jpg", "jpeg", "png", "webp", "bmp", "gif"}
AUD_EXT = {"mp3", "wav", "m4a", "aac", "flac", "ogg"}


def emit(rec):
    print(json.dumps(rec))


def need(cond, msg, code=13):
    if not cond:
        sys.stderr.write(msg + "\n")
        sys.exit(code)


def describe():
    emit({"verb": "enhance", "kind": "media.enhanced",
          "image_model": IMG_MODEL, "audio_model": AUD_MODEL or "(none on providers)",
          "provider": PROVIDER, "needs": ["HF_TOKEN", "huggingface_hub", "pillow"]})


def init():
    need(TOKEN, "enhance (Hugging Face) needs HF_TOKEN")
    try:
        import huggingface_hub  # noqa: F401
    except ImportError:
        need(False, "pip install 'huggingface_hub>=0.28' pillow")


def run(input_path, prompt):
    need(TOKEN, "enhance (Hugging Face) needs HF_TOKEN")
    if not os.path.isfile(input_path):
        emit({"verb": "enhance", "error": f"input not found: {input_path}", "state": "error"})
        return
    ext = input_path.rsplit(".", 1)[-1].lower()
    os.makedirs(OUTDIR, exist_ok=True)
    base = os.path.splitext(os.path.basename(input_path))[0]
    from huggingface_hub import InferenceClient
    client = InferenceClient(provider=PROVIDER, api_key=TOKEN)
    try:
        if ext in IMG_EXT:
            img = client.image_to_image(
                input_path, model=IMG_MODEL,
                prompt=prompt or "unblur and upscale, enhance fine details and sharpness",
            )
            out = os.path.join(OUTDIR, f"{base}_hf.png")
            img.save(out)
            if not os.path.exists(out) or os.path.getsize(out) == 0:
                emit({"verb": "enhance", "payload": {}, "error": f"HF image enhance wrote no output to {out}", "state": "error"})
                return
            emit({"verb": "enhance", "format": "json",
                  "payload": {"output": out, "ops": ["hf-upscale"], "model": IMG_MODEL},
                  "media": {"ref": out}, "meta": {"provider": f"hf:{PROVIDER}:{IMG_MODEL}"},
                  "state": "ready"})
        elif ext in AUD_EXT:
            if not AUD_MODEL:
                emit({"verb": "enhance", "payload": {},
                      "error": "no audio enhancement model configured/available on HF providers — set HF_ENHANCE_AUDIO_MODEL to one served by a provider, or use ffmpeg (denoise,normalize).",
                      "state": "error"})
                return
            audio = client.audio_to_audio(input_path, model=AUD_MODEL)
            out = os.path.join(OUTDIR, f"{base}_hf.{ext}")
            with open(out, "wb") as f:
                f.write(audio if isinstance(audio, (bytes, bytearray)) else audio[0]["blob"])
            if not os.path.exists(out) or os.path.getsize(out) == 0:
                emit({"verb": "enhance", "payload": {}, "error": f"HF audio enhance wrote no output to {out}", "state": "error"})
                return
            emit({"verb": "enhance", "format": "json",
                  "payload": {"output": out, "ops": ["hf-audio"], "model": AUD_MODEL},
                  "media": {"ref": out}, "meta": {"provider": f"hf:{PROVIDER}:{AUD_MODEL}"},
                  "state": "ready"})
        else:
            emit({"verb": "enhance", "error": f"unsupported modality .{ext}", "state": "error"})
    except Exception as e:  # noqa: BLE001
        emit({"verb": "enhance", "payload": {"provider": f"hf:{PROVIDER}"},
              "error": f"HF enhance failed: {type(e).__name__}: {str(e)[:300]}", "state": "error"})


def main(argv):
    op = argv[1] if len(argv) > 1 else "run"
    if op == "describe":
        return describe()
    if op == "init":
        return init()
    inp, prompt = "", ""
    i = 1
    def val(j):  # flag value, or "" if the flag is the last token (no IndexError)
        return argv[j + 1] if j + 1 < len(argv) else ""
    while i < len(argv):
        a = argv[i]
        if a == "--input":
            inp = val(i); i += 2
        elif a == "--prompt":
            prompt = val(i); i += 2
        elif not a.startswith("-"):
            inp = a; i += 1
        else:
            i += 1
    run(inp, prompt)


if __name__ == "__main__":
    main(sys.argv)
