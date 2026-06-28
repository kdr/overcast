import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Case } from "../../case.js";
import { isMemoryRecord, type OvercastRecord } from "../../record.js";
import { execCapture } from "../exec.js";
import { tokenizeCommand } from "../sources/index.js";
import { indexableDocument, type IndexableDocument } from "./fields.js";
import { parseSince } from "./local.js";
import type { Answer, MemoryIndexStatus, MemoryProvider, Passage, QueryOpts } from "./types.js";

export const DEFAULT_QMD_MODEL = "embeddinggemma-300M-Q8_0";

export interface QmdMemoryConfig {
  id?: string;
  command?: string;
  collection?: string;
  model?: string;
  clearTemplate?: string;
  indexTemplate?: string;
  embedTemplate?: string;
  queryTemplate?: string;
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 160);
}

function renderTemplate(template: string, vars: Record<string, string>): string[] {
  return tokenizeCommand(template).flatMap((tok) => {
    const m = tok.match(/^\{\{(\w+)\}\}$/);
    if (m) {
      if (!vars[m[1]]) return [];
      return m[1] === "cmd" ? tokenizeCommand(vars[m[1]]) : [vars[m[1]]];
    }
    let out = tok;
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
    return out ? [out] : [];
  });
}

function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Real qmd can print progress/warnings before the JSON array. Grab the last
    // JSON-looking array/object so warning text does not make the result vanish.
    const start = Math.max(trimmed.lastIndexOf("\n["), trimmed.lastIndexOf("\n{"));
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start + 1).trim());
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function docMarkdown(doc: IndexableDocument): string {
  const at = doc.media?.at != null ? (Array.isArray(doc.media.at) ? doc.media.at.join("-") : String(doc.media.at)) : "";
  return [
    `# ${doc.title}`,
    "",
    `record_id: ${doc.recordId}`,
    `verb: ${doc.verb}`,
    doc.media?.ref ? `media_ref: ${doc.media.ref}` : "",
    at ? `media_at: ${at}` : "",
    doc.time ? `time: ${doc.time}` : "",
    "",
    doc.text,
    "",
  ].filter(Boolean).join("\n");
}

function frontMatterField(text: string, field: string): string | undefined {
  const re = new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "mi");
  return text.match(re)?.[1]?.trim();
}

function textBody(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !/^(record_id|verb|media_ref|media_at|time)\s*:/i.test(line))
    .join("\n")
    .replace(/^# .+\n+/, "")
    .trim();
}

function docsFingerprint(docs: IndexableDocument[]): string {
  const h = createHash("sha256");
  for (const doc of docs) {
    h.update(JSON.stringify({
      id: doc.id,
      recordId: doc.recordId,
      verb: doc.verb,
      title: doc.title,
      text: doc.text,
      media: doc.media,
      time: doc.time,
    }));
    h.update("\n");
  }
  return h.digest("hex");
}

function parseAt(value: unknown): number | [number, number] | undefined {
  if (Array.isArray(value)) {
    const nums = value.map(Number).filter(Number.isFinite);
    if (nums.length >= 2) return [nums[0], nums[1]];
    if (nums.length === 1) return nums[0];
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parts = value.split(/[-,]/).map((p) => Number(p.trim())).filter(Number.isFinite);
    if (parts.length >= 2) return [parts[0], parts[1]];
    if (parts.length === 1) return parts[0];
  }
  return undefined;
}

function parseQmdPassages(stdout: string): Passage[] {
  const parsed = extractJson(stdout);
  if (!parsed) return [];
  try {
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).results)
        ? ((parsed as Record<string, unknown>).results as unknown[])
        : [];
    const passages: Passage[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const rawText = String(o.text ?? o.content ?? o.body ?? o.snippet ?? "").trim();
      const text = textBody(rawText) || rawText;
      const metadata = (o.metadata && typeof o.metadata === "object" ? o.metadata : {}) as Record<string, unknown>;
      const recordId = String(
        o.recordId ?? o.record_id ?? metadata.recordId ?? metadata.record_id ?? frontMatterField(rawText, "record_id") ?? "",
      ).trim();
      if (!recordId || !text) continue;
      const at = parseAt(
        o.at ?? o.media_at ?? o.mediaAt ?? metadata.at ?? metadata.media_at ?? metadata.mediaAt ?? frontMatterField(rawText, "media_at"),
      );
      passages.push({
        recordId,
        at,
        verb: String(o.verb ?? metadata.verb ?? frontMatterField(rawText, "verb") ?? "record"),
        text,
        score: Number(o.score ?? o.similarity ?? 1),
        provider: "qmd",
      });
    }
    return passages;
  } catch {
    return [];
  }
}

interface QmdManifest {
  provider: string;
  backend: string;
  model: string;
  collection: string;
  command: string;
  documents: number;
  records: number;
  fingerprint?: string;
  state: MemoryIndexStatus["state"];
  error?: string;
  updated?: string;
  indexed?: string;
}

