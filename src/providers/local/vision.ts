import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeRecord, type OvercastRecord } from "../../record.js";
import { runExecProvider } from "../run.js";
import { providerEnv } from "../provider-env.js";
import { shippedPath } from "../../pkg.js";
import type { Case } from "../../case.js";

export type LocalFaceOp = "detect" | "match" | "search";
export type LocalClusterOp = "ingest" | "identify" | "recluster" | "list" | "show" | "label";
export type LocalClipOp = "add" | "match" | "search";

function script(name: string): string | undefined {
  return shippedPath("examples", "providers", "visual-db", name);
}

export function localIndexDir(c: Case, indexId: string): string {
  return join(c.indexDir, indexId);
}

/** Per-index config for a local `basic-clip` (CLIP) DB, persisted as
 *  `<index-dir>/config.json` at create time. Query flags override these. */
export interface ClipConfig {
  pooling: "max" | "mean";
  granularity: "video" | "frame";
  sampling: "uniform" | "shots";
  /** seconds per uniform sampling window (one frame per window) */
  window: number;
  maxFrames: number | null;
  fps: number | null;
}

export function defaultClipConfig(): ClipConfig {
  return { pooling: "max", granularity: "video", sampling: "uniform", window: 10, maxFrames: null, fps: null };
}

/** Read a basic-clip index's config.json, merged over defaults (missing file =
 *  all defaults). Tolerates a corrupt/partial file by falling back to defaults. */
export function readClipConfig(indexDir: string): ClipConfig {
  const file = join(indexDir, "config.json");
  const base = defaultClipConfig();
  try {
    if (!existsSync(file)) return base;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ClipConfig>;
    return { ...base, ...parsed };
  } catch {
    return base;
  }
}

