#!/usr/bin/env -S npx tsx
// overcast source provider: MCP consume bridge (prototype / worked example).
//
// Drives ANY stdio MCP server as an overcast source, speaking the exec source
// contract (argv op -> JSON on stdout) with ZERO overcast core changes — the
// canonical example of plugging an MCP feed in without touching `src/`. Bind it
// like any custom source (see the filesystem-server recipe in docs/providers.md):
//
//   export MCP_SERVER_CMD='npx -y @modelcontextprotocol/server-filesystem /data'
//   export OVERCAST_SOURCE_MCP_CMD='npx tsx examples/providers/sources/mcp-bridge.ts'
//   overcast source add mcp:'search query'
//   overcast scan --source mcp --query 'search query' --json
//
// The bridge speaks the MCP stdio JSON-RPC handshake DIRECTLY (initialize ->
// notifications/initialized -> tools/list -> tools/call) — no @modelcontextprotocol/sdk
// dependency, so this example doesn't perturb the pinned tree. Node >=22 builtins only.
//
// Config (all via env, since the exec transport ignores the bridge's stdin):
//   MCP_SERVER_CMD   REQUIRED. Command line that launches the stdio MCP server
//                    (quoted-token aware, e.g. `npx -y pkg --flag "a b"`).
//   MCP_SEARCH_TOOL  optional. Force a specific tool name (skip the heuristic).
//   MCP_QUERY_ARG    optional. Force the query argument name (skip the heuristic).
//   MCP_TOOL_ARGS    optional. JSON object of extra static args merged into every
//                    tools/call (e.g. a filesystem server's {"path":"/data"}).
//
// Exec contract ops:
//   describe                              -> metadata JSON (connects + lists tools if MCP_SERVER_CMD set)
//   init                                  -> exit 0 if the server initializes, 13 if unconfigured/unreachable
//   enumerate --query <q> [--limit N] [--since <30m|7d|2026-06-01>]
//                                         -> JSON array of scan hits on stdout.
//                    --since is BEST-EFFORT: it drops hits whose `published`
//                    parses to a date older than the cutoff (relative 30m/7d/2w
//                    or an absolute date), KEEPS undated hits, and ignores an
//                    unparseable value. A generic MCP tool may return no dates,
//                    so --since only bites when the tool dates its results.
//   fetch --url <u> --out <path>          -> best-effort HTTPS download -> capture JSON

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, unlink } from "node:fs";
import { createHash } from "node:crypto";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";

// ---- exec-contract helpers -------------------------------------------------

/** exit 13 == missing deps/credentials in the overcast exec source contract. */
const EXIT_NEEDS_CONFIG = 13;

function fail(msg: string, code = 1): never {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
}

/** Tokenize a command string respecting single/double quotes (mirrors
 *  tokenizeCommand in src/providers/sources/index.ts). */
function tokenizeCommand(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Minimal `--flag value` parser for the op args (positionals ignored). */
function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        // A value-less flag (`--query` with nothing after it) must NOT masquerade
        // as a real value: map it to an EMPTY string so downstream requireds
        // (opEnumerate's --query, opFetch's --url/--out) reject it, rather than a
        // truthy "true" sentinel that would search/fetch the literal text "true".
        // Note `--limit`/`--since` still default correctly: "" is falsy for the
        // `flags.limit ? … : DEFAULT` guard and `since?.trim()` no-ops on "".
        flags[key] = "";
      }
    }
  }
  return flags;
}

// ---- JSON-RPC types --------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

interface McpContentBlock {
  type: string;
  text?: string;
  // resource/image blocks carry other fields; we only mine text + resource uris
  resource?: { uri?: string; text?: string; mimeType?: string };
  [k: string]: unknown;
}

// ---- MCP stdio client (newline-delimited JSON-RPC) -------------------------

// Cap the UNCONSUMED read buffer (the trailing partial line that hasn't yet
// formed a complete newline-delimited message). execCapture bounds the BRIDGE's
// own stdout, not this internal child->bridge pipe, so a server that floods
// stdout or never emits a newline could grow `buf` until the bridge OOMs. 16 MiB
// is far above any sane single JSON-RPC frame but small enough to fail fast.
const MAX_BUFFER = 16 * 1024 * 1024;

class McpStdioClient {
  private child: ChildProcess;
  private buf = "";
  private nextId = 1;
  // Keyed by the STRING form of the JSON-RPC id. We always send numeric ids, but
  // the spec allows string ids and some servers echo them back as strings — key
  // by string so a `1` request matches whether the server replies with 1 or "1".
  private pending = new Map<string, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private spawnError: Error | null = null;
  private closed = false;
  private killed = false;
  private detached = false;
  serverInfo: unknown = null;
  protocolVersion: string | null = null;

