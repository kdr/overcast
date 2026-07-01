// Brain-vision `see` backend — the NEW default for `see`. When the configured
// BRAIN LLM supports image input, we describe the image with a single direct LLM
// call ("describe what you see, in detail") instead of a separate vision
// provider. It resolves whatever brain the profile/env already points at (BYO),
// so no specific brain is forced.
//
// This is a DELIBERATE, opt-out bridge across CLAUDE.md invariant #2 (keep brain
// vs. sense providers separate): the brain is still resolved the BYO way, and the
// classic Hugging Face captioner stays one switch away —
//   `setup provider see builtin:hf`  or  OVERCAST_SEE_BRAIN=off
// — so we never hardcode or force a brain onto a sense.

import { readFileSync } from "node:fs";
import { extname } from "node:path";

import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Context,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";

import { makeRecord, type OvercastRecord } from "../../record.js";
import { resolveCloudglue, type Profile } from "../../profile.js";

/** The turnkey Cloudglue brain: a custom (non-builtin) pi-ai provider speaking
 *  the anthropic-messages API. Shared with the pi extension so the CLI see-path
 *  and the TUI brain agree on the id. */
export const CLOUDGLUE_PROVIDER_ID = "cloudglue";
export const CLOUDGLUE_MODEL_ID = "tinycloud:advanced";

/** The Cloudglue brain model descriptor (image-capable). One source of truth for
 *  both the see-path (here) and the extension's `pi.setModel`. */
export function cloudglueBrainModel(baseUrl: string): Model<"anthropic-messages"> {
  return {
    id: CLOUDGLUE_MODEL_ID,
    name: "TinyCloud Advanced",
    api: "anthropic-messages",
    provider: CLOUDGLUE_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 32_000,
  };
}

/** OVERCAST_SEE_BRAIN=off|0|false|no hard-disables the brain default (falls back
 *  to the HF captioner / placeholder). The switch tests + CI use to stay
 *  deterministic regardless of an ambient Cloudglue key. */
export function brainSeeDisabled(): boolean {
  const v = (process.env.OVERCAST_SEE_BRAIN ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no";
}

/** Which brain the see verb should use, mirroring the extension's turnkey rule:
 *  an explicit `profile.llm` wins; else the turnkey Cloudglue key (env or
 *  ~/.tinycloud/config.json). undefined = no brain configured. */
export function resolveBrainChoice(profile: Profile): { provider: string; model?: string } | undefined {
  if (profile.llm?.provider) {
    return { provider: profile.llm.provider, model: profile.llm.model };
  }
  if (resolveCloudglue().apiKey) {
    return { provider: CLOUDGLUE_PROVIDER_ID, model: CLOUDGLUE_MODEL_ID };
  }
  return undefined;
}

/** Result of a brain-see attempt: either a finished record (success OR a clean
 *  error record), or "unavailable" so the caller can fall back to HF/placeholder. */
export type BrainSeeResult =
  | { kind: "record"; record: OvercastRecord }
  | { kind: "unavailable"; reason: string };

export interface BrainSeeCtx {
  profile: Profile;
  caseDir: string;
  /** --prompt: focus the description */
  prompt?: string;
  /** --ocr: also transcribe on-image text */
  ocr?: boolean;
  signal?: AbortSignal;
}

/** Describe an image with the configured brain LLM. `imageRef` must be a local
 *  file path (frame:// refs are already resolved by the caller). */
export async function seeWithBrain(imageRef: string, ctx: BrainSeeCtx): Promise<BrainSeeResult> {
  const resolved = await resolveVisionModel(ctx.profile, ctx.signal);
  if (resolved.kind !== "model") return { kind: "unavailable", reason: resolved.reason };
  const { models, model } = resolved;

  let data: string;
  try {
    data = readFileSync(imageRef).toString("base64");
  } catch (e) {
    return { kind: "record", record: brainRecord(model, ctx.caseDir, imageRef, { error: `image not found: ${imageRef} (${(e as Error).message})` }) };
  }

  const wantOcr = ctx.ocr === true;
  const context: Context = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildSeePrompt(ctx.prompt, wantOcr) },
          { type: "image", data, mimeType: mimeForImage(imageRef) },
        ],
        timestamp: Date.now(),
      },
    ],
  };

  try {
    const res = await models.completeSimple(model, context, {
      signal: ctx.signal,
      // A detailed description is generous but bounded; cap well under the model's
      // window so a chatty model can't run away.
      maxTokens: Math.min(model.maxTokens || 4096, 4096),
    });
    const text = res.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (res.stopReason === "error" || res.stopReason === "aborted" || !text) {
      return {
        kind: "record",
        record: brainRecord(model, ctx.caseDir, imageRef, {
          error: res.errorMessage || `brain returned no description (stopReason=${res.stopReason})`,
        }),
      };
    }
    const { caption, ocr } = wantOcr ? splitDescriptionOcr(text) : { caption: text, ocr: "" };
    return { kind: "record", record: brainRecord(model, ctx.caseDir, imageRef, { caption, ocr }) };
  } catch (e) {
    return { kind: "record", record: brainRecord(model, ctx.caseDir, imageRef, { error: (e as Error).message }) };
  }
}

// --- internals --------------------------------------------------------------

