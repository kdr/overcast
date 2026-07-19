// The shared live-server core: a token-authenticated node:http + SSE server,
// extracted from the chair bridge so the situation server (src/situation/) and
// the chair (src/chair/bridge.ts) share ONE implementation of the
// security-sensitive machinery — token auth, ring-buffer replay, CSRF origin
// check, guarded static serving, socket lifecycle. Subclasses add their routes
// (`routeApi`/`routeExtra`) and their per-connection hello event; they must not
// re-implement any of the below.
//
// Security posture (CLAUDE.md invariant #10 — remote input is untrusted):
// 256-bit bearer token compared in constant time, bind 127.0.0.1 by default
// (tailnet opt-in), no TLS in v1 (Tailscale/SSH tunnel provides transport
// encryption), no request logging, Origin↔Host check on POSTs, static assets
// unauthenticated but secret-free. Restarting a server rotates its token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { realpathContained } from "../fs-path.js";

export interface LiveHttpdOptions {
  /** Bind address; default loopback. Never bind wildcard unless asked to. */
  bind?: string;
  /** 0 = ephemeral (tests). Default = the subclass's defaultPort. */
  port?: number;
  /** Pinned token (an OVERCAST_*_TOKEN env); default = fresh 32 random bytes. */
  token?: string;
  /** Built console dir; when absent the subclass's fallback page is served. */
  assetsDir?: string;
  /** Externally-reachable base URL (e.g. an HTTPS `tailscale serve` origin).
   *  When set, the pairing QR points here instead of the raw http bind. */
  publicUrl?: string;
  ringSize?: number;
}

/** Internal knobs the concrete server supplies alongside the user options. */
export interface LiveHttpdConfig {
  /** SSE stream comment label + error prose ("chair", "situation"). */
  label: string;
  /** Port used when opts.port is unset (chair 7373, situation 7374). */
  defaultPort: number;
}

export const MAX_BODY_BYTES = 64 * 1024;

const DEFAULT_BIND = "127.0.0.1";
const RING_SIZE = 1000;
const HEARTBEAT_MS = 25_000;

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

/** Media containers/images the situation media route may serve, with mimes the
 *  browser can decode. Kept here beside CONTENT_TYPES so the two tables (assets
 *  vs case media) stay side by side. */
export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

export abstract class LiveHttpd<EIn extends object = Record<string, unknown>> {
  protected readonly httpd: LiveHttpdOptions;
  private readonly config: LiveHttpdConfig;
  private readonly token: string;
  private readonly ringSize: number;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Set<ServerResponse>();
  private readonly ring: { seq: number; json: string }[] = [];
  private lastSeq = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private boundPort = 0;

  protected constructor(opts: LiveHttpdOptions, config: LiveHttpdConfig) {
    this.httpd = opts;
    this.config = config;
    this.token = opts.token || randomBytes(32).toString("base64url");
    this.ringSize = opts.ringSize ?? RING_SIZE;
  }

  // --- subclass surface --------------------------------------------------------

  /** Handle an authenticated `/api/*` request (Origin already checked on POSTs).
   *  Return true when handled; false → 404. */
  protected abstract routeApi(req: IncomingMessage, res: ServerResponse, url: URL): boolean;

  /** Per-connection SSE hello (not published/ring-buffered: each client gets its
   *  own). Return undefined to skip. Include `seq: this.seq` so late joiners
   *  know where the stream stands. */
  protected abstract helloEvent(): Record<string, unknown> | undefined;

  /** Non-API custom routes (e.g. the situation `/media/*`), tried after `/api/*`
   *  and before static assets. Return true when handled. Auth is the handler's
   *  own responsibility (use `this.authorized(req, url)`). */
  protected routeExtra(_req: IncomingMessage, _res: ServerResponse, _url: URL): boolean {
    return false;
  }

  /** Inline page served at `/` when no assetsDir is configured (a broken build /
   *  missing sidecar). Default: none → 404. */
  protected fallbackPage(): string | undefined {
    return undefined;
  }