  constructor(cmd: string[]) {
    const [command, ...args] = cmd;
    // Spawn detached (POSIX) so the child leads its OWN process group. That lets
    // close() kill the whole group (`process.kill(-pid, ...)`), so a shell/`npx`
    // wrapper's grandchild MCP server dies with it instead of orphaning. detached
    // only affects the process group, not stdio — we keep the pipes and never
    // unref(), so the bridge stays in charge of the child's lifecycle.
    const detached = process.platform !== "win32";
    this.detached = detached;
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached,
    });
    // Track this child so ANY bridge exit path (signals / exit / uncaught) tears
    // it down — not just a normal close(). See wireChildCleanup below.
    liveChildren.add(this);
    wireChildCleanup();
    this.child.on("error", (e) => {
      this.spawnError = e;
      this.rejectAllPending(e);
    });
    this.child.on("exit", () => {
      this.closed = true;
      liveChildren.delete(this);
      this.rejectAllPending(new Error("MCP server process exited before responding"));
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    // Server logs go to stderr per the MCP spec — forward them to OUR stderr so
    // they never corrupt the JSON we write to stdout.
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (d: string) => process.stderr.write(d));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    // Bound the buffer BEFORE parsing any line: if it has outgrown the cap and the
    // next pending line — the bytes up to the first newline, or the whole buffer
    // when no newline has arrived yet — is itself over the cap, the server is
    // flooding stdout or sending one oversized frame. Fail fast here, ahead of the
    // drain loop, so a single huge COMPLETE line can't slip past into JSON.parse
    // (the post-loop check below only sees the trailing partial).
    if (this.buf.length > MAX_BUFFER) {
      const firstNl = this.buf.indexOf("\n");
      if (firstNl < 0 || firstNl > MAX_BUFFER) {
        this.buf = "";
        const mib = Math.round(MAX_BUFFER / (1024 * 1024));
        this.rejectAllPending(new Error(`MCP server exceeded max buffer (${mib} MiB) without a complete message`));
        this.close();
        return;
      }
    }
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // A well-behaved server keeps logs on stderr; ignore non-JSON noise.
        continue;
      }
      // JSON-RPC ids may be a number OR a string; normalize to the string key so
      // a server echoing a string id still resolves the right pending request.
      const key = this.idKey(msg.id);
      if (key !== null && this.pending.has(key)) {
        const p = this.pending.get(key)!;
        this.pending.delete(key);
        p.resolve(msg);
      }
      // notifications / requests from the server are ignored (we advertise no
      // capabilities, so nothing should call back into us).
    }
    // Everything left in `buf` is an UNCONSUMED partial line (no terminating
    // newline yet). If that alone blows past the cap, the server is flooding
    // stdout or withholding a newline forever — treat it as a protocol error
    // rather than growing until OOM: reject every pending request and tear the
    // server down. Drop the buffer first so a chunk arriving before the child
    // fully exits can't re-trip this.
    if (this.buf.length > MAX_BUFFER) {
      this.buf = "";
      const mib = Math.round(MAX_BUFFER / (1024 * 1024));
      this.rejectAllPending(new Error(`MCP server exceeded max buffer (${mib} MiB) without a complete message`));
      this.close();
    }
  }

  /** Reject + clear every in-flight request. Shared by the spawn-error, exit,
   *  and buffer-overflow paths; safe to call after `pending` is already empty
   *  (a no-op), so the idempotent close()/exit sequence never double-rejects. */
  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Normalize a JSON-RPC id (number | string) to the pending-map key, or null. */
  private idKey(id: unknown): string | null {
    if (typeof id === "number") return String(id);
    if (typeof id === "string") return id;
    return null;
  }

  private send(obj: Record<string, unknown>): void {
    this.child.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private request(method: string, params?: unknown, timeoutMs = 20_000): Promise<JsonRpcResponse> {
    if (this.spawnError) return Promise.reject(this.spawnError);
    if (this.closed) return Promise.reject(new Error("MCP server closed"));
    const id = this.nextId++;
    const key = String(id);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** initialize -> notifications/initialized handshake. */
  async initialize(): Promise<void> {
    const res = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "overcast-mcp-bridge", version: "0.0.1-spike" },
    });
    if (res.error) throw new Error(`initialize failed: ${res.error.message}`);
    const r = (res.result ?? {}) as { serverInfo?: unknown; protocolVersion?: string };
    this.serverInfo = r.serverInfo ?? null;
    this.protocolVersion = r.protocolVersion ?? null;
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    // Follow the MCP tools/list pagination cursor: a response MAY carry a
    // `nextCursor`; when present we re-request tools/list with { cursor } and
    // concatenate, until nextCursor is absent/empty. The FULL accumulated list
    // (not just page 1) then feeds tool selection, describe, and the
    // MCP_SEARCH_TOOL validation — so a search tool that only appears on a later
    // page is still discoverable. A page cap bounds a misbehaving server that
    // keeps echoing the SAME cursor (which would otherwise loop forever): on
    // exceeding it we stop and return what we've gathered rather than spin. The
    // res.error throw is preserved on every page, so connectAndList still closes
    // the child on a failed listing.
    const MAX_PAGES = 100;
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.request("tools/list", cursor ? { cursor } : {});
      if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
      const r = (res.result ?? {}) as { tools?: McpTool[]; nextCursor?: unknown };
      if (Array.isArray(r.tools)) tools.push(...r.tools);
      const next = typeof r.nextCursor === "string" ? r.nextCursor.trim() : "";
      if (!next) return tools; // no more pages
      cursor = next;
    }
    // Hit the page cap — a server that never stops paginating (e.g. repeats one
    // cursor). Return the tools gathered so far instead of looping forever.
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: McpContentBlock[]; structuredContent?: unknown; isError?: boolean }> {
    const res = await this.request("tools/call", { name, arguments: args }, 60_000);
    if (res.error) throw new Error(`tools/call(${name}) failed: ${res.error.message}`);
    const r = (res.result ?? {}) as { content?: McpContentBlock[]; structuredContent?: unknown; isError?: boolean };
    return { content: r.content ?? [], structuredContent: r.structuredContent, isError: r.isError };
  }

  /** Terminate the spawned server. Idempotent (safe to call repeatedly) and it
   *  never throws — both the per-op `finally` and the signal/exit cleanup call it.
   *  On POSIX we signal the child's whole PROCESS GROUP (negative pid) so a
   *  shell/`npx` wrapper's grandchild dies too; SIGKILL of the bridge itself is
   *  uncatchable, so that one path can't run this (best-effort). */
  close(): void {
    if (this.killed) return;
    this.killed = true;
    liveChildren.delete(this);
    try { this.child.stdin?.end(); } catch { /* ignore */ }
    const pid = this.child.pid;
    try {
      if (this.detached && typeof pid === "number") {
        // -pid => signal the entire process group we lead (child + grandchildren).
        try { process.kill(-pid, "SIGTERM"); }
        catch { try { this.child.kill("SIGTERM"); } catch { /* already gone */ } }
      } else {
        this.child.kill("SIGTERM");
      }
    } catch { /* already gone */ }
  }
}