type ResolveResult =
  | { kind: "model"; models: MutableModels; model: Model<Api> }
  | { kind: "unavailable"; reason: string };

/** Build a pi-ai Models with the builtin providers (auth auto-resolved from env)
 *  plus the turnkey Cloudglue provider, then resolve the chosen brain model and
 *  confirm it accepts image input. */
async function resolveVisionModel(profile: Profile, _signal?: AbortSignal): Promise<ResolveResult> {
  const choice = resolveBrainChoice(profile);
  if (!choice) return { kind: "unavailable", reason: "no brain LLM is configured (set one with `setup llm`, or provide a Cloudglue key)" };

  // Heavy imports (the full builtin catalog + the anthropic-messages transport)
  // stay off the hot path: only loaded when the brain see-path actually runs.
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const models = builtinModels();

  // Register the turnkey Cloudglue provider (custom; anthropic-messages). Its
  // auth reads CLOUDGLUE_API_KEY, so surface the resolved key into the env when it
  // only lives in ~/.tinycloud/config.json (mirrors the CLI/TUI launcher).
  const cg = resolveCloudglue();
  if (cg.apiKey) {
    if (!process.env.CLOUDGLUE_API_KEY) process.env.CLOUDGLUE_API_KEY = cg.apiKey;
    try {
      const { anthropicMessagesApi } = await import("@earendil-works/pi-ai/api/anthropic-messages.lazy");
      const cgProvider = createProvider({
        id: CLOUDGLUE_PROVIDER_ID,
        name: "Cloudglue",
        baseUrl: cg.baseUrl,
        auth: { apiKey: envApiKeyAuth("Cloudglue API key", ["CLOUDGLUE_API_KEY"]) },
        models: [cloudglueBrainModel(cg.baseUrl)],
        api: anthropicMessagesApi(),
      });
      models.setProvider(cgProvider as unknown as Provider);
    } catch {
      /* best-effort; builtin providers remain available for a BYO brain */
    }
  }

  // Resolve the model. Static providers (e.g. anthropic, cloudglue) resolve sync;
  // dynamic providers may need a one-off refresh to populate their list.
  let model = choice.model ? models.getModel(choice.provider, choice.model) : undefined;
  if (!model) {
    await models.refresh(choice.provider).catch(() => {});
    model = choice.model
      ? models.getModel(choice.provider, choice.model)
      : models.getModels(choice.provider).find((m) => supportsImage(m));
  }
  if (!model) {
    return {
      kind: "unavailable",
      reason: `brain model ${choice.provider}${choice.model ? `/${choice.model}` : ""} not found (check \`setup llm\` / provider credentials)`,
    };
  }
  if (!supportsImage(model)) {
    return { kind: "unavailable", reason: `brain model ${model.provider}/${model.id} has no image input` };
  }
  return { kind: "model", models, model };
}

function supportsImage(m: Model<Api>): boolean {
  return Array.isArray(m.input) && m.input.includes("image");
}

/** Build the see instruction. Investigator-flavored, factual, image-only. */
export function buildSeePrompt(focus?: string, ocr?: boolean): string {
  let p =
    "Describe this image in detail. Cover the setting, people, objects, actions, and anything " +
    "notable an investigator would care about. Be specific and factual — describe only what is " +
    "visible, and do not speculate beyond the image.";
  if (focus) p += `\n\nPay particular attention to: ${focus}`;
  if (ocr) {
    p +=
      "\n\nAlso transcribe any text that appears in the image, verbatim. Format your reply exactly as:\n" +
      "DESCRIPTION: <the detailed description>\n" +
      "TEXT: <verbatim transcription of on-image text, or 'none'>";
  }
  return p;
}

/** Split a DESCRIPTION:/TEXT: reply (see --ocr) into caption + ocr. Falls back to
 *  putting the whole reply in the caption if the model didn't follow the format. */
export function splitDescriptionOcr(text: string): { caption: string; ocr: string } {
  const desc = text.match(/DESCRIPTION:\s*([\s\S]*?)(?:\n\s*TEXT:|$)/i);
  if (!desc) return { caption: text, ocr: "" };
  const textPart = text.match(/\n\s*TEXT:\s*([\s\S]*)$/i);
  const ocr = (textPart?.[1] ?? "").trim();
  return { caption: desc[1].trim(), ocr: /^none\.?$/i.test(ocr) ? "" : ocr };
}

/** Map file extension → image mime type (default jpeg). */
export function mimeForImage(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".avif":
      return "image/avif";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".heic":
    case ".heif":
      return "image/heic";
    default:
      return "image/jpeg";
  }
}

/** A see record in the shape existing consumers expect (caption/ocr/detections). */
function brainRecord(
  model: Model<Api>,
  caseDir: string,
  imageRef: string,
  fields: { caption?: string; ocr?: string; error?: string },
): OvercastRecord {
  return makeRecord({
    verb: "see",
    format: "json",
    payload: { caption: fields.caption ?? "", ocr: fields.ocr ?? "", detections: [] },
    media: { ref: imageRef },
    meta: { case: caseDir, provider: `brain:${model.provider}`, model: model.id },
    error: fields.error,
    state: fields.error ? "error" : "ready",
  });
}
