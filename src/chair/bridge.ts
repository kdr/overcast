// The chair bridge: a token-authenticated node:http + SSE server that exposes
// the live agent session to the phone console (see src/chair/wire.ts for the
// contract). Deliberately pi-free — the extension glue (src/extension/chair.ts)
// hands in a ChairAgent, so the bridge is unit-testable against a fake.
//
// Security posture (CLAUDE.md invariant #10 — remote input is untrusted):
// 256-bit bearer token compared in constant time, bind 127.0.0.1 by default
// (tailnet opt-in), no TLS in v1 (Tailscale/SSH tunnel provides transport
// encryption), no request logging, Origin↔Host check on POSTs, static assets
// unauthenticated but secret-free. Restarting the chair rotates the token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type {
  CaseGlance,
  ChairPromptBody,
  ChairPromptResult,
  ChairSnapshot,
  ChairWireEvent,
  TranscriptItem,
} from "./wire.js";

/** Everything the bridge needs from the live session — implemented over the pi
 *  extension context in src/extension/chair.ts, or a plain fake in tests. */
export interface ChairAgent {
  isIdle(): boolean;
  abort(): void;
  sendUserMessage(text: string, opts?: { deliverAs?: "steer" | "followUp" }): void;
  model(): string | undefined;
  sessionName(): string | undefined;
  /** Live case identity (follows --case / a session switch) — read per request
   *  so a long-running bridge never reports a stale case in the snapshot. */
  caseName(): string;
  caseDir(): string;
  transcript(limit: number): TranscriptItem[];
  caseGlance(): CaseGlance;
  /** Text of the in-flight assistant message, "" when none — lets a mid-stream
   *  resync rebuild the live line (getBranch only holds finalized messages). */
  livePartial?(): string;
  /** Surface a remote prompt in the desk TUI (notify), if a UI is attached. */
  onRemotePrompt?(info: { mode: ChairPromptResult["delivered"]; chars: number }): void;
}

export interface ChairBridgeOptions {
  agent: ChairAgent;
  profile: string;
  version: string;
  /** Bind address; default loopback. Never bind wildcard unless asked to. */
  bind?: string;
  /** 0 = ephemeral (tests). Default 7373. */
  port?: number;
  /** Pinned token (OVERCAST_CHAIR_TOKEN); default = fresh 32 random bytes. */
  token?: string;
  /** Built console dir; when absent the inline fallback page is served. */
  assetsDir?: string;
  ringSize?: number;
}

type ChairEventInput = ChairWireEvent extends infer E ? (E extends ChairWireEvent ? Omit<E, "seq"> : never) : never;