  // --- identity ------------------------------------------------------------------

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
    return this.httpd.bind || DEFAULT_BIND;
  }

  /** Raw bind URL (no token). */
  get url(): string {
    return `http://${this.bind}:${this.boundPort}/`;
  }

  /** The URL a remote browser should open — the public HTTPS origin when one is
   *  configured (secure context), else the raw http bind. */
  get displayUrl(): string {
    return this.httpd.publicUrl || this.url;
  }

  /** True when pairing over a secure (HTTPS) origin. */
  get secure(): boolean {
    return /^https:\/\//i.test(this.displayUrl);
  }

  /** URL with the token in the FRAGMENT — never sent to any server or log. */
  get pairingUrl(): string {
    return `${this.displayUrl}#t=${this.token}`;
  }

  /** The current stream sequence (for subclass hello/snapshot payloads). */
  protected get seq(): number {
    return this.lastSeq;
  }

  // --- lifecycle -----------------------------------------------------------------

  async start(): Promise<{ url: string; pairingUrl: string; port: number }> {
    if (this.server) throw new Error(`${this.config.label} server already running`);
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
      server.listen(this.httpd.port ?? this.config.defaultPort, this.bind, () => {
        server.removeListener("error", reject);
        resolvePromise();
      });
    });
    const addr = server.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : (this.httpd.port ?? this.config.defaultPort);
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

  // --- SSE -------------------------------------------------------------------------

  /** Stamp a seq, remember it for replay, fan out to connected consoles. */
  publish(evt: EIn): void {
    const seq = ++this.lastSeq;
    const json = JSON.stringify({ ...evt, seq });
    this.ring.push({ seq, json });
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    for (const res of this.clients) this.safeWrite(res, `id: ${seq}\ndata: ${json}\n\n`);
  }

  /** Tell one client its cursor is unusable — it should refetch the snapshot. */
  private gap(res: ServerResponse): void {
    this.safeWrite(res, `id: ${this.lastSeq}\ndata: ${JSON.stringify({ type: "gap", seq: this.lastSeq })}\n\n`);
  }

  /** Write to one SSE client, dropping it on error (a half-closed client must
   *  never throw out of the caller mid-stream). */
  protected safeWrite(res: ServerResponse, chunk: string): void {
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

  private handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.clients.add(res);
    this.safeWrite(res, `: ${this.config.label}\n\n`);
    // catch-up: replay what the client missed, or tell it to resync.
    const sinceRaw = req.headers["last-event-id"] ?? url.searchParams.get("since") ?? "";
    const since = Number(Array.isArray(sinceRaw) ? sinceRaw[0] : sinceRaw);
    if (Number.isFinite(since) && since > 0) {
      if (since > this.lastSeq) {
        // client is AHEAD of us — the server restarted and reset its sequence
        // (e.g. off+on with a pinned token). Its state is stale, so force a full
        // resync rather than silently dropping into the new stream.
        this.gap(res);
      } else if (since < this.lastSeq) {
        const oldest = this.ring[0]?.seq ?? this.lastSeq + 1;
        if (since < oldest - 1) this.gap(res); // missed events fell out of the ring
        else for (const item of this.ring) if (item.seq > since) this.safeWrite(res, `id: ${item.seq}\ndata: ${item.json}\n\n`);
      }
      // since === lastSeq: client is current, nothing to replay
    }
    const hello = this.helloEvent();
    if (hello) this.safeWrite(res, `data: ${JSON.stringify(hello)}\n\n`);
    req.on("close", () => {
      this.clients.delete(res);
    });
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
      if (req.method === "POST" && !this.originOk(req)) return this.json(res, 403, { error: "origin mismatch" });
      if (this.routeApi(req, res, url)) return;
      return this.json(res, 404, { error: "not found" });
    }
    if (this.routeExtra(req, res, url)) return;
    if (req.method !== "GET" && req.method !== "HEAD") return this.json(res, 405, { error: "method not allowed" });
    return this.serveStatic(path, res);
  }

  private serveStatic(path: string, res: ServerResponse): void {
    const dir = this.httpd.assetsDir;
    if (!dir) {
      const page = this.fallbackPage();
      if (page && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return void res.end(page);
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
    // symlink-safe: a link inside the assets dir must not serve a file outside it
    if (!realpathContained(root, file)) return this.json(res, 404, { error: "not found" });
    // Open ONCE, then stat and read THAT descriptor. The old exists → stat → read
    // sequence re-resolved the path three times, so a symlink swapped in after the
    // containment check could get served from outside the root (CodeQL
    // js/file-system-race). A held fd is immune: it points at the inode we checked.
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch {
      return this.json(res, 404, { error: "not found" });
    }
    try {
      if (!fstatSync(fd).isFile()) return this.json(res, 404, { error: "not found" });
      const body = readFileSync(fd);
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } finally {
      closeSync(fd);
    }
  }

  // --- auth --------------------------------------------------------------------

  private tokenOk(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    // hash both sides to constant length, then constant-time compare
    const a = createHash("sha256").update(candidate).digest();
    const b = createHash("sha256").update(this.token).digest();
    return timingSafeEqual(a, b);
  }

  protected authorized(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) return this.tokenOk(header.slice(7).trim());
    // EventSource / <video src> can't set headers — GETs carry ?token= instead
    return this.tokenOk(url.searchParams.get("token"));
  }

  /** Cheap CSRF belt: browsers always send Origin on cross-origin POSTs. */
  protected originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin === "") return true; // non-browser client
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  protected json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
  }
}

export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
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