// ---- child lifecycle: kill spawned MCP servers on ANY bridge exit ----------
//
// The bridge spawns the MCP server as a child; overcast may kill the bridge
// (enumerate timeout, abort, or execCapture's output-cap SIGKILL) without ever
// reaching a normal close(). To avoid orphaning the server (and its `npx`
// wrapper), we track every live child and tear them ALL down on each CATCHABLE
// exit path. NOTE: SIGKILL is uncatchable by design — cleanup cannot run when the
// bridge itself is SIGKILLed, so that single path stays best-effort (the server
// usually notices its stdin closed shortly after and exits on its own).

const liveChildren = new Set<McpStdioClient>();
let cleanupWired = false;

/** Kill every live child, best-effort; never throws. Idempotent via close(). */
function cleanupAllChildren(): void {
  for (const c of Array.from(liveChildren)) {
    try { c.close(); } catch { /* best-effort */ }
  }
  liveChildren.clear();
}

/** Wire the catchable signal + exit handlers exactly once. */
function wireChildCleanup(): void {
  if (cleanupWired) return;
  cleanupWired = true;
  const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      cleanupAllChildren();
      // Adding a signal listener suppresses Node's default termination, so exit
      // ourselves with the conventional 128+signum code. Best-effort; the "exit"
      // handler re-runs cleanup harmlessly (close() is idempotent).
      try { process.exit(SIGNAL_EXIT[sig] ?? 1); } catch { /* ignore */ }
    });
  }
  // Fires on process.exit() and normal fall-through — synchronous only, which
  // child.kill() / process.kill() satisfy.
  process.on("exit", () => cleanupAllChildren());
  // Last-ditch: a stray throw outside the promise chain still shouldn't orphan.
  process.on("uncaughtException", (e) => {
    cleanupAllChildren();
    try { process.stderr.write(`mcp-bridge fatal: ${(e as Error)?.message ?? e}\n`); } catch { /* ignore */ }
    try { process.exit(1); } catch { /* ignore */ }
  });
}

// ---- tool-selection heuristic ----------------------------------------------

const NAME_RANK = [/^search/, /^find/, /^query/, /^lookup/, /^retriev/, /^list$/];
const QUERY_KEYS = ["query", "q", "search", "keyword", "keywords", "term", "text", "question", "prompt", "input"];

/** Split a tool name into lowercase word tokens (snake/kebab/space/camelCase) so
 *  rank words match whole tokens, not substrings — `research` must not rank as a
 *  `search` tool, nor `listen` as `list`. */
function nameTokens(name: string): string[] {
  return name.split(/[_\-\s]+|(?<=[a-z0-9])(?=[A-Z])/).map((s) => s.toLowerCase()).filter(Boolean);
}

/** Pick a search-shaped tool: explicit override, else the highest-ranked
 *  name match that also exposes a string-typed argument to carry the query. */
function pickSearchTool(tools: McpTool[], override?: string): McpTool | undefined {
  if (override) return tools.find((t) => t.name === override);
  const scored = tools
    .map((t) => {
      const rank = NAME_RANK.findIndex((rx) => nameTokens(t.name).some((tok) => rx.test(tok)));
      const hasString = Object.values(t.inputSchema?.properties ?? {}).some((p) => p.type === "string" || p.type === undefined);
      return { t, rank, hasString };
    })
    .filter((s) => s.rank >= 0 && s.hasString)
    .sort((a, b) => a.rank - b.rank);
  return scored[0]?.t;
}

/** Choose which string argument carries the query text, or UNDEFINED when the
 *  tool exposes no string argument at all (the caller then fails fast instead of
 *  sending a literal `query` key the tool never declared). */
function pickQueryArg(tool: McpTool, override?: string): string | undefined {
  if (override) return override;
  const props = tool.inputSchema?.properties ?? {};
  const stringKeys = Object.keys(props).filter((k) => props[k].type === "string" || props[k].type === undefined);
  // 1) an obviously-named query param
  for (const cand of QUERY_KEYS) {
    const hit = stringKeys.find((k) => k.toLowerCase() === cand);
    if (hit) return hit;
  }
  // 2) first REQUIRED string param
  const required = tool.inputSchema?.required ?? [];
  const reqStr = stringKeys.find((k) => required.includes(k));
  if (reqStr) return reqStr;
  // 3) first string param — else undefined (no string arg to carry the query)
  return stringKeys[0];
}

