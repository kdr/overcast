// Default `watch` provider: tinycloud (exec). Invariant #11 — call tinycloud
// only via its public CLI verbs; map its envelope to the loose record at THIS
// boundary (invariant #3). A comprehensive describe → flat payload with
// content / transcript / detailed keys.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../../record.js";
import { redactSecrets } from "../../env.js";
import {
  execCapture,
  renderCommand,
  parseFirstJson,
} from "../exec.js";
import { segmentSpeechCues, tinycloudBase, tinycloudChildEnv, tinycloudError, withProxyEgressHint } from "./envelope.js";
import type { ProviderDescriptor } from "../../profile.js";

const DEFAULT_RUN = "tinycloud watch {{input}} --json";

/** Pull the tinycloud envelope's payload, tolerating bare-data or {data}. */
function envelopeData(parsed: unknown): Record<string, unknown> {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (o.data && typeof o.data === "object") return o.data as Record<string, unknown>;
    return o;
  }
  return {};
}

/** Render a transcript string from tinycloud segments[], when present.
 *  Cue extraction + boundary dedupe live in the shared `segmentSpeechCues`
 *  (envelope.ts), the same seam `listen` maps through. */
function transcriptFromSegments(data: Record<string, unknown>): string {
  const segs = data.segments;
  if (!Array.isArray(segs)) return "";
  const lines: string[] = [];
  let prev: ReadonlySet<string> = new Set<string>();
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const { fresh, cues } = segmentSpeechCues(seg, prev);
    prev = cues;
    if (fresh.length === 0) continue;
    const t = fresh.join(" ");
    const start = seg.start_time ?? seg.start_seconds ?? seg.start ?? "";
    lines.push(start !== "" ? `[${start}] ${t}` : t);
  }
  return lines.join("\n");
}

function textFromVttCue(raw: string): { speaker?: string; text: string } | undefined {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  const voice = cleaned.match(/^<v\s+([^>]+)>(.*)<\/v>$/i);
  // strip BOTH halves of a voice cue, not just the fallback branch — tinycloud
  // VTTs lean on `<v Name>`, and its body routinely carries nested `<b>`/`<i>`/
  // timestamp tags that would otherwise survive verbatim into the transcript
  if (voice) return { speaker: stripCueTags(voice[1]).trim(), text: stripCueTags(voice[2]).trim() };
  return { text: stripCueTags(cleaned).trim() };
}

/** Strip WebVTT cue tags (`<b>`, `<v Name>`, `<00:00.500>`, …) in ONE pass.
 *
 *  A single regex pass is incomplete (CodeQL
 *  js/incomplete-multi-character-sanitization): each match runs `<` → the next
 *  `>`, so interleaved brackets leave residue — `<<b>b>hello` keeps a stray
 *  `b>`. Re-running that regex to a fixed point fixes the residue but peels only
 *  ONE nesting layer per pass, so deeply nested text costs O(n²).
 *
 *  A mark stack gets both. Each `<` records the output length at that point; the
 *  matching `>` rewinds the output to it, dropping the whole region — at any
 *  nesting depth, in one traversal, amortized O(n).
 *
 *  A bracket only counts as markup when it PAIRS. An unmatched `<` (spoken
 *  "x < y") and an unmatched `>` ("2 > 1") are ordinary text and survive intact
 *  — a plain depth counter gets this wrong, swallowing the rest of the cue after
 *  a lone `<`. This matches the fixed point's semantics exactly; it is only
 *  faster. */
function stripCueTags(s: string): string {
  const out: string[] = [];
  const marks: number[] = []; // output length at each so-far-unmatched '<'
  for (const ch of s) {
    if (ch === "<") {
      marks.push(out.length);
      out.push(ch);
    } else if (ch === ">" && marks.length > 0) {
      out.length = marks.pop() as number; // rewind over the matched <…> region
    } else {
      out.push(ch);
    }
  }
  return out.join("");
}

/** Cap for the provider-written sidecars (speech VTT, describe markdown). Real
 *  ones for hour-long media land in the low MBs; past this we're being handed
 *  something else. */
const MAX_SIDECAR_BYTES = 16 * 1024 * 1024;

/** Read at most `maxBytes` of a file as utf8, or undefined if it can't be read.
 *  Sizes and reads the SAME descriptor, so nothing is re-resolved by path. */
