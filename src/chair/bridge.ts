// The chair bridge: a token-authenticated node:http + SSE server that exposes
// the live agent session to the phone console (see src/chair/wire.ts for the
// contract). Deliberately pi-free — the extension glue (src/extension/chair.ts)
// hands in a ChairAgent, so the bridge is unit-testable against a fake.
//
// The transport/auth/replay machinery lives in the shared live-server core
// (src/live/httpd.ts — token compare, SSE ring buffer, Origin CSRF check,
// guarded static serving), shared with the situation server so the
// security-sensitive code exists exactly once. This file is the chair's routes
// + session semantics only.

import type { IncomingMessage, ServerResponse } from "node:http";
import { LiveHttpd, readBody, type LiveHttpdOptions } from "../live/httpd.js";
import type {
  CaseGlance,
  ChairPromptBody,
  ChairPromptResult,
  ChairSnapshot,
  ChairWireEvent,
  RunningTool,
  TranscriptItem,
} from "./wire.js";

/** Everything the bridge needs from the live session — implemented over the pi
 *  extension context in src/extension/chair.ts, or a plain fake in tests. */
export interface ChairAgent {
  isIdle(): boolean;
  /** True when pi has queued messages not yet picked up by the loop — an
   *  `auto` remote prompt should join that queue, not start a competing turn. */
  hasPending(): boolean;
  abort(): void;
  sendUserMessage(text: string, opts?: { deliverAs?: "steer" | "followUp" }): void;
  model(): string | undefined;
  sessionName(): string | undefined;
  /** Live case identity (follows --case / a session switch) — read per request
   *  so a long-running bridge never reports a stale case in the snapshot. */
  caseName(): string;
  caseDir(): string;
  transcript(limit: number): TranscriptItem[];
  caseGlance(): CaseGlance | Promise<CaseGlance>;
  /** Text of the in-flight assistant message, "" when none — lets a mid-stream
   *  resync rebuild the live line (getBranch only holds finalized messages). */
  livePartial?(): string;
  /** Tools currently running (started, not yet ended) — re-registered by a
   *  resyncing console so their end events still land. */
  runningTools?(): RunningTool[];
  /** Surface a remote prompt in the desk TUI (notify), if a UI is attached. */
  onRemotePrompt?(info: { mode: ChairPromptResult["delivered"]; chars: number }): void;
}

export interface ChairBridgeOptions extends LiveHttpdOptions {
  agent: ChairAgent;
  profile: string;
  version: string;
}

type ChairEventInput = ChairWireEvent extends infer E ? (E extends ChairWireEvent ? Omit<E, "seq"> : never) : never;

const DEFAULT_PORT = 7373;
const MAX_PROMPT_CHARS = 16 * 1024;
const TRANSCRIPT_LIMIT = 50;

export class ChairBridge extends LiveHttpd<ChairEventInput> {
  private readonly agent: ChairAgent;
  private readonly opts: ChairBridgeOptions;

  constructor(opts: ChairBridgeOptions) {
    super(opts, { label: "chair", defaultPort: DEFAULT_PORT });
    this.agent = opts.agent;
    this.opts = opts;
  }

  // --- request handling -------------------------------------------------------