// ---- result -> scan.hit mapping --------------------------------------------

interface ScanHit {
  title: string;
  url: string;
  // NOTE: no `source` field — the core's hitsToRecords stamps `payload.source`
  // from the BOUND source type (`source ?? sourceType`). Hardcoding "mcp" would
  // mislabel a custom binding (e.g. `source add myfs:…`) and collapse every MCP
  // binding into one `sourceScanFreshness` bucket. Let the binding own its label.
  published: string | null;
  snippet: string;
  media?: { ref: string };
  mcp_tool?: string;
  [k: string]: unknown;
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** Synthesize a STABLE identity URL from content so the seen-set can dedup
 *  hits whose tool result carries no real URL. Same content -> same id. */
function synthUrl(toolName: string, seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex").slice(0, 16);
  return `mcp://${toolName}/${h}`;
}

/** Map one result object to a hit; synthesize identity when no URL is present. */
function objToHit(o: Record<string, unknown>, toolName: string): ScanHit {
  const urlish = firstString(o, ["url", "link", "uri", "href", "source_url", "permalink", "id"]);
  const title = firstString(o, ["title", "name", "heading", "headline", "label"]) ?? "";
  const snippet = firstString(o, ["snippet", "description", "summary", "text", "content", "body", "abstract"]) ?? "";
  const published = firstString(o, ["published", "publishedAt", "published_at", "date", "datetime", "timestamp", "created", "created_at"]) ?? null;
  // A `media.ref` must be FETCHABLE — the core `fetch`/`capture` only handles
  // http(s), so an opaque `id` (or any non-http scheme) as the ref makes capture
  // fail on an otherwise-valid hit. Such a ref feeds IDENTITY only, never media.
  const fetchable = urlish && /^https?:\/\//i.test(urlish) ? urlish : undefined;
  // identity/dedup: a real URL is best; else seed the stable synthetic id on the
  // opaque ref (so a stable `id` still dedups across runs), else on the object.
  const finalUrl = fetchable ?? synthUrl(toolName, urlish ?? JSON.stringify(o));
  const hit: ScanHit = {
    title: title || snippet.slice(0, 80),
    url: finalUrl,
    published,
    snippet,
    mcp_tool: toolName,
  };
  if (fetchable) hit.media = { ref: fetchable };
  // carry any leftover scalar fields into the loose payload. `source` is RESERVED:
  // the core stamps payload.source from the BOUND source type, and hitsToRecords
  // prefers a hit's own `source` — so a server-supplied `source` would override the
  // operator's binding label / freshness bucket. Keep it out (drop nothing else).
  for (const [k, v] of Object.entries(o)) {
    if (k in hit || k === "source") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") hit[k] = v;
  }
  return hit;
}

/** Best-effort extraction of an array of result items from a tool result. */
function extractItems(structuredContent: unknown, content: McpContentBlock[]): { items: unknown[]; rawText: string } {
  // 1) structuredContent (2025 spec) — an array, an object holding an array, or a
  //    single object record. Precedence: structured first, then text blocks.
  //    - a NON-empty array (direct or plucked) short-circuits: its items ARE the hits.
  //    - an EMPTY structured array is a deliberate "no results" -> fall through to
  //      the text/resource blocks (which may still hold real hits); never fabricate
  //      a hit from [] (round-8 fix — do NOT regress).
  //    - no array at all, but structuredContent IS a plain non-null object -> treat
  //      it as ONE record (items: [structuredContent]), mirroring the text-block
  //      `items: [parsed]` path below, so a structured-only single object (e.g. one
  //      hit with title/url and no nested results[] array, no/empty text content)
  //      isn't silently dropped.
  const fromStructured = pluckArray(structuredContent);
  if (fromStructured) {
    if (fromStructured.length) return { items: fromStructured, rawText: "" };
    // empty structured array -> fall through to text/resource blocks below
  } else if (structuredContent && typeof structuredContent === "object" && !Array.isArray(structuredContent)) {
    return { items: [structuredContent], rawText: "" };
  }
  // 2) text content blocks — often a JSON-encoded array/object.
  const texts = content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string);
  const joined = texts.join("\n");
  for (const t of texts) {
    try {
      const parsed = JSON.parse(t);
      const arr = pluckArray(parsed);
      // A text block that parses as JSON is a STRUCTURED payload, not free text:
      // its items ARE the result, so we clear rawText and never fall back to the
      // raw JSON string as a hit. An EMPTY array here (e.g. "[]") therefore yields
      // ZERO hits — not a spurious hit fabricated from the literal "[]". (Genuine
      // free-text blocks never parse as JSON, so they still reach the rawText
      // fallback in mapToHits below.)
      if (arr) return { items: arr, rawText: "" };
      if (parsed && typeof parsed === "object") return { items: [parsed], rawText: "" };
    } catch { /* not JSON, fall through */ }
  }
  // 3) resource blocks -> one item each (uri = identity)
  const resources = content
    .filter((c) => c.type === "resource" && c.resource?.uri)
    .map((c) => ({ url: c.resource!.uri, snippet: c.resource!.text ?? "" }));
  if (resources.length) return { items: resources, rawText: joined };
  return { items: [], rawText: joined };
}

function pluckArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    // Prefer the first NON-EMPTY array-valued key: a server may send an empty
    // `results` alongside a populated `matches`/`data`/… — returning the empty
    // one first would drop the real hits. Fall back to an empty array only if
    // EVERY matching key is empty (preserves empty-structured → 0 hits), and to
    // null if no array-valued key exists at all (→ single-object / text fallthrough).
    let firstEmpty: unknown[] | null = null;
    for (const key of ["results", "items", "hits", "documents", "docs", "data", "matches", "entries"]) {
      const inner = (v as Record<string, unknown>)[key];
      if (Array.isArray(inner)) {
        if (inner.length) return inner;
        if (firstEmpty === null) firstEmpty = inner;
      }
    }
    if (firstEmpty !== null) return firstEmpty;
  }
  return null;
}

function mapToHits(result: { content: McpContentBlock[]; structuredContent?: unknown }, toolName: string): ScanHit[] {
  const { items, rawText } = extractItems(result.structuredContent, result.content);
  if (items.length) {
    return items.map((it) =>
      it && typeof it === "object"
        ? objToHit(it as Record<string, unknown>, toolName)
        : objToHit({ snippet: String(it) }, toolName),
    );
  }
  if (rawText.trim()) {
    // A tool that returns free text (no JSON) -> a single hit; identity from the text.
    const firstLine = rawText.trim().split("\n")[0].slice(0, 80);
    return [{
      title: firstLine,
      url: synthUrl(toolName, rawText),
      source: "mcp",
      published: null,
      snippet: rawText.slice(0, 2000),
      mcp_tool: toolName,
    }];
  }
  return [];
}

// ---- best-effort --since recency filter ------------------------------------

/** Parse a `--since` value into an epoch-ms cutoff, or null when unparseable
 *  (the caller then IGNORES it rather than crashing). Mirrors overcast's
 *  parseSince (src/providers/memory/local.ts): a relative form
 *  `<n><s|m|h|d|w>` (30s / 30m / 24h / 7d / 2w) measured back from now, OR an
 *  absolute date string (anything Date.parse understands, e.g. 2026-06-01). */
function parseSinceCutoff(since: string): number | null {
  const rel = since.match(/^(\d+)([smhdw])$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === "s" ? 1e3 : unit === "m" ? 60e3 : unit === "h" ? 3600e3 : unit === "d" ? 86400e3 : 7 * 86400e3;
    return Date.now() - n * ms;
  }
  const abs = Date.parse(since);
  return Number.isNaN(abs) ? null : abs;
}

/** Parse a hit's `published` value to epoch-ms, or null when it can't be dated. */
function parsePublishedMs(published: unknown): number | null {
  if (typeof published !== "string" || !published.trim()) return null;
  const s = published.trim();
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  // bare epoch number: 13-digit ms, 10-digit seconds (best-effort)
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (s.length >= 13) return n;
    if (s.length === 10) return n * 1000;
  }
  return null;
}

/** BEST-EFFORT `--since` recency filter for MCP hits. overcast ALWAYS forwards
 *  `--since <val>` when a recency filter is set, so the bridge honors it too —
 *  but only as far as the tool's own data allows. Drops hits whose `published`
 *  field parses to a moment OLDER than the cutoff, and KEEPS every hit we can't
 *  date: a generic MCP tool may return no dates at all, and silently dropping
 *  undated hits would be worse than a wide filter (you'd lose real results you
 *  simply couldn't timestamp). An unparseable `--since` is ignored (hits pass
 *  through unchanged) so a bad value never crashes the scan. So `--since` only
 *  bites for tools that return dated results. */
function applySince(hits: ScanHit[], since: string | undefined): ScanHit[] {
  const raw = since?.trim();
  if (!raw) return hits;
  const cutoff = parseSinceCutoff(raw);
  if (cutoff === null) return hits; // unparseable --since -> ignore, don't crash
  return hits.filter((h) => {
    const at = parsePublishedMs(h.published);
    return at === null || at >= cutoff; // undated -> keep; else keep only if fresh
  });
}

// ---- ops -------------------------------------------------------------------

function serverCmd(): string[] | undefined {
  const raw = process.env.MCP_SERVER_CMD?.trim();
  if (!raw) return undefined;
  return tokenizeCommand(raw);
}

/** Read an optional override env: trimmed, with empty/whitespace-only treated as
 *  unset. describe and enumerate BOTH route override reads through this single
 *  code path so a padded value (e.g. MCP_SEARCH_TOOL="  search_x  ") can't make
 *  one op select a tool/query-arg while the other reports none — they must agree. */