const DEFAULT_PORT = 7373;
const DEFAULT_BIND = "127.0.0.1";
const RING_SIZE = 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROMPT_CHARS = 16 * 1024;
const HEARTBEAT_MS = 25_000;
const TRANSCRIPT_LIMIT = 50;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export class ChairBridge {
  private readonly agent: ChairAgent;
  private readonly opts: ChairBridgeOptions;
  private readonly token: string;
  private readonly ringSize: number;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Set<ServerResponse>();
  private readonly ring: { seq: number; json: string }[] = [];
  private lastSeq = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private boundPort = 0;

  constructor(opts: ChairBridgeOptions) {
    this.agent = opts.agent;
    this.opts = opts;
    this.token = opts.token || randomBytes(32).toString("base64url");
    this.ringSize = opts.ringSize ?? RING_SIZE;
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  clientCount(): number {
    return this.clients.size;
  }

  get port(): number {
    return this.boundPort;
  }

  get bind(): string {
    return this.opts.bind || DEFAULT_BIND;
  }

  /** Base URL (no token). */
  get url(): string {
    return `http://${this.bind}:${this.boundPort}/`;
  }

  /** URL with the token in the FRAGMENT — never sent to any server or log. */
  get pairingUrl(): string {
    return `${this.url}#t=${this.token}`;
  }

  async start(): Promise<{ url: string; pairingUrl: string; port: number }> {
    if (this.server) throw new Error("chair bridge already running");
    const server = createServer((req, res) => {
      try {
        this.route(req, res);
      } catch {
        this.json(res, 500, { error: "internal error" });
      }
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port ?? DEFAULT_PORT, this.bind, () => {
        server.removeListener("error", reject);
        resolvePromise();
      });
    });
    const addr = server.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : (this.opts.port ?? DEFAULT_PORT);
    this.server = server;
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) this.safeWrite(res, ": ping\n\n");
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
    return { url: this.url, pairingUrl: this.pairingUrl, port: this.boundPort };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
  }

  /** Stamp a seq, remember it for replay, fan out to connected consoles. */
  publish(evt: ChairEventInput): void {
    const seq = ++this.lastSeq;
    const json = JSON.stringify({ ...evt, seq });
    this.ring.push({ seq, json });
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    for (const res of this.clients) this.safeWrite(res, `id: ${seq}\ndata: ${json}\n\n`);
  }

  /** Tell one client its cursor is unusable — it should refetch /api/state. */
  private gap(res: ServerResponse): void {
    this.safeWrite(res, `id: ${this.lastSeq}\ndata: ${JSON.stringify({ type: "gap", seq: this.lastSeq })}\n\n`);
  }

  /** Write to one SSE client, dropping it on error (a half-closed phone must
   *  never throw out of a pi event handler mid-stream). */
  private safeWrite(res: ServerResponse, chunk: string): void {
    try {
      res.write(chunk);
    } catch {
      this.clients.delete(res);
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
  }

  // --- request handling -------------------------------------------------------

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (path === "/events") {
      if (!this.authorized(req, url)) return this.json(res, 401, { error: "unauthorized" });
      return this.handleEvents(req, res, url);
    }
    if (path.startsWith("/api/")) {
      if (!this.authorized(req, url)) return this.json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && path === "/api/state") return this.json(res, 200, this.snapshot());
      if (req.method === "GET" && path === "/api/case") return this.json(res, 200, this.agent.caseGlance());
      if (req.method === "POST") {
        if (!this.originOk(req)) return this.json(res, 403, { error: "origin mismatch" });
        if (path === "/api/abort") {
          this.agent.abort();
          return this.json(res, 200, { ok: true });
        }
        if (path === "/api/prompt") return void this.handlePrompt(req, res);
      }
      return this.json(res, 404, { error: "not found" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return this.json(res, 405, { error: "method not allowed" });
    return this.serveStatic(path, res);
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.clients.add(res);
    this.safeWrite(res, ": chair\n\n");
    // catch-up: replay what the client missed, or tell it to resync.
    const sinceRaw = req.headers["last-event-id"] ?? url.searchParams.get("since") ?? "";
    const since = Number(Array.isArray(sinceRaw) ? sinceRaw[0] : sinceRaw);
    if (Number.isFinite(since) && since > 0) {
      if (since > this.lastSeq) {
        // client is AHEAD of us — the bridge restarted and reset its sequence
        // (e.g. /chair off+on with a pinned token). Its transcript is stale, so
        // force a full resync rather than silently dropping into the new stream.
        this.gap(res);
      } else if (since < this.lastSeq) {
        const oldest = this.ring[0]?.seq ?? this.lastSeq + 1;
        if (since < oldest - 1) this.gap(res); // missed events fell out of the ring
        else for (const item of this.ring) if (item.seq > since) this.safeWrite(res, `id: ${item.seq}\ndata: ${item.json}\n\n`);
      }
      // since === lastSeq: client is current, nothing to replay
    }
    // per-connection hello (not published: each client gets its own counts)
    const hello: ChairWireEvent = {
      type: "hello",
      seq: this.lastSeq,
      caseName: this.agent.caseName(),
      session: this.agent.sessionName(),
      model: this.agent.model(),
      busy: !this.agent.isIdle(),
      clients: this.clients.size,
      version: this.opts.version,
    };
    this.safeWrite(res, `data: ${JSON.stringify(hello)}\n\n`);
    req.on("close", () => {
      this.clients.delete(res);
    });
  }

  private async handlePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: ChairPromptBody;
    try {
      body = JSON.parse(await readBody(req)) as ChairPromptBody;
    } catch (e) {
      return this.json(res, 400, { error: (e as Error).message || "bad request" });
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return this.json(res, 400, { error: "text required" });
    if (text.length > MAX_PROMPT_CHARS) return this.json(res, 413, { error: "prompt too long" });
    const mode = body.mode ?? "auto";
    if (mode !== "auto" && mode !== "steer" && mode !== "followUp") {
      return this.json(res, 400, { error: "mode must be auto|steer|followUp" });
    }
    // idle → new turn; busy → must pick a queue lane (steer unless told followUp)
    const busy = !this.agent.isIdle();
    const lane: "steer" | "followUp" | undefined = busy ? (mode === "followUp" ? "followUp" : "steer") : undefined;
    const delivered: ChairPromptResult["delivered"] = lane ?? "turn";
    try {
      this.agent.sendUserMessage(text, lane ? { deliverAs: lane } : undefined);
    } catch (e) {
      return this.json(res, 500, { error: (e as Error).message || "send failed" });
    }
    this.agent.onRemotePrompt?.({ mode: delivered, chars: text.length });
    // 202: sendUserMessage is fire-and-forget; the console observes the outcome
    // (or an error notice) on the event stream, so this only means "queued".
    this.json(res, 202, { delivered } satisfies ChairPromptResult);
  }

  private snapshot(): ChairSnapshot {
    const live = this.agent.livePartial?.() ?? "";
    return {
      seq: this.lastSeq,
      busy: !this.agent.isIdle(),
      session: this.agent.sessionName(),
      model: this.agent.model(),
      caseName: this.agent.caseName(),
      caseDir: this.agent.caseDir(),
      profile: this.opts.profile,
      clients: this.clients.size,
      version: this.opts.version,
      transcript: this.agent.transcript(TRANSCRIPT_LIMIT),
      ...(live ? { live } : {}),
    };
  }

  private serveStatic(path: string, res: ServerResponse): void {
    const dir = this.opts.assetsDir;
    if (!dir) {
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return void res.end(FALLBACK_PAGE);
      }
      return this.json(res, 404, { error: "not found" });
    }
    const root = resolve(dir);
    let rel: string;
    try {
      rel = decodeURIComponent(path).replace(/^\/+/, "");
    } catch {
      return this.json(res, 400, { error: "bad path" });
    }
    const file = resolve(root, rel === "" ? "index.html" : rel);
    // traversal guard: the resolved path must stay inside the assets dir
    if (file !== root && !file.startsWith(root + sep)) return this.json(res, 404, { error: "not found" });
    if (!existsSync(file) || !statSync(file).isFile()) return this.json(res, 404, { error: "not found" });
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(readFileSync(file));
  }

  // --- auth --------------------------------------------------------------------

  private tokenOk(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    // hash both sides to constant length, then constant-time compare
    const a = createHash("sha256").update(candidate).digest();
    const b = createHash("sha256").update(this.token).digest();
    return timingSafeEqual(a, b);
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) return this.tokenOk(header.slice(7).trim());
    // EventSource can't set headers — the SSE GET carries ?token= instead
    return this.tokenOk(url.searchParams.get("token"));
  }

  /** Cheap CSRF belt: browsers always send Origin on cross-origin POSTs. */
  private originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin === "") return true; // non-browser client
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
  }
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// The zero-build console: served when the vite bundle isn't shipped (e.g. a bun
// sidecar copy went missing). Spartan but fully functional — stream, prompt,
// steer/follow-up, abort. Contains no secrets; the token arrives via the URL
// fragment and lives only in the browser.
const FALLBACK_PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>overcast — man in the chair</title>
<style>
  body { background:#0a0f0a; color:#9fdf9f; font:14px/1.45 ui-monospace,Menlo,monospace; margin:0; display:flex; flex-direction:column; height:100dvh; }
  header { padding:8px 12px; border-bottom:1px solid #1e3320; color:#e0ffe0; display:flex; gap:10px; align-items:baseline; }
  header .busy { color:#ffb347; }
  #log { flex:1; overflow-y:auto; padding:12px; white-space:pre-wrap; word-break:break-word; }
  .u { color:#7fd4ff; } .t { color:#8a8f8a; } .n { color:#ffb347; } .th { color:#5a705a; font-style:italic; }
  form { display:flex; gap:6px; padding:10px 12px; border-top:1px solid #1e3320; }
  input,select,button { background:#101810; color:#cfe; border:1px solid #2e4d30; border-radius:4px; padding:8px; font:inherit; }
  input { flex:1; min-width:0; }
  #abort { color:#ff6b6b; border-color:#5d2626; }
</style>
<header><strong>◉ CHAIR</strong><span id="case"></span><span id="state" class="busy"></span></header>
<div id="log"></div>
<form id="f">
  <input id="text" placeholder="message the desk…" autocomplete="off">
  <select id="mode"><option value="auto">auto</option><option value="steer">steer</option><option value="followUp">follow-up</option></select>
  <button type="submit">send</button>
  <button type="button" id="abort">abort</button>
</form>
<script>
  const token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
  const log = document.getElementById("log");
  const add = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; };
  const api = (path, body) => fetch(path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  let live = "";
  api("/api/state").then(r => r.json()).then(s => {
    document.getElementById("case").textContent = "case://" + s.caseName;
    for (const item of s.transcript) add(item.role === "user" ? "u" : item.role === "tool" ? "t" : "", (item.role === "user" ? "❯ " : item.role === "tool" ? "⚙ " + (item.toolName || "tool") + " " : "") + item.text);
    if (s.live) { live = s.live; render(); } // seed the in-flight assistant line
  }).catch(() => add("n", "state fetch failed — check the token"));
  const es = new EventSource("/events?token=" + encodeURIComponent(token));
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === "delta" && e.kind === "text") { live += e.text; render(); }
    if (e.type === "delta" && e.kind === "thinking") { /* keep the live line clean */ }
    if (e.type === "message" && e.phase === "end" && e.role === "assistant") { live = ""; render(); add("", e.text || ""); }
    if (e.type === "message" && e.phase === "start" && e.role === "user") add("u", "❯ " + (e.text || ""));
    if (e.type === "tool") { if (e.phase === "start") add("t", "⚙ " + e.name); if (e.phase === "end" && e.isError) add("n", "⚠ " + e.name + " failed"); }
    if (e.type === "state" || e.type === "hello" || e.type === "agent") document.getElementById("state").textContent = (e.busy || (e.type === "agent" && e.phase === "start")) ? "● working" : "";
    if (e.type === "notice") add("n", e.text);
    if (e.type === "gap") location.reload();
  };
  let liveEl = null;
  const render = () => {
    if (!liveEl) { liveEl = document.createElement("div"); log.appendChild(liveEl); }
    liveEl.textContent = live; log.scrollTop = log.scrollHeight;
    if (!live) { liveEl.remove(); liveEl = null; }
  };
  document.getElementById("f").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = document.getElementById("text").value.trim();
    if (!text) return;
    api("/api/prompt", { text, mode: document.getElementById("mode").value }).then(r => { if (!r.ok) add("n", "send failed (" + r.status + ")"); });
    document.getElementById("text").value = "";
  });
  document.getElementById("abort").addEventListener("click", () => api("/api/abort"));
</script>`;