export function writeClipConfig(indexDir: string, config: ClipConfig): void {
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Delete a basic-clip member's cached embedding (`emb/<sha1(ref)>.npy` + json).
 *  Mirrors the Python cache key (sha1 of the resolved ref). */
export function removeClipEmbedding(indexDir: string, ref: string): void {
  const key = createHash("sha1").update(ref).digest("hex");
  for (const ext of ["npy", "json"]) {
    const f = join(indexDir, "emb", `${key}.${ext}`);
    try {
      if (existsSync(f)) rmSync(f, { force: true });
    } catch {
      /* best-effort cache cleanup */
    }
  }
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

export function localVisionPython(): string {
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
    offset?: number;
    groupByFile?: boolean;
    maxFrames?: number;
    fps?: number;
    start?: string;
    end?: string;
    thumbnails?: boolean;
    signal?: AbortSignal;
  },
): Promise<OvercastRecord> {
  const path = script("face_match.py");
  if (!path) return missingScript("face", input, "face_match.py");
  if (opts.thumbnails) {
    return makeRecord({
      verb: "face",
      format: "json",
      payload: { input, op: opts.op, faces: [], count: 0 },
      media: { ref: input },
      meta: { provider: "local:face", case: c.dir },
      error: "deepface-local does not support --thumbnails yet",
      state: "error",
    });
  }
  const args = [
    "--op", opts.op,
    "--index", opts.indexId,
    "--index-dir", localIndexDir(c, opts.indexId),
  ];
  if (opts.image) args.push("--match", opts.image);
  if (opts.minSimilarity != null) args.push("--min-similarity", String(opts.minSimilarity));
  if (opts.limit != null) args.push("--limit", String(opts.limit));
  if (opts.offset != null) args.push("--offset", String(opts.offset));
  if (opts.groupByFile) args.push("--group-by", "file");
  if (opts.maxFrames != null) args.push("--max-frames", String(opts.maxFrames));
  if (opts.fps != null) args.push("--fps", String(opts.fps));
  if (opts.start) args.push("--start", opts.start);
  if (opts.end) args.push("--end", opts.end);
  const rec = await runExecProvider("face", localVisionPython(), input, {
    env: { ...providerEnv(c.mediaDir), OVERCAST_INDEX_DIR: localIndexDir(c, opts.indexId) },
    extraArgs: [path, ...args],
    timeoutMs: 15 * 60_000,
    signal: opts.signal,
  });
  rec.meta = { ...rec.meta, case: c.dir };
  return rec;
}

/** Run the local face-CLUSTER provider (examples/providers/visual-db/face_cluster.py).
 *  A face-cluster index is a persistent local face DB (embeddings + provenance +
 *  cluster assignments) under `.overcast/index/<id>/`. ingest/identify embed new
 *  media (deepface); recluster/list/show/label only read the store, so they run
 *  without deepface installed. Non-media ops pass a placeholder `input` the
 *  script ignores. */
export async function runLocalCluster(
  c: Case,
  input: string,
  opts: {
    indexId: string;
    op: LocalClusterOp;
    cluster?: string;
    label?: string;
    sourceRecord?: string;
    minSimilarity?: number;
    limit?: number;
    maxFrames?: number;
    fps?: number;
    start?: string;
    end?: string;
    signal?: AbortSignal;
  },
): Promise<OvercastRecord> {
  const path = script("face_cluster.py");
  if (!path) return missingScript("cluster", input, "face_cluster.py");
  const args = [
    "--op", opts.op,
    "--index", opts.indexId,
    "--index-dir", localIndexDir(c, opts.indexId),
  ];
  if (opts.cluster) args.push("--cluster", opts.cluster);
  if (opts.label != null) args.push("--label", opts.label);
  if (opts.sourceRecord) args.push("--source-record", opts.sourceRecord);
  if (opts.minSimilarity != null) args.push("--min-similarity", String(opts.minSimilarity));
  if (opts.limit != null) args.push("--limit", String(opts.limit));
  if (opts.maxFrames != null) args.push("--max-frames", String(opts.maxFrames));
  if (opts.fps != null) args.push("--fps", String(opts.fps));
  if (opts.start) args.push("--start", opts.start);
  if (opts.end) args.push("--end", opts.end);
  const rec = await runExecProvider("cluster", localVisionPython(), input, {
    env: { ...providerEnv(c.mediaDir), OVERCAST_INDEX_DIR: localIndexDir(c, opts.indexId) },
    extraArgs: [path, ...args],
    timeoutMs: 15 * 60_000,
    signal: opts.signal,
  });
  rec.meta = { ...rec.meta, case: c.dir };
  return rec;
}

/**
 * Local CLIP semantic DB (`basic-clip`): embed + cache images/videos and query by
 * image (`match`) or text (`search`). Mirrors runLocalImage/runLocalFace — shells
 * out to examples/providers/visual-db/clip_match.py through the uv-managed Python.
 * For `search`, `input` is the text query (Python treats the trailing positional
 * as text when --op search, as a media path otherwise).
 */
export async function runLocalClip(
  c: Case,
  input: string,
  opts: {
    indexId: string;
    op: LocalClipOp;
    minSimilarity?: number;
    limit?: number;
    offset?: number;
    pooling?: "max" | "mean";
    granularity?: "video" | "frame";
    sampling?: "uniform" | "shots";
    window?: number;
    maxFrames?: number;
    fps?: number;
    /** explicit frame-marker seconds (from watch/shot boundaries) */
    framesAt?: number[];
    signal?: AbortSignal;
  },
): Promise<OvercastRecord> {
  const path = script("clip_match.py");
  if (!path) return missingScript("similar", input, "clip_match.py");
  const args = [
    "--op", opts.op,
    "--index", opts.indexId,
    "--index-dir", localIndexDir(c, opts.indexId),
  ];
  if (opts.minSimilarity != null) args.push("--min-similarity", String(opts.minSimilarity));
  if (opts.limit != null) args.push("--limit", String(opts.limit));
  if (opts.offset != null) args.push("--offset", String(opts.offset));
  if (opts.pooling) args.push("--pooling", opts.pooling);
  if (opts.granularity) args.push("--granularity", opts.granularity);
  if (opts.sampling) args.push("--sampling", opts.sampling);
  if (opts.window != null) args.push("--window", String(opts.window));
  if (opts.maxFrames != null) args.push("--max-frames", String(opts.maxFrames));
  if (opts.fps != null) args.push("--fps", String(opts.fps));
  if (opts.framesAt?.length) args.push("--frames-at", opts.framesAt.join(","));
  const rec = await runExecProvider("similar", localVisionPython(), input, {
    env: { ...providerEnv(c.mediaDir), OVERCAST_INDEX_DIR: localIndexDir(c, opts.indexId) },
    extraArgs: [path, ...args],
    timeoutMs: 15 * 60_000,
    signal: opts.signal,
  });
  rec.meta = { ...rec.meta, case: c.dir };
  return rec;
}