function envOverride(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

async function connectAndList(): Promise<{ client: McpStdioClient; tools: McpTool[] }> {
  const cmd = serverCmd();
  if (!cmd || !cmd.length) {
    fail("MCP bridge needs MCP_SERVER_CMD set to a stdio MCP server command\n  e.g. MCP_SERVER_CMD='npx -y @modelcontextprotocol/server-filesystem /data'", EXIT_NEEDS_CONFIG);
  }
  const client = new McpStdioClient(cmd);
  try {
    await client.initialize();
  } catch (e) {
    client.close();
    fail(`MCP bridge could not start/initialize the server (${(e as Error).message})`, EXIT_NEEDS_CONFIG);
  }
  // If tools/list fails AFTER a good initialize, we still own the spawned server
  // process — close it before propagating so a failed listing never orphans it.
  try {
    const tools = await client.listTools();
    return { client, tools };
  } catch (e) {
    client.close();
    throw e;
  }
}

/** Enforce an EXPLICIT MCP_SEARCH_TOOL override against the live tool list. When
 *  set (trimmed, non-empty) but naming no listed tool, that's a CONFIG error
 *  (typo / stale override), NOT a "no search-shaped tool" heuristic miss — say so
 *  precisely and list what IS available, rather than the generic message that
 *  would otherwise hide the bad override. describe and enumerate BOTH route the
 *  override through this ONE check so their metadata and scan behavior can't
 *  disagree for the same env (a bad override must fail identically in both). The
 *  caller passes a `close` cb so we tear the spawned server down before failing —
 *  fail()'s process.exit skips finally blocks, so we must not orphan the child.
 *  Returns the resolved override (or undefined when unset/empty). */
function requireValidSearchToolOverride(tools: McpTool[], close: () => void): string | undefined {
  const override = envOverride("MCP_SEARCH_TOOL");
  if (override && !tools.some((t) => t.name === override)) {
    close();
    fail(`MCP bridge: MCP_SEARCH_TOOL="${override}" not found among server tools: ${tools.map((t) => t.name).join(", ") || "(none)"}`, 1);
  }
  return override;
}

/** An explicit MCP_QUERY_ARG that names no argument of the SELECTED tool is a
 *  config error (typo/stale), mirroring requireValidSearchToolOverride: fail fast
 *  rather than send the query under an unknown key, which leaves required args
 *  unset → empty scans / opaque server errors. Returns the validated override. */
function requireValidQueryArgOverride(tool: McpTool, close: () => void): string | undefined {
  const override = envOverride("MCP_QUERY_ARG");
  if (override && !(override in (tool.inputSchema?.properties ?? {}))) {
    close();
    fail(`MCP bridge: MCP_QUERY_ARG="${override}" is not an argument of tool "${tool.name}": ${Object.keys(tool.inputSchema?.properties ?? {}).join(", ") || "(none)"}`, 1);
  }
  return override;
}

async function opDescribe(): Promise<void> {
  const base = {
    source: "mcp",
    emits: "scan.hit",
    transport: "stdio-jsonrpc",
    needs: ["MCP_SERVER_CMD (stdio MCP server command)"],
    optional_env: ["MCP_SEARCH_TOOL", "MCP_QUERY_ARG", "MCP_TOOL_ARGS"],
    recency: "best-effort: --since drops only hits whose `published` parses to a date older than the cutoff; undated hits are kept, unparseable --since ignored",
  };
  const cmd = serverCmd();
  if (!cmd) {
    process.stdout.write(JSON.stringify(base) + "\n");
    return;
  }
  // Best-effort live probe; describe is metadata, so connection failure is a
  // note, not a hard error.
  const client = new McpStdioClient(cmd);
  try {
    await client.initialize();
    const tools = await client.listTools();
    // A bad EXPLICIT override is a hard config error, EXACTLY as enumerate treats
    // it — fail (non-zero, child closed) instead of silently reporting
    // selected_tool:null, which would look like a mere heuristic miss and let
    // describe's metadata disagree with enumerate's scan behavior for the same
    // env. This runs OUTSIDE the connect_error catch below (fail() exits), so a
    // genuine connect/list failure stays a soft note while a bad override is hard.
    const override = requireValidSearchToolOverride(tools, () => client.close());
    const selected = pickSearchTool(tools, override);
    process.stdout.write(JSON.stringify({
      ...base,
      server: cmd,
      server_info: client.serverInfo,
      protocol_version: client.protocolVersion,
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      selected_tool: selected?.name ?? null,
      query_arg: selected ? (pickQueryArg(selected, requireValidQueryArgOverride(selected, () => client.close())) ?? null) : null,
    }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ ...base, server: cmd, connect_error: (e as Error).message }) + "\n");
  } finally {
    client.close();
  }
}

async function opInit(): Promise<void> {
  const { client } = await connectAndList();
  client.close();
  // reaching here means initialize succeeded
}