export class QmdMemoryProvider implements MemoryProvider {
  readonly id: string;
  readonly backend = "qmd";
  readonly aliases = ["qmd"];
  private readonly command: string;
  private readonly collection: string;
  private readonly model: string;
  private readonly docsDir: string;
  private readonly manifestFile: string;
  private readonly indexName: string;
  private readonly clearTemplate?: string;
  private readonly indexTemplate?: string;
  private readonly embedTemplate?: string;
  private readonly queryTemplate?: string;

  constructor(private readonly case_: Case, cfg: QmdMemoryConfig = {}) {
    this.id = cfg.id ?? "qmd";
    this.command = cfg.command ?? process.env.OVERCAST_QMD_CMD ?? "qmd";
    this.collection = cfg.collection ?? `overcast-${safeName(case_.info().id)}`;
    this.model = cfg.model ?? process.env.OVERCAST_QMD_MODEL ?? DEFAULT_QMD_MODEL;
    this.docsDir = join(case_.indexDir, "case-search", "qmd", "docs");
    this.manifestFile = join(case_.indexDir, "case-search", "qmd", "manifest.json");
    this.indexName = join(case_.indexDir, "case-search", "qmd", "qmd-index");
    this.clearTemplate = cfg.clearTemplate;
    this.indexTemplate = cfg.indexTemplate;
    this.embedTemplate = cfg.embedTemplate;
    this.queryTemplate = cfg.queryTemplate;
  }

  write(_record: OvercastRecord): void {
    // Materialization is batched via rebuild/status; per-record writes stay cheap.
  }

  async status(): Promise<MemoryIndexStatus> {
    const manifest = this.readManifest();
    const records = this.case_.records().filter(isMemoryRecord);
    const docs = records.map(indexableDocument).filter((d): d is IndexableDocument => !!d);
    const fingerprint = docsFingerprint(docs);
    const compatible = manifest &&
      manifest.documents === docs.length &&
      manifest.model === this.model &&
      manifest.collection === this.collection &&
      manifest.fingerprint === fingerprint;
    const state = compatible && manifest.state === "ready" ? "ready" : manifest ? (manifest.state === "error" ? "error" : "stale") : "missing";
    return {
      provider: this.id,
      backend: this.backend,
      state,
      documents: manifest?.documents ?? 0,
      records: records.length,
      path: this.docsDir,
      model: this.model,
      config: { collection: this.collection, command: this.command, index: this.indexName },
      updated: manifest?.updated,
      error: state === "error" ? manifest?.error : undefined,
    };
  }

  async rebuild(): Promise<MemoryIndexStatus> {
    const records = this.case_.records().filter(isMemoryRecord);
    const docs = records.map(indexableDocument).filter((d): d is IndexableDocument => !!d);
    rmSync(this.docsDir, { recursive: true, force: true });
    mkdirSync(this.docsDir, { recursive: true });
    for (const doc of docs) {
      writeFileSync(join(this.docsDir, `${safeName(doc.id)}.md`), docMarkdown(doc), "utf8");
    }
    const manifest: QmdManifest = {
      provider: this.id,
      backend: this.backend,
      model: this.model,
      collection: this.collection,
      command: this.command,
      documents: docs.length,
      records: records.length,
      fingerprint: docsFingerprint(docs),
      state: "stale",
      updated: new Date().toISOString(),
    };
    mkdirSync(dirname(this.manifestFile), { recursive: true });
    this.writeManifest(manifest);

    const vars = {
      cmd: this.command,
      docs: this.docsDir,
      collection: this.collection,
      model: this.model,
      manifest: this.manifestFile,
      index: this.indexName,
    };
    await this.removeCollection(vars);
    const template = this.indexTemplate ?? "{{cmd}} --index {{index}} collection add {{docs}} --name {{collection}} --format json";
    const argv = renderTemplate(template, vars);
    if (argv.length) {
      const res = await execCapture(argv[0], argv.slice(1), { timeoutMs: 15 * 60_000 }).catch((e) => ({
        code: 127,
        stdout: "",
        stderr: (e as Error).message,
      }));
      if (res.code !== 0) {
        const error = res.stderr || res.stdout || `qmd exited ${res.code}`;
        this.writeManifest({ ...manifest, state: "error", error, updated: new Date().toISOString() });
        return { ...(await this.status()), state: "error", error };
      }
    }
    const embedTemplate = this.embedTemplate ?? "{{cmd}} --index {{index}} embed -c {{collection}} --no-gpu --max-docs-per-batch 64";
    const embedArgv = renderTemplate(embedTemplate, vars);
    if (embedArgv.length) {
      const res = await execCapture(embedArgv[0], embedArgv.slice(1), { timeoutMs: 15 * 60_000 }).catch((e) => ({
        code: 127,
        stdout: "",
        stderr: (e as Error).message,
      }));
      if (res.code !== 0) {
        const error = res.stderr || res.stdout || `qmd embed exited ${res.code}`;
        this.writeManifest({ ...manifest, state: "error", error, updated: new Date().toISOString() });
        return { ...(await this.status()), state: "error", error };
      }
    }
    this.writeManifest({ ...manifest, state: "ready", indexed: new Date().toISOString(), updated: new Date().toISOString() });
    return { ...(await this.status()), state: "ready", documents: docs.length, records: records.length };
  }