function readCappedUtf8(path: string, maxBytes: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const want = Math.min(fstatSync(fd).size, maxBytes);
    const buf = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buf, read, want - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Tinycloud full describe writes speech to a WebVTT sidecar. Convert it to a
 * readable speaker transcript so watch records expose spoken words inline. */
function transcriptFromVttPath(path: string): string {
  // Bounded read off ONE descriptor: the sidecar is provider-controlled, so an
  // unbounded readFileSync can be handed an arbitrarily large file, and the
  // existsSync-then-read it replaces was the same check-then-use race this
  // change set has been closing elsewhere. Over the cap we keep the leading
  // bytes — a truncated transcript beats none, and beats an OOM.
  const vtt = readCappedUtf8(path, MAX_SIDECAR_BYTES);
  if (vtt === undefined) return "";
  const out: Array<{ speaker?: string; text: string }> = [];
  for (const block of vtt.split(/\n\s*\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || lines[0] === "WEBVTT") continue;
    // a WebVTT timing line, i.e. `00:00:01.000 --> 00:00:04.000` — match the
    // digit-arrow-digit shape, not a bare `-->` (which also reads as an HTML
    // comment terminator, CodeQL js/bad-tag-filter, and matches cue TEXT)
    const cue = lines.findIndex((l) => /\d\s*-->\s*\d/u.test(l));
    if (cue < 0) continue;
    const parsed = textFromVttCue(lines.slice(cue + 1).join(" "));
    if (!parsed?.text) continue;
    const last = out[out.length - 1];
    if (last && last.speaker === parsed.speaker) last.text += ` ${parsed.text}`;
    else out.push(parsed);
  }
  return out.map((x) => (x.speaker ? `${x.speaker}: ${x.text}` : x.text)).join("\n");
}

function transcriptFromSidecar(data: Record<string, unknown>): string {
  const candidates: unknown[] = [data.vtt_path, data.speech_vtt_path];
  if (data.describe && typeof data.describe === "object") {
    const d = data.describe as Record<string, unknown>;
    candidates.push(d.vtt_path, d.speech_vtt_path);
  }
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = transcriptFromVttPath(c);
    if (t) return t;
  }
  return "";
}