async function opEnumerate(flags: Record<string, string>): Promise<void> {
  const query = flags.query ?? "";
  // Require a real query. A value-less `--query` now yields "" (see parseFlags),
  // and an absent one is undefined -> ""; either way we must NOT fall through and
  // search the server for the empty/sentinel text. Fail fast with a usage error
  // BEFORE spawning the server. A legitimate literal `--query true` carries the
  // value "true" (non-empty) and still passes.
  if (!query.trim()) fail("mcp-bridge enumerate requires --query <text>", 2);
  // --limit is a positive result count. Parse it so a valid number is honored and
  // floored to at least 1: `--limit 0` (and negatives) clamp to 1 — the
  // least-surprising outcome for a "give me results" scan — rather than silently
  // jumping to 10 as `Number(flags.limit) || 10` did. An absent/empty --limit, or
  // a non-numeric value (NaN), still falls back to the default 10.
  const rawLimit = flags.limit?.trim();
  const parsedLimit = rawLimit ? Number(rawLimit) : NaN;
  const limit = rawLimit && Number.isFinite(parsedLimit) ? Math.max(1, Math.floor(parsedLimit)) : 10;
  const { client, tools } = await connectAndList();
  try {
    // Shared with describe (requireValidSearchToolOverride): an explicit
    // MCP_SEARCH_TOOL that names no listed tool is a CONFIG error (typo / stale
    // override), NOT a "no search-shaped tool" condition — fail precisely, listing
    // what IS available, rather than the generic heuristic-miss message that would
    // otherwise hide the bad override. Both ops go through the one check so they
    // can't drift.
    const override = requireValidSearchToolOverride(tools, () => client.close());
    const tool = pickSearchTool(tools, override);
    if (!tool) {
      client.close();
      fail(`MCP bridge: no search-shaped tool found among [${tools.map((t) => t.name).join(", ")}]; set MCP_SEARCH_TOOL to force one`, 1);
    }
    const queryArgOverride = requireValidQueryArgOverride(tool, () => client.close());
    const queryArg = pickQueryArg(tool, queryArgOverride);
    if (!queryArg) {
      client.close();
      fail(`MCP bridge: tool "${tool.name}" exposes no string argument to carry the query (args: ${Object.keys(tool.inputSchema?.properties ?? {}).join(", ") || "none"}); force a text-taking tool/arg with MCP_SEARCH_TOOL / MCP_QUERY_ARG`, 1);
    }
    let extraArgs: Record<string, unknown> = {};
    const rawToolArgs = process.env.MCP_TOOL_ARGS?.trim();
    if (rawToolArgs) {
      // A SET-but-malformed override is a config error, not a silent no-op:
      // swallowing the parse error would drop required static args (e.g. a
      // filesystem server's `path`) while the operator believes their overrides
      // applied, handing back wrong/incomplete results. Fail fast with the parse
      // message. (An unset / empty / whitespace-only MCP_TOOL_ARGS stays a no-op.)
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawToolArgs);
      } catch (e) {
        client.close();
        fail(`MCP bridge: MCP_TOOL_ARGS is not valid JSON: ${(e as Error).message}`, 1);
      }
      // Must be a plain JSON object — an array would spread numeric keys into the
      // tool call and `null` would be silently ignored, so a malformed override
      // could still reach the server. Reject non-objects with the same fail-fast.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        client.close();
        const got = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
        fail(`MCP bridge: MCP_TOOL_ARGS must be a JSON object, got ${got}`, 1);
      }
      extraArgs = parsed as Record<string, unknown>;
    }
    const args: Record<string, unknown> = { ...extraArgs, [queryArg]: query };
    const result = await client.callTool(tool.name, args);
    if (result.isError) {
      client.close();
      const txt = result.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 300);
      fail(`MCP tool ${tool.name} returned an error: ${txt}`, 1);
    }
    // Map ALL hits, THEN apply best-effort --since recency filtering, THEN the
    // --limit slice. Filtering runs BEFORE the slice so a fresh hit isn't
    // starved by older ones the limit would otherwise have kept. overcast's
    // enumerateSource always forwards --since when a recency filter is set;
    // applySince honors it as far as the tool dates its results (undated hits
    // are kept, an unparseable --since is ignored — see applySince).
    const all = mapToHits(result, tool.name);
    const recent = applySince(all, flags.since);
    const hits = recent.slice(0, limit);
    process.stdout.write(JSON.stringify(hits) + "\n");
  } finally {
    client.close();
  }
}

/** Is a RESOLVED IP address private/loopback/link-local (incl. the 169.254.169.254
 *  cloud-metadata endpoint)? Checked against the addresses `dns.lookup` returns —
 *  the same getaddrinfo the socket uses — so any inet_aton encoding the resolver
 *  accepts is covered by its normalized result. */
function isPrivateIp(addr: string): boolean {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 0 || a === 127 || a === 10 ||                 // this-net, loopback, RFC1918 10/8
      (a === 172 && b >= 16 && b <= 31) ||                // RFC1918 172.16/12
      (a === 192 && b === 168) ||                         // RFC1918 192.168/16
      (a === 169 && b === 254) ||                         // link-local 169.254/16 (metadata)
      (a === 100 && b >= 64 && b <= 127)                  // CGNAT 100.64/10
    );
  }
  const h = addr.toLowerCase().replace(/%.*$/, ""); // strip IPv6 zone id
  if (h === "::1" || h === "::") return true;             // loopback / unspecified
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
  if (h.startsWith("fe80")) return true;                  // link-local
  if (h.startsWith("::ffff:")) return isPrivateIp(h.slice(7)); // IPv4-mapped IPv6
  return false;
}

/** SSRF guard for opFetch: an MCP tool result is UNTRUSTED (invariant #10), so a
 *  server-supplied URL (or a redirect it triggers) must not reach loopback/RFC1918/
 *  link-local/metadata hosts. Mirrors core `assertFetchHostAllowed`: resolve every
 *  A/AAAA record and reject if ANY is private (defeats DNS rebinding); fail CLOSED
 *  if the host can't be resolved. Opt out with an affirmative OVERCAST_ALLOW_PRIVATE_FETCH. */
