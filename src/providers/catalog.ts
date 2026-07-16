import type { ProviderDescriptor } from "../profile.js";
import { manifestChoices, manifestPresets } from "./manifests.js";

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

/** The hardcoded CORE provider choices — everything that is NOT a manifest-scanned
 *  exec provider (CLAUDE.md invariant #6 as scoped by the manifests plan):
 *   - the script-less tinycloud watch/listen/face CLI bindings (skill-init),
 *   - the inproc local-DB backends (deepface/clip/clap/audio-fp/voice-print),
 *   - the `clearsBinding` builtins (ffmpeg, playwright).
 *  Script-backed exec providers (hf/fal/tinycloud-see/elevenlabs/detect/local/
 *  ela/panorama/nominatim) live in per-directory provider.json manifests and come
 *  from manifestChoices(). Order here is preserved; scanned choices append after. */
function coreChoices(): ProviderChoice[] {
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
  ];
}

/** All catalog provider choices: hardcoded core + manifest-scanned exec providers.
 *  Materialized per call (manifestChoices() re-reads env for `{{env:…}}` tokens,
 *  matching the old catalog's per-call `process.env.DETECT_PY` read). */
export function providerChoices(home?: string): ProviderChoice[] {
  return [...coreChoices(), ...manifestChoices(home)];
}

/** Core presets that bind hardcoded (non-manifest) choices. Manifest-contributed
 *  presets (hf/fal/elevenlabs/owl-local/local-models) are merged on top. */
function corePresets(): Record<string, Array<{ verb: string; choice: string }>> {
  return {
    cloudglue: [
      { verb: "watch", choice: "tinycloud" },
      { verb: "listen", choice: "tinycloud" },
      { verb: "face", choice: "tinycloud" },
      { verb: "enhance", choice: "ffmpeg" },
    ],
    "deepface-local": [{ verb: "face", choice: "deepface-local" }],
    "basic-clip": [{ verb: "similar", choice: "basic-clip" }],
    "audio-fp": [{ verb: "audio", choice: "audio-fp" }],
    "basic-clap": [{ verb: "similar", choice: "basic-clap" }],
    "voice-print": [{ verb: "voice", choice: "voice-print" }],
    playwright: [{ verb: "screenshot", choice: "playwright" }],
  };
}

/** The full preset map: core presets + manifest-contributed presets. A core
 *  preset name wins over a manifest one of the same name (shipped authority). */
export function providerPresets(home?: string): Record<string, Array<{ verb: string; choice: string }>> {
  return { ...manifestPresets(home), ...corePresets() };
}

export function findProviderChoice(verb: string, choice: string): ProviderChoice | undefined {
  return providerChoices().find((c) => c.verb === verb && c.id === choice);
}