  async clear(): Promise<MemoryIndexStatus> {
    const vars = {
      cmd: this.command,
      docs: this.docsDir,
      collection: this.collection,
      model: this.model,
      manifest: this.manifestFile,
      index: this.indexName,
    };
    await this.removeCollection(vars);
    rmSync(dirname(this.manifestFile), { recursive: true, force: true });
    return {
      provider: this.id,
      backend: this.backend,
      state: "missing",
      documents: 0,
      records: 0,
      path: this.docsDir,
      model: this.model,
      config: { collection: this.collection, command: this.command, index: this.indexName },
      updated: new Date().toISOString(),
    };
  }

  async query(q: string, opts: QueryOpts = {}): Promise<Passage[]> {
    const st = await this.status();
    if (st.state !== "ready") return [];
    const records = new Map(this.case_.records().map((r) => [r.id, r]));
    const vars = {
      cmd: this.command,
      query: q,
      collection: this.collection,
      model: this.model,
      limit: String(opts.limit ?? 8),
      docs: this.docsDir,
      index: this.indexName,
    };
    const template = this.queryTemplate ?? "{{cmd}} --index {{index}} vsearch {{query}} --collection {{collection}} --format json --full -n {{limit}} --no-gpu";
    const argv = renderTemplate(template, vars);
    if (!argv.length) return [];
    const res = await execCapture(argv[0], argv.slice(1), { timeoutMs: 5 * 60_000 }).catch(() => undefined);
    if (!res || res.code !== 0) return [];
    let passages = parseQmdPassages(res.stdout);
    if (opts.verbs && opts.verbs.length) {
      const verbs = new Set(opts.verbs);
      passages = passages.filter((p) => verbs.has(records.get(p.recordId)?.verb ?? p.verb));
    }
    if (opts.since) {
      const cutoff = parseSince(opts.since);
      if (cutoff == null) throw new Error(`invalid since value: ${opts.since}`);
      passages = passages.filter((p) => {
        const t = records.get(p.recordId)?.meta?.time;
        const ms = t ? Date.parse(String(t)) : NaN;
        return Number.isNaN(ms) || ms >= cutoff;
      });
    }
    return passages.slice(0, opts.limit ?? 8);
  }

  async answer(q: string, opts: QueryOpts = {}): Promise<Answer> {
    const st = await this.status();
    if (st.state !== "ready") {
      const reason = st.state === "error" && st.error ? ` (${st.error})` : "";
      return {
        text: `qmd index is ${st.state}${reason}; run \`overcast case memory index rebuild --memory ${this.id}\` before querying qmd.`,
        citations: [],
      };
    }
    const passages = await this.query(q, opts);
    if (passages.length === 0) return { text: `No qmd results for "${q}".`, citations: [] };
    const lines = [`Found ${passages.length} relevant record(s) for "${q}" via qmd:`, ""];
    for (const p of passages) {
      const at = p.at != null ? ` @${Array.isArray(p.at) ? p.at.join("-") : p.at}s` : "";
      lines.push(`- [${p.recordId}${at}] (${p.verb}) ${p.text}`);
    }
    return { text: lines.join("\n"), citations: passages.map((p) => ({ recordId: p.recordId, at: p.at, verb: p.verb, field: p.field, text: p.text })) };
  }

  async deepsearch(q: string, opts: QueryOpts = {}): Promise<Passage[]> {
    return this.query(q, opts);
  }

  private readManifest(): QmdManifest | undefined {
    if (!existsSync(this.manifestFile)) return undefined;
    try {
      return JSON.parse(readFileSync(this.manifestFile, "utf8")) as QmdManifest;
    } catch {
      return undefined;
    }
  }

  private writeManifest(manifest: QmdManifest): void {
    writeFileSync(this.manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }

  private async removeCollection(vars: Record<string, string>): Promise<void> {
    const clearTemplate = this.clearTemplate ?? "{{cmd}} --index {{index}} collection remove {{collection}}";
    const clearArgv = renderTemplate(clearTemplate, vars);
    if (!clearArgv.length) return;
    // qmd's collection add is not idempotent; an existing collection with the
    // same name must be removed before re-adding the freshly materialized docs.
    // Missing collection is fine on first build/clear, and rebuild's add/embed
    // will surface any real qmd/index-path failure.
    await execCapture(clearArgv[0], clearArgv.slice(1), { timeoutMs: 5 * 60_000 }).catch(() => undefined);
  }
}