async function assertPublicHost(host: string): Promise<void> {
  if (/^(1|true|yes|on)$/i.test((process.env.OVERCAST_ALLOW_PRIVATE_FETCH ?? "").trim())) return;
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) {
    throw new Error(`MCP bridge fetch: refusing a private/loopback host (${host}); set OVERCAST_ALLOW_PRIVATE_FETCH=1 to allow`);
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dnsLookup(h, { all: true });
  } catch {
    // fail closed: if we can't resolve to verify, don't fetch — the socket would
    // resolve independently and could still reach a private address.
    throw new Error(`MCP bridge fetch: could not resolve host to verify it is public (${host})`);
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new Error(`MCP bridge fetch: refusing a private/loopback address (${host} → ${address}); set OVERCAST_ALLOW_PRIVATE_FETCH=1 to allow`);
    }
  }
}

/** best-effort fetch: HTTPS/HTTP download of a real hit URL (synthetic
 *  mcp:// identities can't be downloaded — report that clearly). */
function opFetch(flags: Record<string, string>): Promise<void> {
  const url = flags.url ?? "";
  const out = flags.out ?? "";
  if (!url || !out) fail("MCP bridge fetch needs --url and --out", 2);
  if (url.startsWith("mcp://")) {
    fail(`MCP bridge fetch: hit ${url} is a synthetic identity (the tool result carried no downloadable URL); nothing to fetch`, 1);
  }
  if (!/^https?:\/\//.test(url)) fail(`MCP bridge fetch: unsupported URL scheme for ${url}`, 1);

  const MAX_REDIRECTS = 5;

  return new Promise<void>((resolve, reject) => {
    let fileStarted = false;
    // On any failure, drop a half-written output file so a partial download is
    // never mistaken for a complete capture, then reject fast (never hang).
    const cleanupAndReject = (msg: string): void => {
      if (fileStarted) unlink(out, () => reject(new Error(msg)));
      else reject(new Error(msg));
    };

    const doGet = async (target: string, hop: number): Promise<void> => {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        reject(new Error(`MCP bridge fetch: invalid URL ${target}`));
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        reject(new Error(`MCP bridge fetch: unsupported URL scheme for ${target}`));
        return;
      }
      // SSRF guard on EVERY hop (the initial URL and each redirect target) —
      // an untrusted MCP result could point at loopback/RFC1918/metadata.
      try {
        await assertPublicHost(parsed.hostname);
      } catch (e) {
        reject(e as Error);
        return;
      }
      const getter = parsed.protocol === "https:" ? httpsGet : httpGet;
      const req = getter(target, (res) => {
        const status = res.statusCode ?? 0;
        // Node types Location as a string but can DELIVER it as string[] for a
        // repeated header — passing an array straight to new URL() yields an
        // invalid URL and would wrongly reject a followable redirect. Normalize to
        // a single string first; an empty/absent array collapses to undefined and
        // falls through to the non-followable-3xx error path below.
        const rawLocation: string | string[] | undefined = res.headers.location;
        const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
        // Follow 3xx redirects (like `curl -fsSL`), bounded to MAX_REDIRECTS hops.
        if (status >= 300 && status < 400 && location) {
          res.resume(); // drain the redirect body so the socket can close
          if (hop >= MAX_REDIRECTS) {
            reject(new Error(`MCP bridge fetch: too many redirects (> ${MAX_REDIRECTS}) starting at ${url}`));
            return;
          }
          let next: string;
          try {
            // resolve relative Location headers against the current URL
            next = new URL(location, target).toString();
          } catch {
            reject(new Error(`MCP bridge fetch: invalid redirect Location '${location}' from ${target}`));
            return;
          }
          doGet(next, hop + 1).catch(reject);
          return;
        }
        // Only stream a 2xx body to disk; anything else (incl. an unresolvable
        // 3xx with no Location) is a hard error rather than a written page.
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`MCP bridge fetch: HTTP ${status} for ${target}`));
          return;
        }
        const file = createWriteStream(out);
        fileStarted = true;
        // Handle errors on BOTH streams so a mid-transfer failure fails fast
        // instead of leaving the promise pending forever.
        file.on("error", (e) => cleanupAndReject(`MCP bridge fetch: write failed for ${out}: ${e.message}`));
        res.on("error", (e) => cleanupAndReject(`MCP bridge fetch failed mid-transfer for ${target}: ${e.message}`));
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            process.stdout.write(JSON.stringify({ kind: "page", path: out, source: "mcp", url }) + "\n");
            resolve();
          });
        });
      });
      req.on("error", (e) => cleanupAndReject(`MCP bridge fetch failed for ${target}: ${e.message}`));
      req.setTimeout(60_000, () => { req.destroy(new Error("timeout")); });
    };

    doGet(url, 0).catch(reject);
  });
}

// ---- entry -----------------------------------------------------------------

async function main(): Promise<void> {
  const [, , op, ...rest] = process.argv;
  const flags = parseFlags(rest);
  switch (op) {
    case "describe": await opDescribe(); break;
    case "init": await opInit(); break;
    case "enumerate": await opEnumerate(flags); break;
    case "fetch": await opFetch(flags); break;
    default:
      fail(`mcp-bridge: unknown op '${op ?? ""}' (expected enumerate|fetch|init|describe)`, 2);
  }
  process.exit(0);
}

main().catch((e) => fail(`mcp-bridge fatal: ${(e as Error).message}`, 1));
