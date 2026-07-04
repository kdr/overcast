// Local audio DB shims: `audio-fp` (Wang-2003 constellation fingerprint, exact
// match) and `basic-clap` (CLAP audio embeddings, semantic similarity). Both are
// deliberately local-only and shell out to uv-managed Python under
// examples/providers/audio-db/, reusing the same venv + Python locator as the
// visual DBs (localVisionPython / localIndexDir live in vision.ts). The wire
// contract (one loose record on stdout, members read from indexes.json) matches
// the visual-db scripts exactly.

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeRecord, type OvercastRecord } from "../../record.js";
import { runExecProvider } from "../run.js";
import { providerEnv } from "../provider-env.js";
import { shippedPath } from "../../pkg.js";
import { localIndexDir, localVisionPython, type ClipConfig } from "./vision.js";
import type { Case } from "../../case.js";

export type LocalAudioOp = "add" | "match";
export type LocalClapOp = "add" | "match" | "search";

function script(name: string): string | undefined {
  return shippedPath("examples", "providers", "audio-db", name);
}

function missingScript(verb: string, input: string, name: string): OvercastRecord {
  return makeRecord({
    verb,
    format: "json",
    payload: { input },
    media: { ref: input },
    error: `audio DB provider script not found: examples/providers/audio-db/${name}`,
    state: "error",
  });
}

/** Per-index fingerprint params for an `audio-fp` DB, persisted as
 *  `<index-dir>/config.json` at create time and hashed into each member's cache
 *  key so a param change invalidates stale fingerprints. */
export interface AudioFpConfig {
  /** mono resample rate before STFT */
  sampleRate: number;
  nFft: number;
  hop: number;
  /** max-filter footprint (freq × time bins) for peak detection */
  peakNeighborhood: number;
  /** amplitude floor above the per-file median magnitude, in dB */
  peakFloorDb: number;
  /** anchor→target pairs per peak */
  fanOut: number;
  /** min/max target-zone offset in STFT frames */
  minDt: number;
  maxDt: number;
}

export function defaultAudioFpConfig(): AudioFpConfig {
  return { sampleRate: 11025, nFft: 2048, hop: 512, peakNeighborhood: 15, peakFloorDb: 20, fanOut: 15, minDt: 1, maxDt: 64 };
}

/** Read an audio-fp index's config.json, merged over defaults (missing file =
 *  all defaults). Tolerates a corrupt/partial file by falling back to defaults. */
export function readAudioFpConfig(indexDir: string): AudioFpConfig {
  const file = join(indexDir, "config.json");
  const base = defaultAudioFpConfig();
  try {
    if (!existsSync(file)) return base;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<AudioFpConfig>;
    return { ...base, ...parsed };
  } catch {
    return base;
  }
}

export function writeAudioFpConfig(indexDir: string, config: AudioFpConfig): void {
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Delete an audio-fp member's cached fingerprint (`fp/<sha1(ref)>.npz` + json).
 *  Mirrors the Python cache key (sha1 of the resolved ref). */
export function removeAudioFingerprint(indexDir: string, ref: string): void {
  const key = createHash("sha1").update(ref).digest("hex");
  for (const ext of ["npz", "json"]) {
    const f = join(indexDir, "fp", `${key}.${ext}`);
    try {
      if (existsSync(f)) rmSync(f, { force: true });
    } catch {
      /* best-effort cache cleanup */
    }
  }
}

/** CLAP config reuses ClipConfig's shape — sampling/fps/maxFrames stay unused
 *  (audio is chunked in `window`-second slices, not frame-sampled). */
export function defaultClapConfig(): ClipConfig {
  return { pooling: "mean", granularity: "video", sampling: "uniform", window: 10, maxFrames: null, fps: null };
}

export function readClapConfig(indexDir: string): ClipConfig {
  const file = join(indexDir, "config.json");
  const base = defaultClapConfig();
  try {
    if (!existsSync(file)) return base;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ClipConfig>;
    return { ...base, ...parsed };
  } catch {
    return base;
  }
}

export function writeClapConfig(indexDir: string, config: ClipConfig): void {
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Local audio fingerprint DB (`audio-fp`): `add` fingerprints + caches a
 * recording; `match` finds which indexed recording contains a query (and where,
 * via offset-histogram alignment). Pairwise mode (`against`) compares two clips
 * directly and MUST NOT touch any index — no index id, no OVERCAST_INDEX_DIR.
 */
export async function runLocalAudio(
  c: Case,
  input: string,
  opts: {
    op: LocalAudioOp;
    indexId?: string;
    /** a second clip for direct clip-to-clip comparison (no index) */
    against?: string;
    minVotes?: number;
    minRatio?: number;
    minMargin?: number;
    /** render an SVG alignment visualization per match (embeds in briefs) */
    draw?: boolean;
    signal?: AbortSignal;
  },
): Promise<OvercastRecord> {
  const path = script("audio_match.py");
  if (!path) return missingScript("audio", input, "audio_match.py");
  const args = ["--op", opts.op];
  if (opts.indexId) {
    args.push("--index", opts.indexId, "--index-dir", localIndexDir(c, opts.indexId));
  }
  if (opts.against) args.push("--against", opts.against);
  if (opts.minVotes != null) args.push("--min-votes", String(opts.minVotes));
  if (opts.minRatio != null) args.push("--min-ratio", String(opts.minRatio));
  if (opts.minMargin != null) args.push("--min-margin", String(opts.minMargin));
  if (opts.draw) args.push("--draw");
  const env = { ...providerEnv(c.mediaDir), ...(opts.indexId ? { OVERCAST_INDEX_DIR: localIndexDir(c, opts.indexId) } : {}) };
  const rec = await runExecProvider("audio", localVisionPython(), input, {
    env,
    extraArgs: [path, ...args],
    timeoutMs: 15 * 60_000,
    signal: opts.signal,
  });
  rec.meta = { ...rec.meta, case: c.dir };
  return rec;
}

/**
 * Local CLAP semantic DB (`basic-clap`): embed + cache audio (or video audio
 * tracks) and query by audio (`match`) or text (`search`). Mirrors runLocalClip;
 * shells out to examples/providers/audio-db/clap_match.py. For `search`, `input`
 * is the text query.
 */
export async function runLocalClap(
  c: Case,
  input: string,
  opts: {
    indexId: string;
    op: LocalClapOp;
    minSimilarity?: number;
    limit?: number;
    offset?: number;
    pooling?: "max" | "mean";
    granularity?: "video" | "frame";
    window?: number;
    signal?: AbortSignal;
  },
): Promise<OvercastRecord> {
  const path = script("clap_match.py");
  if (!path) return missingScript("similar", input, "clap_match.py");
  const args = ["--op", opts.op, "--index", opts.indexId, "--index-dir", localIndexDir(c, opts.indexId)];
  if (opts.minSimilarity != null) args.push("--min-similarity", String(opts.minSimilarity));
  if (opts.limit != null) args.push("--limit", String(opts.limit));
  if (opts.offset != null) args.push("--offset", String(opts.offset));
  if (opts.pooling) args.push("--pooling", opts.pooling);
  if (opts.granularity) args.push("--granularity", opts.granularity);
  if (opts.window != null) args.push("--window", String(opts.window));
  const rec = await runExecProvider("similar", localVisionPython(), input, {
    env: { ...providerEnv(c.mediaDir), OVERCAST_INDEX_DIR: localIndexDir(c, opts.indexId) },
    extraArgs: [path, ...args],
    timeoutMs: 15 * 60_000,
    signal: opts.signal,
  });
  rec.meta = { ...rec.meta, case: c.dir };
  return rec;
}