/** A per-segment markdown breakdown (start–end · description — summary). */
function segmentBreakdown(data: Record<string, unknown>): string {
  const segs = data.segments;
  if (!Array.isArray(segs) || segs.length === 0) return "";
  const lines: string[] = ["## Segments"];
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const a = seg.start_time ?? seg.start_seconds ?? seg.start ?? "";
    const b = seg.end_time ?? seg.end_seconds ?? seg.end ?? "";
    const span = a !== "" || b !== "" ? `[${a}–${b}] ` : "";
    const desc = (seg.description as string) ?? "";
    const sum = (seg.summary as string) ?? "";
    lines.push(`- ${span}**${desc}**${sum ? ` — ${sum}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Best-effort markdown "content" (markdown of the describe output).
 * Prefers the on-disk describe markdown sidecar; otherwise builds a readable
 * breakdown from title + summary + per-segment descriptions.
 */
function contentMarkdown(data: Record<string, unknown>): string {
  if (typeof data.describe === "string") return data.describe;
  if (typeof data.summary_markdown === "string") return data.summary_markdown as string;

  // tinycloud's describe is an object with a markdown_path sidecar on disk.
  if (data.describe && typeof data.describe === "object") {
    const d = data.describe as Record<string, unknown>;
    const mdPath = d.markdown_path;
    if (typeof mdPath === "string") {
      // same capped, single-descriptor read as the VTT sidecar — both are
      // provider-written files reached by path
      const md = readCappedUtf8(mdPath, MAX_SIDECAR_BYTES);
      if (md && md.trim()) return md;
    }
  }

  // Synthesize from title + summary + segments.
  const parts: string[] = [];
  if (typeof data.title === "string") parts.push(`# ${data.title}`);
  if (typeof data.summary === "string") parts.push(data.summary as string);
  const breakdown = segmentBreakdown(data);
  if (breakdown) parts.push(breakdown);
  return parts.join("\n\n");
}

export interface WatchOptions {
  /** override the run template (from the profile binding) */
  run?: string;
  /** segmentation kind forwarded to the provider (`--segment`):
   *  shots | chapters | segments | uniform:<seconds> */
  segment?: string;
  /** min shot duration in seconds with segment=shots (`--shot-min-seconds`) */
  shotMinSeconds?: number;
  /** max shot duration in seconds with segment=shots (`--shot-max-seconds`) */
  shotMaxSeconds?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Run the tinycloud watch provider on `input` and map to a single record.
 * A non-zero exit or unparseable output yields an error record (state:"error").
 */
export async function runWatch(
  input: string,
  opts: WatchOptions = {},
): Promise<OvercastRecord> {
  // An empty/whitespace run template (e.g. a profile binding set to "") must
  // fall back to the default — `?? DEFAULT_RUN` alone would keep "".
  const configured = opts.run?.trim();
  const defaultPath = !configured || configured === DEFAULT_RUN;
  const template = defaultPath ? DEFAULT_RUN : configured;
  // Segmentation pass-through (`watch --segment shots`): the default path used
  // to hardcode ["watch", input, "--json"], silently dropping the flags — every
  // watch got tinycloud's uniform:20. Append them when set, on BOTH paths: the
  // default speaks to tinycloud (which owns these flags), and a custom template
  // receives them as its wrapper contract (like listen's --diarize/--lang) —
  // unset flags append nothing, so existing bindings see an unchanged argv.
  const segArgs: string[] = [];
  if (opts.segment) segArgs.push("--segment", opts.segment);
  if (opts.shotMinSeconds !== undefined) segArgs.push("--shot-min-seconds", String(opts.shotMinSeconds));
  if (opts.shotMaxSeconds !== undefined) segArgs.push("--shot-max-seconds", String(opts.shotMaxSeconds));
  const argv = defaultPath
    ? [...tinycloudBase(), "watch", input, ...segArgs, "--json"]
    : [...renderCommand(template, { input }), ...segArgs];
  const [cmd, ...args] = argv;

  // A template that renders to no command (all tokens dropped) would reject at
  // spawn and throw; surface it as a normal error record like other failures.
  if (!cmd) {
    return makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "", transcript: "", detailed: null },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error: `watch run template produced an empty command: ${JSON.stringify(template)}`,
      state: "error",
    });
  }

  const res = await execCapture(cmd, args, {
    // full multimodal describe is legitimately slow; allow generous headroom.
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    env: tinycloudChildEnv(opts.env),
    signal: opts.signal,
    // tinycloud's embedded bun can exit without draining a >64 KiB pipe write,
    // severing the JSON mid-envelope — a file stdout takes the whole write.
    stdoutToFile: true,
  });

  const parsed = parseFirstJson(res.stdout);
  if (parsed === undefined) {
    return makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "", transcript: "", detailed: null },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error:
        res.code === 0
          ? res.stdout.trim()
            ? `tinycloud watch printed ${res.stdout.length} chars but no parseable JSON (output may be malformed or truncated)`
            : "tinycloud watch produced no JSON output"
          : res.code === 13
            ? "tinycloud watch needs credentials (exit 13 — set CLOUDGLUE_API_KEY)"
            : // a MITM-proxied bun fetch dies before any JSON is printed, so the
              // no-JSON exit path needs the egress hint too (matches listen)
              withProxyEgressHint(`tinycloud watch exited ${res.code}: ${redactSecrets(res.stderr.trim().slice(0, 500))}`),
      // exit 13 = missing creds, matching runExecProvider + the source providers
      state: res.code === 13 ? "needs_credentials" : "error",
    });
  }

  const data = envelopeData(parsed);
  const envObj =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  // A non-zero exit OR an error envelope is a failure even if JSON parsed — the
  // record's state/error is authoritative, so surface it instead of a silent
  // empty "ready" record (would otherwise mark the video as successfully watched).
  // string OR {code,message} object — a real Cloudglue job-timeout ships
  // `error: {code:"upstream", message:"Describe job did not finish…"}`, which a
  // string-only check silently dropped (the record then read `exit 1:` with an
  // empty stderr excerpt). The shared extractor handles both shapes.
  const envError = tinycloudError(envObj, data) ?? "";
  const errored =
    res.code !== 0 ||
    envObj.status === "error" ||
    envObj.state === "error" ||
    data.status === "error" ||
    Boolean(envError);
  if (errored) {
    return makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "", transcript: "", detailed: data },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      // a cred gap (exit 13) is a missing key, not a transport failure — no proxy
      // hint there (matches the no-JSON path + runTinycloud's needs_credentials arm)
      error:
        res.code === 13
          ? envError || "tinycloud watch needs credentials (exit 13 — set CLOUDGLUE_API_KEY)"
          : withProxyEgressHint(
              envError ||
                `tinycloud watch failed (exit ${res.code}): ${redactSecrets(res.stderr.trim().slice(0, 500))}`,
            ),
      // exit 13 is the cred-gap convention even when JSON parsed — classify it as
      // needs_credentials (not a hard error), matching the no-JSON path + runExecProvider.
      state: res.code === 13 ? "needs_credentials" : "error",
    });
  }

  const content = contentMarkdown(data);
  const transcript =
    typeof data.transcript === "string" && data.transcript.trim()
      ? (data.transcript as string)
      : transcriptFromSegments(data) || transcriptFromSidecar(data);

  // tinycloud may return a pending job envelope (async). Check BOTH the
  // top-level envelope and the unwrapped data object (the pending marker can
  // live under either, depending on the verb path).
  // Honor an explicit provider state in the envelope (exit 0) — a
  // `needs_credentials` or `pending` marker is authoritative, like runExecProvider,
  // so monitor/runCli classify it correctly instead of defaulting to ready.
  const isPending = (o: Record<string, unknown>) =>
    o.state === "pending" || o.status === "pending";
  const needsCreds = (o: Record<string, unknown>) =>
    o.state === "needs_credentials" || o.status === "needs_credentials";
  const state =
    needsCreds(envObj) || needsCreds(data)
      ? "needs_credentials"
      : isPending(envObj) || isPending(data)
        ? "pending"
        : "ready";

  // A parsed-but-empty result (no content, no transcript, and an empty/absent
  // `detailed`) is not a successful watch — surface it as an error instead of a
  // silent "ready" that would mark the video as analyzed (matches the bash sample).
  const detailedEmpty = !data || Object.keys(data).length === 0;
  if (state === "ready" && !content && !transcript && detailedEmpty) {
    return makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "", transcript: "", detailed: data },
      media: { ref: input },
      meta: { provider: "tinycloud", model: "cloudglue" },
      error: "tinycloud watch produced an empty result (no content/transcript/detailed)",
      state: "error",
    });
  }

  const meta: Record<string, unknown> = { provider: "tinycloud", model: "cloudglue" };
  if (typeof data.title === "string") meta.title = data.title;
  if (typeof data.duration_seconds === "number") meta.duration_seconds = data.duration_seconds;

  // The envelope's top-level `segmentation` does not track the requested/actual
  // segmentation (a shots run still echoes "uniform:20" there, tinycloud ≤ 0.3.15);
  // `describe.primary_segmentation` is the authoritative field. Surface it — plus
  // the modality list, which answers "does this analysis have the visual channel?"
  // — on meta so readers never have to trust the misleading echo in `detailed`.
  const describe =
    data.describe && typeof data.describe === "object" ? (data.describe as Record<string, unknown>) : {};
  const ranSegmentation =
    typeof describe.primary_segmentation === "string" && describe.primary_segmentation
      ? describe.primary_segmentation
      : undefined;
  if (ranSegmentation) meta.segmentation = ranSegmentation;
  if (Array.isArray(describe.primary_modalities)) meta.modalities = describe.primary_modalities;
  if (opts.segment) meta.segmentation_requested = opts.segment;

  const payload: Record<string, unknown> = { content, transcript };
  // A requested segmentation KIND that differs from what actually ran is a silent
  // fallback (the provider reused an existing describe, or predates the segment
  // flags) — say so instead of shipping a clean "ready" that reads as a shots
  // pass. Kind-only compare: `uniform:<s>` window drift stays unflagged because
  // the reported value's param shape isn't contractual.
  const kindOf = (s: string) => s.trim().toLowerCase().split(":")[0];
  if (opts.segment && ranSegmentation && kindOf(ranSegmentation) !== kindOf(opts.segment)) {
    payload.warning = `requested --segment ${opts.segment} but the analysis ran ${ranSegmentation} — the provider likely reused an existing describe for this source; meta.segmentation is authoritative (the detailed.segmentation echo is not).`;
  }
  payload.detailed = data;

  return makeRecord({
    verb: "watch",
    format: "json",
    payload,
    media: { ref: input },
    meta,
    state,
  });
}

/** The default profile descriptor for `watch`. */
export function tinycloudWatchDescriptor(): ProviderDescriptor {
  return {
    type: "exec",
    run: DEFAULT_RUN,
    init: { skill: "tinycloud-init", ensure: true },
    describe: "tinycloud commands --json",
  };
}
