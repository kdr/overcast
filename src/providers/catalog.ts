import type { ProviderDescriptor } from "../profile.js";

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

/** Location-independent `shipped:` ref to a provider script under providers/
 *  (sources/senses/engines). NOT resolved at catalog-build time: descriptors
 *  persist the ref into profiles/case policies and it resolves through
 *  shippedPath() at spawn time (src/providers/shipped-ref.ts), so bindings
 *  survive the install moving. */
function sidecar(...parts: string[]): string {
  return "shipped:providers/" + parts.join("/");
}

export function providerChoices(): ProviderChoice[] {
  const hfSee = sidecar("senses", "hf", "see.sh");
  const hfEnhance = sidecar("senses", "hf", "enhance.sh");
  const falSee = sidecar("senses", "fal", "see.sh");
  const tcSee = sidecar("senses", "tinycloud", "see.sh");
  const falEnhance = sidecar("senses", "fal", "enhance.sh");
  const falReconstruct = sidecar("senses", "fal", "reconstruct.sh");
  const elListen = sidecar("senses", "elevenlabs", "listen.sh");
  const elEnhance = sidecar("senses", "elevenlabs", "enhance.sh");
  const detect = sidecar("senses", "detect", "detect.py");
  // The OWLv2 detector needs the uv venv python (torch/transformers), not system
  // python3. Honor $DETECT_PY (printed by `scripts/visual-db-uv.sh --detect`) if
  // it's exported when the binding is applied; the interpreter is persisted
  // as-is while the script travels as a `shipped:` ref.
  const detectPy = process.env.DETECT_PY || "python3";
  const localEnhance = sidecar("senses", "local", "enhance.sh");
  const ela = sidecar("senses", "enhance", "ela.py");
  const panorama = sidecar("senses", "enhance", "panorama.py");
  const geocode = sidecar("senses", "geocode", "geocode.sh");
  const localVisionSetup = "shipped:scripts/visual-db-uv.sh";
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
      id: "audio-fp",
      verb: "audio",
      label: "Local audio fingerprint (audio-fp)",
      summary: "Local Shazam-style fingerprint matcher (numpy/scipy); audio-fp indexes are the local hash store for `audio` (exact clip matching).",
      descriptor: {
        type: "inproc",
        backend: "audio-fp",
        id: "audio-fp",
        init: { command: `bash ${localVisionSetup} --audio` },
      },
      env: ["OC_VISUAL_DB_PY"],
      indexableDefault: true,
    },
    {
      id: "basic-clap",
      verb: "similar",
      label: "Local CLAP audio (basic-clap)",
      summary: "Local LAION CLAP audio-embedding DB; basic-clap indexes are the local vector store for `similar` (audio/text→audio search).",
      descriptor: {
        type: "inproc",
        backend: "basic-clap",
        id: "basic-clap",
        init: { command: `bash ${localVisionSetup} --clap` },
      },
      env: ["OC_VISUAL_DB_PY", "OC_CLAP_MODEL"],
      indexableDefault: true,
    },
    {
      id: "voice-print",
      verb: "voice",
      label: "Local voice match (voice-print)",
      summary: "Local speaker-verification DB (pyannote wespeaker embeddings, ungated); voice-print indexes store speaker-window vectors for `voice` (find a reference voice in clips/members; --diarize needs HF_TOKEN).",
      descriptor: {
        type: "inproc",
        backend: "voice-print",
        id: "voice-print",
        init: { command: `bash ${localVisionSetup} --voice` },
      },
      env: ["OC_VISUAL_DB_PY", "OVERCAST_VOICE_MODEL", "HF_TOKEN"],
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
      id: "playwright",
      verb: "screenshot",
      label: "Playwright headless Chromium",
      summary: "Use the shipped headless-Chromium page renderer (playwright optional dep + `npx playwright install chromium`).",
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
      id: "tinycloud",
      verb: "see",
      label: "Cloudglue / tinycloud see",
      summary: "File-level image analysis (describe + on-screen text; --prompt/--detect via extract, no boxes) through tinycloud see (>= 0.3.7).",
      // must stay a `bash …` wrapper: a run template starting with `tinycloud`
      // is treated as the built-in default binding and skipped for see.
      descriptor: exec(`bash ${tcSee} --input {{input}}`, `bash ${tcSee} init`, `bash ${tcSee} describe`),
      env: ["CLOUDGLUE_API_KEY"],
      indexableDefault: true,
    },
    {
      id: "fal",
      verb: "enhance",
      label: "fal.ai enhance",
      summary: "fal.ai enhance toolbox: image/audio restore, plus --ops separate (sam-audio voice split) and --ops segment (sam-3 text-prompted masks).",
      descriptor: exec(`bash ${falEnhance} --input {{input}}`, `bash ${falEnhance} init`, `bash ${falEnhance} describe`),
      env: ["FAL_KEY"],
      indexableDefault: true,
    },
    {
      id: "fal",
      verb: "reconstruct",
      label: "fal.ai reconstruct",
      summary:
        "fal.ai speculative scene reconstruction: camera reposition + --ops sweep (Qwen multi-angle), --ops model (Trellis image→3D GLB, queue-polled), --ops depth (Depth Anything V2). Synthesized imagery — quarantined from evidence, every record carries payload.caveat.",
      descriptor: exec(`bash ${falReconstruct} --input {{input}}`, `bash ${falReconstruct} init`, `bash ${falReconstruct} describe`),
      env: ["FAL_KEY"],
      indexableDefault: false,
    },
    {
      id: "local-models",
      verb: "enhance",
      label: "Local separation & segmentation",
      summary: "On-device enhance toolbox: --ops separate (pyannote per-speaker tracks) + --ops segment (GroundingDINO + SAM 2.1 text-prompted masks/cutouts). Set up with scripts/visual-db-uv.sh --enhance.",
      descriptor: exec(`bash ${localEnhance} --input {{input}}`, `bash ${localEnhance} init`, `bash ${localEnhance} describe`),
      env: ["OC_VISUAL_DB_PY", "HF_TOKEN"],
      indexableDefault: true,
    },
    {
      id: "ela",
      verb: "enhance",
      label: "Local ELA forensics (image)",
      summary:
        "Local `--ops ela` provider: ELA / noise-residual / luminance-gradient forensic overlays from an image (pillow + numpy; no key). Heuristic edit-detection LEADS, not proof — every record carries payload.caveat.",
      // explicit --input (like the fal/hf/local enhance choices) so the media path
      // is never argv[1] — a file basename of run/describe/init can't be mistaken
      // for a subcommand (ela.py's documented contract: [run] --input <img>).
      descriptor: exec(`python3 ${ela} --input {{input}}`, `python3 ${ela} init`, `python3 ${ela} describe`),
      indexableDefault: true,
    },
    {
      id: "panorama",
      verb: "enhance",
      label: "Local panorama stitch (video)",
      summary:
        "Local `--ops panorama` provider: stitch a panning video into ONE wide still (opencv-python + numpy; no key) — exposes a skyline/landmark strip for geolocation that no single frame shows.",
      // explicit --input (see the ela choice above) — keeps the media path off argv[1].
      descriptor: exec(`python3 ${panorama} --input {{input}}`, `python3 ${panorama} init`, `python3 ${panorama} describe`),
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
      // explicit --input (like every other script sense provider) so the media
      // path is never argv[0] — detect.py dispatches its subcommand off the first
      // token, so a file basename of describe/init/run would otherwise misfire
      // (contract: [run] --input <ref> --detect "a,b").
      descriptor: exec(`${detectPy} ${detect} --input {{input}}`, `${detectPy} ${detect} init`, `${detectPy} ${detect} describe`),
      env: ["DETECT_MODEL"],
      indexableDefault: true,
    },
    {
      id: "nominatim",
      verb: "geocode",
      label: "OSM Nominatim reverse geocoder",
      summary:
        "OPT-IN reverse geocoding for `exif --geocode` (OSM Nominatim; no key, curl+jq, ~1 req/s usage policy — point OVERCAST_GEOCODE_URL at your own Nominatim/Photon for volume). Egresses the subject's coordinates to a third party, so it is never a default.",
      descriptor: exec(`bash ${geocode} --input {{input}}`, `bash ${geocode} init`, `bash ${geocode} describe`),
      indexableDefault: false,
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
    { verb: "reconstruct", choice: "fal" },
  ],
  elevenlabs: [
    { verb: "listen", choice: "elevenlabs" },
    { verb: "enhance", choice: "elevenlabs" },
  ],
  "owl-local": [
    { verb: "see", choice: "owl-local" },
  ],
  "local-models": [
    { verb: "enhance", choice: "local-models" },
  ],
  "deepface-local": [
    { verb: "face", choice: "deepface-local" },
  ],
  "basic-clip": [
    { verb: "similar", choice: "basic-clip" },
  ],
  "audio-fp": [
    { verb: "audio", choice: "audio-fp" },
  ],
  "basic-clap": [
    { verb: "similar", choice: "basic-clap" },
  ],
  "voice-print": [
    { verb: "voice", choice: "voice-print" },
  ],
  playwright: [
    { verb: "screenshot", choice: "playwright" },
  ],
};

export function findProviderChoice(verb: string, choice: string): ProviderChoice | undefined {
  return providerChoices().find((c) => c.verb === verb && c.id === choice);
}
