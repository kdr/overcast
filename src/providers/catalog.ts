import type { ProviderDescriptor } from "../profile.js";
import { shippedPath } from "../pkg.js";

export interface ProviderChoice {
  id: string;
  verb: string;
  label: string;
  summary: string;
  descriptor?: ProviderDescriptor;
  clearsBinding?: boolean;
  env?: string[];
  indexableDefault?: boolean;
}

const exec = (run: string, init?: string, describe?: string): ProviderDescriptor => ({
  type: "exec",
  run,
  init: init ? { command: init } : undefined,
  describe,
});

function sidecar(...parts: string[]): string {
  return shippedPath(...parts) ?? parts.join("/");
}

export function providerChoices(): ProviderChoice[] {
  const hfSee = sidecar("examples", "providers", "hf", "see.sh");
  const hfEnhance = sidecar("examples", "providers", "hf", "enhance.sh");
  const falSee = sidecar("examples", "providers", "fal", "see.sh");
  const falEnhance = sidecar("examples", "providers", "fal", "enhance.sh");
  const elListen = sidecar("examples", "providers", "elevenlabs", "listen.sh");
  const elEnhance = sidecar("examples", "providers", "elevenlabs", "enhance.sh");
  const detect = sidecar("examples", "providers", "detect", "detect.py");
  const localVisionSetup = sidecar("scripts", "visual-db-uv.sh");
  return [
    {
      id: "tinycloud",
      verb: "watch",
      label: "Cloudglue / tinycloud",
      summary: "Default Cloudglue video understanding through tinycloud.",
      descriptor: {
        type: "exec",
        run: "tinycloud watch {{input}} --json",
        init: { skill: "tinycloud-init", ensure: true },
        describe: "tinycloud commands --json",
      },
      env: ["CLOUDGLUE_API_KEY"],
      indexableDefault: true,
    },
    {
      id: "tinycloud",
      verb: "listen",
      label: "Cloudglue / tinycloud speech",
      summary: "Speech-only transcription through tinycloud watch --speech-only.",
      descriptor: exec("tinycloud watch {{input}} --speech-only --json", undefined, "tinycloud commands --json"),
      env: ["CLOUDGLUE_API_KEY"],
      indexableDefault: true,
    },
    {
      id: "tinycloud",
      verb: "face",
      label: "Cloudglue / tinycloud face",
      summary: "Face detect/match/search through tinycloud.",
      descriptor: exec("tinycloud face detect {{input}} --json", undefined, "tinycloud commands --json"),
      env: ["CLOUDGLUE_API_KEY"],
      indexableDefault: true,
    },
    {
      id: "deepface-local",
      verb: "face",
      label: "Local DeepFace",
      summary: "Local face detect/match through DeepFace; deepface-local indexes remain the local DB/search store.",
      descriptor: {
        type: "inproc",
        backend: "deepface-local",
        id: "deepface-local",
        init: { command: `bash ${localVisionSetup} --face` },
      },
      env: ["OC_VISUAL_DB_PY"],
      indexableDefault: true,
    },
    {
      id: "basic-clip",
      verb: "similar",
      label: "Local CLIP (basic-clip)",
      summary: "Local OpenAI CLIP semantic DB; basic-clip indexes are the local vector store for `similar` (text/image search).",
      descriptor: {
        type: "inproc",
        backend: "basic-clip",
        id: "basic-clip",
        init: { command: `bash ${localVisionSetup} --clip` },
      },
      env: ["OC_VISUAL_DB_PY"],
      indexableDefault: true,
    },
    {
      id: "ffmpeg",
      verb: "enhance",
      label: "Local ffmpeg",
      summary: "Use overcast's built-in deterministic ffmpeg enhancer.",
      clearsBinding: true,
      indexableDefault: true,
    },
    {
      id: "hf",
      verb: "see",
      label: "Hugging Face captioner",
      summary: "Hosted HF vision caption/OCR provider.",
      descriptor: exec(`bash ${hfSee} --input {{input}}`, `bash ${hfSee} init`, `bash ${hfSee} describe`),
      env: ["HF_TOKEN"],
      indexableDefault: true,
    },
    {
      id: "hf",
      verb: "enhance",
      label: "Hugging Face enhance",
      summary: "Hosted image enhancement through HF inference providers.",
      descriptor: exec(`bash ${hfEnhance} --input {{input}}`, `bash ${hfEnhance} init`, `bash ${hfEnhance} describe`),
      env: ["HF_TOKEN"],
      indexableDefault: true,
    },
    {
      id: "fal",
      verb: "see",
      label: "fal.ai Florence",
      summary: "fal.ai caption/OCR provider.",
      descriptor: exec(`bash ${falSee} --input {{input}}`, `bash ${falSee} init`, `bash ${falSee} describe`),
      env: ["FAL_KEY"],
      indexableDefault: true,
    },
    {
      id: "fal",
      verb: "enhance",
      label: "fal.ai enhance",
      summary: "fal.ai image/audio enhancement provider.",
      descriptor: exec(`bash ${falEnhance} --input {{input}}`, `bash ${falEnhance} init`, `bash ${falEnhance} describe`),
      env: ["FAL_KEY"],
      indexableDefault: true,
    },
    {
      id: "elevenlabs",
      verb: "listen",
      label: "ElevenLabs Scribe",
      summary: "ElevenLabs speech-to-text provider.",
      descriptor: exec(`bash ${elListen} --input {{input}}`, `bash ${elListen} init`, `bash ${elListen} describe`),
      env: ["ELEVENLABS_API_KEY"],
      indexableDefault: true,
    },
    {
      id: "elevenlabs",
      verb: "enhance",
      label: "ElevenLabs Voice Isolator",
      summary: "ElevenLabs audio voice isolation provider.",
      descriptor: exec(`bash ${elEnhance} --input {{input}}`, `bash ${elEnhance} init`, `bash ${elEnhance} describe`),
      env: ["ELEVENLABS_API_KEY"],
      indexableDefault: true,
    },
    {
      id: "owl-local",
      verb: "see",
      label: "OWLv2 open-vocabulary detection",
      summary: "Local OWLv2/Grounding DINO object detection provider.",
      descriptor: exec(`python3 ${detect}`, `python3 ${detect} init`, `python3 ${detect} describe`),
      env: ["DETECT_MODEL"],
      indexableDefault: true,
    },
  ];
}

export const PROVIDER_PRESETS: Record<string, Array<{ verb: string; choice: string }>> = {
  cloudglue: [
    { verb: "watch", choice: "tinycloud" },
    { verb: "listen", choice: "tinycloud" },
    { verb: "face", choice: "tinycloud" },
    { verb: "enhance", choice: "ffmpeg" },
  ],
  hf: [
    { verb: "see", choice: "hf" },
    { verb: "enhance", choice: "hf" },
  ],
  fal: [
    { verb: "see", choice: "fal" },
    { verb: "enhance", choice: "fal" },
  ],
  elevenlabs: [
    { verb: "listen", choice: "elevenlabs" },
    { verb: "enhance", choice: "elevenlabs" },
  ],
  "owl-local": [
    { verb: "see", choice: "owl-local" },
  ],
  "deepface-local": [
    { verb: "face", choice: "deepface-local" },
  ],
  "basic-clip": [
    { verb: "similar", choice: "basic-clip" },
  ],
};

export function findProviderChoice(verb: string, choice: string): ProviderChoice | undefined {
  return providerChoices().find((c) => c.verb === verb && c.id === choice);
}
