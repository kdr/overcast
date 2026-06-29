import { join } from "node:path";
import { existsSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../../record.js";
import { runExecProvider } from "../run.js";
import { providerEnv } from "../provider-env.js";
import { shippedPath } from "../../pkg.js";
import type { Case } from "../../case.js";

export type LocalFaceOp = "detect" | "match" | "search";

function script(name: string): string | undefined {
  return shippedPath("examples", "providers", "visual-db", name);
}

export function localIndexDir(c: Case, indexId: string): string {
  return join(c.indexDir, indexId);
}

function missingScript(verb: string, input: string, name: string): OvercastRecord {
  return makeRecord({
    verb,
    format: "json",
    payload: { input },
    media: { ref: input },
    error: `visual DB provider script not found: examples/providers/visual-db/${name}`,
    state: "error",
  });
}

function localVisionPython(): string {
  const configured = process.env.OVERCAST_VISUAL_DB_PY || process.env.OC_VISUAL_DB_PY;
  if (configured) return configured;
  const venvPy = shippedPath(".dev", "visual-db-py", "bin", "python");
  if (venvPy && existsSync(venvPy)) return venvPy;
  return "python3";
}

export async function runLocalImage(
  c: Case,
  input: string,
  opts: {
    indexId: string;
    op?: "match";
    minInliers?: number;
    minRatio?: number;
    ratioTest?: number;
    draw?: boolean;
    maxFrames?: number;
    fps?: number;
    signal?: AbortSignal;
  },
): Promise<OvercastRecord> {
  const path = script("image_match.py");
  if (!path) return missingScript("image", input, "image_match.py");
  const args = [
    "--op", opts.op ?? "match",
    "--index", opts.indexId,
    "--index-dir", localIndexDir(c, opts.indexId),
  ];
  if (opts.minInliers != null) args.push("--min-inliers", String(opts.minInliers));
  if (opts.minRatio != null) args.push("--min-ratio", String(opts.minRatio));
  if (opts.ratioTest != null) args.push("--ratio-test", String(opts.ratioTest));
  if (opts.maxFrames != null) args.push("--max-frames", String(opts.maxFrames));
  if (opts.fps != null) args.push("--fps", String(opts.fps));
  if (opts.draw) args.push("--draw");
  const rec = await runExecProvider("image", localVisionPython(), input, {
    env: { ...providerEnv(c.mediaDir), OVERCAST_INDEX_DIR: localIndexDir(c, opts.indexId) },
    extraArgs: [path, ...args],
    timeoutMs: 15 * 60_000,
    signal: opts.signal,
  });
  rec.meta = { ...rec.meta, case: c.dir };
  return rec;
}

export async function runLocalFace(
  c: Case,
  input: string,
  opts: {
    indexId: string;
    op: LocalFaceOp;
    image?: string;
    minSimilarity?: number;
    limit?: number;
    maxFrames?: number;
    fps?: number;
    thumbnails?: boolean;
    signal?: AbortSignal;
  },
): Promise<OvercastRecord> {
  const path = script("face_match.py");
  if (!path) return missingScript("face", input, "face_match.py");
  const args = [
    "--op", opts.op,
    "--index", opts.indexId,
    "--index-dir", localIndexDir(c, opts.indexId),
  ];
  if (opts.image) args.push("--match", opts.image);
  if (opts.minSimilarity != null) args.push("--min-similarity", String(opts.minSimilarity));
  if (opts.limit != null) args.push("--limit", String(opts.limit));
  if (opts.maxFrames != null) args.push("--max-frames", String(opts.maxFrames));
  if (opts.fps != null) args.push("--fps", String(opts.fps));
  if (opts.thumbnails) args.push("--thumbnails");
  const rec = await runExecProvider("face", localVisionPython(), input, {
    env: { ...providerEnv(c.mediaDir), OVERCAST_INDEX_DIR: localIndexDir(c, opts.indexId) },
    extraArgs: [path, ...args],
    timeoutMs: 15 * 60_000,
    signal: opts.signal,
  });
  rec.meta = { ...rec.meta, case: c.dir };
  return rec;
}
