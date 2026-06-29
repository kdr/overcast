// `image` verb: local RANSAC image matching against a case-owned image index.
// This is deliberately local-only; remote searchable video indexes stay under
// `index`/`ask`/`face`.

import { existsSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../record.js";
import { addMember, findIndex, resolveIndexRef } from "../state/index.js";
import { localIndexDir, runLocalImage } from "../providers/local/vision.js";
import { resolveImageArg, resolveVisualArg } from "./media-ref.js";
import { badNumber } from "./validate.js";
import { mkdirSync } from "node:fs";
import type { Case } from "../case.js";
import type { VerbSpec } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "image", format: "json", payload: { error: message }, error: message, state: "error" });
}

function localImageIndex(ctxCase: Case, value: unknown): { id?: string; error?: string } {
  const raw = value != null ? String(value).trim() : "";
  if (!raw) return { error: "--index requires a local image index id/name" };
  const r = resolveIndexRef(ctxCase, raw);
  if (r.error) return { error: r.error };
  const entry = r.entry ?? findIndex(ctxCase, raw);
  if (!entry) return { error: `unknown local image index: ${raw}` };
  if (entry.type !== "image-ransac") return { error: `index ${entry.id} is type '${entry.type}', not image-ransac` };
  if (entry.backend !== "local") return { error: `index ${entry.id} is not local; create one with \`index create <name> --type image-ransac --local\`` };
  return { id: entry.id };
}

export const imageVerb: VerbSpec = {
  name: "image",
  group: "sense",
  summary: "Match images or video frames against a local RANSAC image index.",
  description:
    "`image add <image|record-id> --index <local-image-index>` stores a reference image in a local image-ransac index. " +
    "`image match <image|video|record-id> --index <local-image-index>` searches that DB using OpenCV SIFT/ORB + RANSAC.",
  args: [
    { name: "action", summary: "add | match", required: true },
    { name: "input", summary: "image/video path, URL, or record id", required: false },
  ],
  flags: [
    { name: "index", summary: "local image-ransac index id/name", type: "string" },
    { name: "to", summary: "alias for --index when adding", type: "string" },
    { name: "min-inliers", summary: "minimum RANSAC inliers", type: "number" },
    { name: "min-ratio", summary: "minimum inlier ratio", type: "number" },
    { name: "ratio-test", summary: "Lowe ratio-test threshold", type: "number" },
    { name: "fps", summary: "video frame sampling rate; --max-frames can cap it", type: "number" },
    { name: "max-frames", summary: "video frame sample count/cap", type: "number" },
    { name: "draw", summary: "write match visualization images", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "image.match",
  providerKey: "image",
  run: async (ctx) => {
    const action = ctx.input;
    if (action !== "add" && action !== "match") return [err("usage: image <add|match> <image|video|record-id> --index <local-image-index>")];
    const arg = ctx.rest[0];
    if (!arg) return [err(`image ${action} requires an input`)];
    const indexValue = ctx.opts.index ?? ctx.opts.to;
    const idx = localImageIndex(ctx.case, indexValue);
    if (idx.error) return [err(`image ${action}: ${idx.error}`)];

    const numErr =
      badNumber(ctx.opts, "min-inliers", (n) => n >= 4, "at least 4") ??
      badNumber(ctx.opts, "min-ratio", (n) => n >= 0 && n <= 1, "0–1") ??
      badNumber(ctx.opts, "ratio-test", (n) => n > 0 && n <= 1, "0–1") ??
      badNumber(ctx.opts, "fps", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "max-frames", (n) => n > 0, "a positive number");
    if (numErr) return [err(`image ${action}: ${numErr}`)];

    if (action === "add") {
      const img = resolveImageArg(ctx.case, arg, "image add");
      if (img.error) return [err(img.error)];
      const entry = findIndex(ctx.case, idx.id!);
      if (entry?.members.some((m) => m.ref === img.ref)) {
        return [makeRecord({ verb: "image", format: "json", payload: { op: "add", index: idx.id, file: img.ref, already_member: true }, media: { ref: img.ref! }, meta: { case: ctx.case.dir }, state: "ready" })];
      }
      mkdirSync(localIndexDir(ctx.case, idx.id!), { recursive: true });
      addMember(ctx.case, idx.id!, { ref: img.ref!, recordId: img.recordId });
      return [makeRecord({
        verb: "image",
        format: "json",
        payload: { op: "add", index: idx.id, file: img.ref, summary: `added reference image to ${idx.id}` },
        media: { ref: img.ref! },
        meta: { case: ctx.case.dir, provider: "local:image-ransac" },
        state: "ready",
      })];
    }

    const q = resolveVisualArg(ctx.case, arg, "image match");
    if (q.error) return [err(q.error)];
    if (!/^https?:\/\//i.test(q.ref!) && !existsSync(q.ref!)) return [err(`image match: input not found: ${q.ref}`)];
    const rec = await runLocalImage(ctx.case, q.ref!, {
      indexId: idx.id!,
      minInliers: ctx.opts["min-inliers"] != null ? Number(ctx.opts["min-inliers"]) : undefined,
      minRatio: ctx.opts["min-ratio"] != null ? Number(ctx.opts["min-ratio"]) : undefined,
      ratioTest: ctx.opts["ratio-test"] != null ? Number(ctx.opts["ratio-test"]) : undefined,
      maxFrames: ctx.opts["max-frames"] != null ? Number(ctx.opts["max-frames"]) : undefined,
      fps: ctx.opts.fps != null ? Number(ctx.opts.fps) : undefined,
      draw: ctx.opts.draw === true,
      signal: ctx.signal,
    });
    return [rec];
  },
};