  protected routeApi(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/state") {
      this.json(res, 200, this.snapshot());
      return true;
    }
    if (req.method === "GET" && path === "/api/case") {
      // caseGlance may be async (it verifies a live situation page's port) — the
      // route stays sync-return, resolving the promise then answering.
      void Promise.resolve(this.agent.caseGlance())
        .then((g) => this.json(res, 200, g))
        .catch(() => {
          try {
            this.json(res, 500, { error: "glance failed" });
          } catch {
            /* headers already sent */
          }
        });
      return true;
    }
    if (req.method === "POST") {
      if (path === "/api/abort") {
        this.agent.abort();
        this.json(res, 200, { ok: true });
        return true;
      }
      if (path === "/api/prompt") {
        void this.handlePrompt(req, res).catch(() => {
          try {
            this.json(res, 500, { error: "internal error" });
          } catch {
            /* headers already sent — nothing to salvage */
          }
        });
        return true;
      }
    }
    return false;
  }

  // per-connection hello (not published: each client gets its own counts)
  protected helloEvent(): Record<string, unknown> {
    const hello: ChairWireEvent = {
      type: "hello",
      seq: this.seq,
      caseName: this.agent.caseName(),
      session: this.agent.sessionName(),
      model: this.agent.model(),
      busy: !this.agent.isIdle(),
      clients: this.clientCount(),
      version: this.opts.version,
    };
    return hello;
  }

  protected fallbackPage(): string {
    return FALLBACK_PAGE;
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
    // Route the injection:
    //  - explicit steer/followUp → honor the operator's choice (they picked it
    //    in the composer), even when idle — pi ignores deliverAs when it's not
    //    streaming, so it's safe and the report matches what they asked for
    //  - auto + streaming        → steer (interrupt the run)
    //  - auto + idle but queued  → followUp: join the pending queue, don't start
    //    a competing turn while pi still has follow-ups
    //  - auto + truly idle       → a fresh turn (no deliverAs)
    let lane: "steer" | "followUp" | undefined;
    if (mode === "steer" || mode === "followUp") lane = mode;
    else if (!this.agent.isIdle()) lane = "steer";
    else if (this.agent.hasPending()) lane = "followUp";
    const delivered: ChairPromptResult["delivered"] = lane ?? "turn";
    try {
      this.agent.sendUserMessage(text, lane ? { deliverAs: lane } : undefined);
    } catch (e) {
      return this.json(res, 500, { error: (e as Error).message || "send failed" });
    }
    try {
      this.agent.onRemotePrompt?.({ mode: delivered, chars: text.length });
    } catch {
      /* a UI-notify failure must not fail the (already delivered) prompt */
    }
    // 202: sendUserMessage is fire-and-forget; the console observes the outcome
    // (or an error notice) on the event stream, so this only means "queued".
    this.json(res, 202, { delivered } satisfies ChairPromptResult);
  }

  private snapshot(): ChairSnapshot {
    const live = this.agent.livePartial?.() ?? "";
    const running = this.agent.runningTools?.() ?? [];
    return {
      seq: this.seq,
      busy: !this.agent.isIdle(),
      session: this.agent.sessionName(),
      model: this.agent.model(),
      caseName: this.agent.caseName(),
      caseDir: this.agent.caseDir(),
      profile: this.opts.profile,
      clients: this.clientCount(),
      version: this.opts.version,
      transcript: this.agent.transcript(TRANSCRIPT_LIMIT),
      ...(live ? { live } : {}),
      ...(running.length ? { runningTools: running } : {}),
    };
  }
}

// The zero-build console: served only when the vite bundle isn't shipped (a
// broken build / missing sidecar). Deliberately POLL-BASED — it re-renders the
// whole /api/state snapshot on a timer rather than maintaining an incremental
// SSE state machine. That makes it robust by construction: there is no live
// buffer, seq cursor, dedupe, or reconnect logic to drift from the real SPA
// (which is where every past fallback bug came from). Functional — send,
// steer/follow-up, abort — just a couple seconds behind. Contains no secrets;
// the token arrives via the URL fragment and lives only in the browser.
const FALLBACK_PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>overcast — man in the chair</title>
<style>
  body { background:#0a0f0a; color:#9fdf9f; font:14px/1.45 ui-monospace,Menlo,monospace; margin:0; display:flex; flex-direction:column; height:100dvh; }
  header { padding:8px 12px; border-bottom:1px solid #1e3320; color:#e0ffe0; display:flex; gap:10px; align-items:baseline; }
  header .busy { color:#ffb347; } header .note { color:#5a705a; margin-left:auto; font-size:12px; }
  #log { flex:1; overflow-y:auto; padding:12px; white-space:pre-wrap; word-break:break-word; }
  .u { color:#7fd4ff; } .a {} .t { color:#8a8f8a; } .n { color:#ffb347; } .live { color:#9fdf9f; }
  form { display:flex; gap:6px; padding:10px 12px; border-top:1px solid #1e3320; }
  input,select,button { background:#101810; color:#cfe; border:1px solid #2e4d30; border-radius:4px; padding:8px; font:inherit; }
  input { flex:1; min-width:0; }
  #abort { color:#ff6b6b; border-color:#5d2626; }
</style>
<header><strong>◉ CHAIR</strong><span id="case"></span><span id="state" class="busy"></span><span class="note">fallback · polling</span></header>
<div id="log"></div>
<form id="f">
  <input id="text" placeholder="message the desk…" autocomplete="off">
  <select id="mode"><option value="auto">auto</option><option value="steer">steer</option><option value="followUp">follow-up</option></select>
  <button type="submit">send</button>
  <button type="button" id="abort">abort</button>
</form>
<script>
  // pair from the QR's URL #fragment, persisting to sessionStorage (same
  // "chair-token" key as the SPA) so a same-tab reload without the fragment
  // stays paired instead of falling back to an empty, unauthorized token.
  const token = (() => {
    try {
      const fromHash = new URLSearchParams(location.hash.slice(1)).get("t");
      if (fromHash) { sessionStorage.setItem("chair-token", fromHash); return fromHash; }
      return sessionStorage.getItem("chair-token") || "";
    } catch (e) { return new URLSearchParams(location.hash.slice(1)).get("t") || ""; }
  })();
  const log = document.getElementById("log");
  const api = (path, body) => fetch(path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  let lastSeq = -1;
  // Full re-render from a snapshot. No incremental state → nothing to dedupe or
  // drift; we only rebuild when the snapshot's seq changed, and keep the view
  // pinned to the bottom if the reader was already there.
  const render = (s) => {
    if (s.seq === lastSeq) { setState(s); return; }
    lastSeq = s.seq;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const rows = [];
    const row = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; rows.push(d); };
    for (const it of s.transcript) {
      if (it.role === "user") row("u", "❯ " + it.text);
      else if (it.role === "tool") row("t", "⚙ " + (it.toolName || "tool") + " " + it.text);
      else row("a", it.text);
    }
    for (const t of (s.runningTools || [])) row("t", "⚙ " + t.name + " …");
    if (s.live) row("a live", s.live); // the in-flight assistant line, always kept
    log.replaceChildren(...rows);
    if (atBottom) log.scrollTop = log.scrollHeight;
    setState(s);
  };
  const setState = (s) => {
    document.getElementById("case").textContent = "case://" + s.caseName;
    document.getElementById("state").textContent = s.busy ? "● working" : "";
  };
  let alive = true;
  const poll = () => api("/api/state").then(r => r.ok ? r.json() : Promise.reject(r.status)).then(render).catch((err) => {
    // 401 = the token was rotated (e.g. /chair off→on) — re-pairing needs a new
    // QR scan; other failures are transient (desk offline / network).
    if (err === 401) {
      // stop the poll loop + strip the revoked token from the URL so we don't
      // keep hitting the bridge with a dead bearer (Bugbot round 28)
      alive = false;
      try { sessionStorage.removeItem("chair-token"); } catch (e) {}
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
      document.getElementById("state").textContent = "· unauthorized — re-scan the QR to re-pair";
    }
    else document.getElementById("state").textContent = "· disconnected";
  }).finally(() => { if (alive) setTimeout(poll, 1500); });
  poll();
  document.getElementById("f").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!alive) return; // after a 401 teardown, don't POST with the revoked token
    const text = document.getElementById("text").value.trim();
    if (!text) return;
    api("/api/prompt", { text, mode: document.getElementById("mode").value }).then(r => { if (r.ok) poll(); }).catch(() => {});
    document.getElementById("text").value = "";
  });
  // abort must be a POST — the bridge only runs agent.abort() on POST /api/abort
  document.getElementById("abort").addEventListener("click", () => { if (alive) api("/api/abort", {}).then(poll).catch(() => {}); });
</script>`;
