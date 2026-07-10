// Man in the chair — pi glue for the remote-drive bridge (CLAUDE.md invariant
// #1: all pi touch-points live here + registry/to-agent-tool.ts). Registers the
// `/chair` command and the `--chair` startup flag, captures the live session
// context, translates pi events into the chair wire protocol, and injects
// remote prompts back into the loop. The transport/auth/HTTP lives in the
// pi-free core (src/chair/bridge.ts) so it stays unit-testable.
//
// The LLM gets NO chair tool: opening a network listener is an operator action,
// never something the agent can trigger (invariant #10, untrusted content).

import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { openCase } from "../case.js";
import { loadProfile } from "../profile.js";
import { OVERCAST_VERSION } from "../version.js";
import { ChairBridge, type ChairAgent } from "../chair/bridge.js";
import { buildCaseGlance } from "../chair/glance.js";
import { chairConsoleDir } from "../chair/assets.js";
import { detectTailnetAddr } from "../chair/net.js";
import { detectServeUrl, enableServe, disableServe, serveCommandHint } from "../chair/serve.js";
import { qrLines } from "../chair/qr.js";
import type { TranscriptItem } from "../chair/wire.js";
import { emitResult } from "./slash.js";

// Each injection carries a short random correlation id: `[chair:a3f1] …`. It's
// what makes the pending-injection match UNFORGEABLE — a desk message that types
// a literal `[chair] …` (or even copies a phone prompt verbatim) can't reproduce
// the id, so it can't steal a pending chair slot (Bugbot round 29). CHAIR_MARK
// strips the id'd form AND the legacy plain `[chair] ` (older history entries).
const CHAIR_MARK = /^\[chair(?::[0-9a-f]+)?\] /;
const QR_WIDGET_KEY = "chair-qr";
const DELTA_FLUSH_MS = 40;

interface StartOptions {
  bind?: string;
  port?: number;
  /** Explicit public HTTPS origin for the QR (`--url` / OVERCAST_CHAIR_URL). */
  publicUrl?: string;
  /** `--serve`: bring up `tailscale serve` so the QR is HTTPS (voice-capable). */
  serve?: boolean;
}

/** Loopback / wildcard binds are reachable by a `tailscale serve` loopback
 *  proxy target; a tailnet-only bind is not, so we don't claim its HTTPS URL. */
function loopbackBind(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1" || bind === "0.0.0.0" || bind === "::";
}

/** Normalize a public origin: drop any fragment/query, ensure a trailing slash
 *  so `${base}#t=…` is well-formed. Returns undefined for empty input. */
function normalizePublicUrl(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    u.hash = "";
    u.search = "";
    if (!u.pathname || u.pathname === "") u.pathname = "/";
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Flatten a pi AgentMessage into plain text for the transcript snapshot. */
function messageText(message: unknown): string {
  const msg = message as { role?: string; content?: unknown };
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    // thinking + toolCall blocks are intentionally omitted from the transcript
  }
  return parts.join("");
}

export interface ChairHandle {
  /** Footer segment ("<addr>:<port> ·<clients>") while online, else undefined. */
  footerLabel(): string | undefined;
  /** For tests: the live bridge, if any. */
  bridge(): ChairBridge | undefined;
}

export function registerChair(pi: ExtensionAPI): ChairHandle {
  // Captured from every event/command ctx; the ctx delegates to live runner
  // functions, so a stored reference stays valid for the whole session and is
  // refreshed automatically when session_start re-fires (reload/new/resume/fork).
  let ctx: ExtensionContext | undefined;
  let bridge: ChairBridge | undefined;
  let qrVisible = false;
  // Whether the chair should be running right now — set once it's started
  // (manually via /chair on OR via --chair/OVERCAST_CHAIR), cleared only by
  // /chair off. It persists across pi's session_shutdown→session_start so a
  // reload/resume/fork restarts the bridge (Bugbot round 17 — a manual /chair on
  // must survive a reload, not just an env-configured one).
  let chairDesired = false;
  // operator ran /chair off → suppress autostart on later session_start until an
  // explicit /chair on, so a reload/resume/fork doesn't silently reopen remote
  // control after the operator turned it off (Bugbot round 10).
  let chairOptedOut = false;
  // The pairing token reused across reload-restarts within this process, so a
  // reload doesn't silently rotate it and 401 the phone (Bugbot round 17).
  // Rotated only by /chair off (cleared here) or pinned via OVERCAST_CHAIR_TOKEN.
  let sessionToken: string | undefined;
  // The opts of the last successful start, replayed on a reload restart so a
  // `/chair on tailnet` (or custom --bind/--port) survives a reload instead of
  // silently falling back to localhost.
  let lastStartOpts: StartOptions = {};
  // The in-flight bridge.stop() promise, so a restart waits for the port to be
  // released before rebinding (round 20). Resolved when no stop is pending.
  let stopping: Promise<void> = Promise.resolve();
  // The port we brought up `tailscale serve` for via `--serve`, so /chair off
  // tears down exactly that mapping (undefined = we didn't enable serve).
  let serveEnabledPort: number | undefined;
  // exact "[chair] …" strings of injected prompts awaiting their message_start.
  // Matching a live user message against this queue (by content, FIFO) — rather
  // than a blind counter — means a desk message that merely starts with the
  // marker can't consume a remote slot or get relabeled chair (Bugbot round 10).
  const pendingChair: string[] = [];
  // full "[chair] …" strings CONFIRMED chair-originated live (a pendingChair
  // match). Snapshot/history replay classifies against this instead of the raw
  // prefix, so a desk-typed "[chair] …" isn't mislabeled "from the chair" after
  // a resync/late-join (Bugbot round 25). Grows with chair prompts only.
  const chairMsgs = new Set<string>();

  // true between agent_start and agent_end — the authoritative "run active"
  // signal. ctx.isIdle() only means "not streaming" and is true between LLM
  // responses (e.g. while a tool runs), so routing/busy must not rely on it
  // alone (Bugbot round 11).
  let agentRunning = false;
  // tools started but not yet ended, so a resyncing console can re-register
  // their rows (they aren't in the finalized snapshot transcript).
  const runningTools = new Map<string, { name: string; argsSummary?: string }>();

  // delta coalescing — message_update fires per token; batch to ≤1 flush/40ms.
  // textBuf/thinkBuf are the coalesce buffers PUBLISHED to live SSE clients; they
  // only accumulate while a bridge is up (no consumer otherwise).
  let textBuf = "";
  let thinkBuf = "";
  // The FULL in-flight assistant text — accumulated on every delta whether or not
  // a bridge is up, so `/chair on` after a mid-reply `/chair off` still serves the
  // current text (not a frozen one, Bugbot round 27). Surfaced as the snapshot's
  // `live` so a resync rebuilds the live line (getBranch holds only finalized
  // messages). The snapshot flushes textBuf first, so `live`'s published tail is
  // covered by the seq the console resumes from — future deltas append, never
  // double-count (Bugbot rounds 4/25).
  let livePartial = "";
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (textBuf) {
      bridge?.publish({ type: "delta", kind: "text", text: textBuf });
      textBuf = "";
    }
    if (thinkBuf) {
      bridge?.publish({ type: "delta", kind: "thinking", text: thinkBuf });
      thinkBuf = "";
    }
  };
  const scheduleFlush = (): void => {
    if (!flushTimer) flushTimer = setTimeout(flush, DELTA_FLUSH_MS);
  };
  // Drop all in-flight streaming state (pending deltas + the published-baseline
  // partial + the flush timer). Called at every assistant-message boundary and
  // when the bridge stops, so buffers never leak across messages or across a
  // /chair off → on, which would otherwise merge stale text or seed a ghost
  // `live` line into a later snapshot (Bugbot round 5).
  const resetStream = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    textBuf = "";
    thinkBuf = "";
    livePartial = "";
  };

  const capture = (c: ExtensionContext): void => {
    ctx = c;
  };

  // the live case dir for this session (follows --case / a session switch), read
  // fresh each call so a running bridge never reports a stale case.
  const caseCwd = (): string => process.env.OVERCAST_CASE || ctx?.cwd || process.cwd();

  // The single busy signal: an active agent loop (runs true through tool
  // execution, when ctx.isIdle() alone would read idle) OR active streaming.
  // Every busy/isIdle report goes through this so they never disagree.
  const chairBusy = (): boolean => agentRunning || !(ctx?.isIdle() ?? true);

  // Classify a user message as desk- or chair-originated. `live` (message_start)
  // matches the exact text against the pending-injection queue and consumes it,
  // recording confirmed chair messages in chairMsgs. `history` (snapshot replay)
  // then classifies against chairMsgs — NOT the raw prefix — so a desk-typed
  // "[chair] …" message is never mislabeled "from the chair" after a resync
  // (Bugbot round 25). A genuine chair message from a prior process/session
  // that isn't in chairMsgs degrades to desk (shows the literal prefix).
  const classifyUser = (raw: string, live: boolean): { source: "desk" | "chair"; text: string } => {
    let chair: boolean;
    if (live) {
      const i = pendingChair.indexOf(raw);
      chair = i >= 0;
      if (chair) {
        pendingChair.splice(i, 1);
        chairMsgs.add(raw);
      }
    } else {
      chair = chairMsgs.has(raw);
    }
    return chair ? { source: "chair", text: raw.replace(CHAIR_MARK, "") } : { source: "desk", text: raw };
  };

  const buildAgent = (): ChairAgent => ({
    isIdle: () => !chairBusy(), // active loop (incl. tool runs) or streaming = busy
    hasPending: () => ctx?.hasPendingMessages() ?? false,
    abort: () => ctx?.abort(),
    sendUserMessage: (text, opts) => {
      // Remote input is untrusted (invariant #10). Two layers stop a phone from
      // invoking slash commands / prompt templates:
      //  1. pi.sendUserMessage forces `expandPromptTemplates: false` internally
      //     (agent-session.js sendUserMessage → prompt({expandPromptTemplates:
      //     false, source:"extension"})); the public ExtensionAPI has no option
      //     to re-enable it, so this can't be bypassed from here.
      //  2. we prefix `[chair:<id>] `, so the text never starts with "/" — pi's
      //     command detection (`text.startsWith("/")`) can't match even
      //     hypothetically.
      // The random correlation id makes the queued string unforgeable, so no desk
      // message can steal this pending slot by matching its content (Bugbot r29).
      // Queue it up front (message_start may fire synchronously), rolling it back
      // if the dispatch throws so a failed send can't leave a phantom entry that
      // mislabels a later message (Bugbot r5/r10).
      const full = `[chair:${randomBytes(3).toString("hex")}] ${text}`;
      pendingChair.push(full);
      try {
        pi.sendUserMessage(full, opts);
      } catch (e) {
        const i = pendingChair.lastIndexOf(full);
        if (i >= 0) pendingChair.splice(i, 1);
        throw e;
      }
    },
    model: () => ctx?.model?.id,
    sessionName: () => ctx?.sessionManager.getSessionName(),
    caseName: () => openCaseName(caseCwd()),
    caseDir: () => caseCwd(),
    transcript: (limit) => {
      const entries = ctx?.sessionManager.getBranch() ?? [];
      const items: TranscriptItem[] = [];
      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = (entry as { message?: { role?: string; toolName?: string; isError?: boolean } }).message;
        const role = msg?.role;
        if (role === "user") {
          const { source, text } = classifyUser(messageText(msg), false);
          items.push({ role: "user", source, text, at: entry.timestamp });
        } else if (role === "assistant") {
          const text = messageText(msg);
          if (text.trim()) items.push({ role: "assistant", text, at: entry.timestamp });
        } else if (role === "toolResult") {
          const name = typeof msg?.toolName === "string" ? msg.toolName : "tool";
          items.push({ role: "tool", toolName: name, text: msg?.isError ? "(error)" : "", at: entry.timestamp });
        }
      }
      return items.slice(-limit);
    },
    caseGlance: () => buildCaseGlance(openCase(caseCwd())),
    // flush any coalesced textBuf FIRST so the snapshot's `live` includes the
    // latest deltas — and, because flush() publishes them (advancing the bridge
    // seq), `live` and the snapshot seq stay in lockstep, so a resync seeds the
    // full text and resumes past it with no miss AND no double-count (Bugbot r25,
    // preserving the r4 no-dup invariant).
    livePartial: () => {
      flush();
      return livePartial;
    },
    runningTools: () => [...runningTools.entries()].map(([toolCallId, t]) => ({ toolCallId, name: t.name, ...(t.argsSummary ? { argsSummary: t.argsSummary } : {}) })),
    onRemotePrompt: (info) => ctx?.ui.notify(`chair: remote prompt (${info.mode})`, "info"),
  });

  // --- event → wire translators -----------------------------------------------

  pi.on("session_start", async (_e, c) => {
    capture(c);
    // first launch adopts the --chair/OVERCAST_CHAIR intent (unless the operator
    // turned it off); thereafter chairDesired carries a manual /chair on across
    // reloads too. Restart only if it isn't already running.
    const wantByConfig = pi.getFlag("chair") === true || envTruthy(process.env.OVERCAST_CHAIR);
    if (!chairOptedOut && (chairDesired || wantByConfig)) {
      chairDesired = true;
      if (!bridge?.running) await startChair(lastStartOpts); // replay the last bind/port; token reused
    }
  });
  pi.on("session_shutdown", async () => {
    // reload/new/resume/fork fire session_shutdown then session_start. Stop the
    // bridge but DON'T touch chairDesired / sessionToken — the next session_start
    // restarts it with the SAME token so the phone stays paired.
    await stopChair(); // flushes coalesced deltas before the sockets close
    // this session's run is abandoned — clear run + stream state so a reload's
    // restarted bridge doesn't report ghost busy / runningTools / live while the
    // new session is idle (agent_end may never fire on a mid-run reload). This is
    // the "session genuinely ends" clear that stopChair deliberately skips.
    agentRunning = false;
    runningTools.clear();
    resetStream();
  });

  pi.on("agent_start", (_e, c) => {
    capture(c);
    agentRunning = true;
    bridge?.publish({ type: "agent", phase: "start" });
  });
  pi.on("agent_end", (_e, c) => {
    capture(c);
    agentRunning = false;
    flush(); // deliver any remaining coalesced text
    bridge?.publish({ type: "agent", phase: "end" });
    // the turn is over (including an abort, where message_end / tool ends may not
    // fire) — drop live/partial state + any lingering tool rows so the snapshot
    // leaves no ghost `live`/running tool
    resetStream();
    runningTools.clear();
  });
  pi.on("turn_start", (e, c) => {
    capture(c);
    bridge?.publish({ type: "turn", phase: "start", turnIndex: e.turnIndex });
  });
  pi.on("turn_end", (e, c) => {
    capture(c);
    bridge?.publish({ type: "turn", phase: "end", turnIndex: e.turnIndex });
  });
  pi.on("model_select", (e, c) => {
    capture(c);
    bridge?.publish({ type: "state", busy: chairBusy(), pending: ctx?.hasPendingMessages() ?? false, model: e.model.id });
  });

  pi.on("message_start", (e, c) => {
    capture(c);
    const role = (e.message as { role?: string }).role;
    if (role === "assistant") resetStream(); // fresh assistant line: drop any leftover buffers
    if (!bridge) return;
    if (role === "user") {
      const { source, text } = classifyUser(messageText(e.message), true);
      bridge.publish({ type: "message", phase: "start", role: "user", source, text });
    } else if (role === "assistant") {
      bridge.publish({ type: "message", phase: "start", role: "assistant" });
    }
  });
  pi.on("message_update", (e, c) => {
    capture(c);
    const ev = e.assistantMessageEvent;
    if (ev.type === "text_delta") {
      livePartial += ev.delta; // full partial — tracked even offline (round 27)
      if (bridge) textBuf += ev.delta; // publish buffer — only while a client is listening
    } else if (ev.type === "thinking_delta") {
      if (bridge) thinkBuf += ev.delta; // thinking isn't part of the snapshot `live`
    } else return;
    if (bridge) scheduleFlush();
  });
  pi.on("message_end", (e, c) => {
    capture(c);
    const role = (e.message as { role?: string }).role;
    if (bridge) {
      flush(); // deliver any remaining coalesced text before the boundary
      if (role === "assistant") bridge.publish({ type: "message", phase: "end", role: "assistant", text: messageText(e.message) });
    }
    if (role === "assistant") resetStream(); // finalized; snapshot uses getBranch now
  });

  pi.on("tool_execution_start", (e, c) => {
    capture(c);
    const argsSummary = summarizeArgs(e.args);
    runningTools.set(e.toolCallId, { name: e.toolName, argsSummary });
    bridge?.publish({ type: "tool", phase: "start", toolCallId: e.toolCallId, name: e.toolName, argsSummary });
  });
  pi.on("tool_execution_end", (e, c) => {
    capture(c);
    runningTools.delete(e.toolCallId);
    bridge?.publish({ type: "tool", phase: "end", toolCallId: e.toolCallId, name: e.toolName, isError: e.isError });
  });

  // --- start / stop ------------------------------------------------------------

  /** Resolve, bind, and adopt a bridge. Returns the error message on failure
   *  (bridge untouched), or undefined on success. Does NOT emit — the caller
   *  decides (a rebind can retry the previous bind before reporting). */
  async function bindBridge(opts: StartOptions): Promise<string | undefined> {
    // Resolve bind/port with the LAST resolved values as a fallback (below an
    // explicit opt, above env/defaults), so a partial `/chair on --port …` keeps
    // the current bind (e.g. tailnet) and a reload keeps the concrete address —
    // not a partial/ephemeral one (Bugbot round 19).
    const bind = opts.bind || lastStartOpts.bind || process.env.OVERCAST_CHAIR_BIND || "127.0.0.1";
    const port = opts.port ?? lastStartOpts.port ?? envPort(process.env.OVERCAST_CHAIR_PORT) ?? 7373;
    const profile = loadProfile({ profile: process.env.OVERCAST_PROFILE || undefined });
    // pin > reused-session-token > fresh. The extension owns the token so it can
    // reuse it across reload-restarts (a reload must not rotate it, round 17).
    const token = process.env.OVERCAST_CHAIR_TOKEN || sessionToken || randomBytes(32).toString("base64url");
    // Resolve the public HTTPS origin (secure context → phone voice works):
    // an explicit --url/env override wins; otherwise, when the bind is reachable
    // by a loopback serve proxy, auto-detect an existing `tailscale serve`. The
    // `--serve` enable itself happens in startChair (it emits progress/errors).
    const explicitUrl = normalizePublicUrl(opts.publicUrl || process.env.OVERCAST_CHAIR_URL);
    const publicUrl = explicitUrl || (loopbackBind(bind) ? await detectServeUrl(port) : undefined);
    const b = new ChairBridge({
      agent: buildAgent(), // caseName/caseDir are read live from the agent
      profile: profile.name ?? "default",
      version: OVERCAST_VERSION,
      bind,
      port,
      token,
      publicUrl,
      assetsDir: chairConsoleDir(),
    });
    try {
      await b.start();
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EADDRINUSE" ? `port ${port} already in use — try /chair on --port <n>` : (e as Error).message;
    }
    bridge = b;
    sessionToken = process.env.OVERCAST_CHAIR_TOKEN ? undefined : token; // reuse across reloads (pin isn't ours to keep)
    chairDesired = true; // now running by intent → survives reloads
    // store the RESOLVED bind + the ACTUAL bound port, so a reload rebinds to the
    // same concrete address the phone is paired to (an ephemeral 0 became a real
    // port; a partial rebind kept the prior bind)
    // Persist the explicit --url override for reloads; an auto-detected serve
    // URL is re-resolved on each bind (cheap) so it stays correct if serve moves.
    lastStartOpts = { bind, port: b.port, publicUrl: opts.publicUrl };
    return undefined;
  }

  async function startChair(opts: StartOptions = {}): Promise<void> {
    // --serve: front the chair with HTTPS via `tailscale serve` so the paired
    // phone loads a SECURE context and voice dictation works. serve proxies to
    // LOOPBACK, so force a loopback bind (a `tailnet` bind would make the HTTPS
    // QR point at a chair the proxy can't reach). Enable it before binding to
    // get the public URL, but only ADOPT it for teardown after a successful bind
    // and only when WE created the mapping (not a pre-existing operator serve).
    let serveCreatedPort: number | undefined;
    if (opts.serve) {
      if (opts.bind && !loopbackBind(opts.bind)) {
        emitResult(pi, "▶ chair: --serve gives HTTPS over your tailnet via `tailscale serve`; binding loopback (ignoring the tailnet bind)");
      }
      opts.bind = "127.0.0.1";
      const port = opts.port ?? lastStartOpts.port ?? envPort(process.env.OVERCAST_CHAIR_PORT) ?? 7373;
      emitResult(pi, "▶ chair: enabling HTTPS via `tailscale serve`…");
      const r = await enableServe(port);
      if (r.url) {
        opts.publicUrl = r.url;
        if (r.created) serveCreatedPort = port; // ours to tear down — adopted only after bind succeeds
      } else {
        emitResult(pi, `▶ chair: ${r.error} — continuing over HTTP (voice needs HTTPS)`);
      }
    }
    const wasRunning = bridge?.running === true;
    const prevOpts = lastStartOpts; // the opts the running bridge is using (concrete)
    if (wasRunning) {
      // explicit bind/port → rebind: stop (rotating the token unless pinned)
      // and fall through to a fresh start; a bare `/chair on` just reports.
      if (opts.bind === undefined && opts.port === undefined) {
        showStatus();
        return;
      }
      await stopChair();
    }
    // wait for any in-flight stop to actually release the listen port before we
    // rebind — session_shutdown's stopChair and session_start's startChair can
    // otherwise race and EADDRINUSE on the reused port (Bugbot round 20)
    await stopping;
    const err = await bindBridge(opts);
    if (!err) {
      if (serveCreatedPort !== undefined) serveEnabledPort = serveCreatedPort; // now there's a listener behind it
      showQr();
      showStatus();
      return;
    }
    // Bind failed — if WE just started a serve mapping there's now no listener
    // behind it, so tear the one we created back down (never a pre-existing one).
    if (serveCreatedPort !== undefined) await disableServe(serveCreatedPort);
    // A rebind of a previously-running bridge failed (bad bind / port taken) —
    // restore the previous listener so remote control isn't lost (Bugbot r22).
    if (wasRunning && !(await bindBridge(prevOpts))) {
      showQr();
      emitResult(pi, `▶ chair: rebind failed (${err}) — kept the previous bind ${bridge?.bind}:${bridge?.port}`);
      return;
    }
    emitResult(pi, `▶ chair: could not start — ${err}`);
  }

  async function stopChair(): Promise<void> {
    if (!bridge) return;
    flush(); // deliver any coalesced assistant text before the sockets close
    // Do NOT clear livePartial here: a rebind or a mid-run /chair off keeps the
    // desk streaming, so the partial must survive for the next bridge's snapshot
    // (Bugbot round 26). A run that has ENDED already cleared it via
    // agent_end/message_end; session_shutdown clears it when the session is
    // genuinely abandoned. So a stale/ghost `live` can't linger either way.
    pendingChair.length = 0; // a pending injection can't attribute across a restart
    const b = bridge;
    bridge = undefined;
    hideQr();
    // publish the stop promise synchronously (before the await yields) so a
    // concurrent startChair waits on it for the port to be released
    stopping = b.stop();
    await stopping;
  }

  function showQr(): void {
    if (!bridge || ctx?.mode !== "tui") return;
    const b = bridge;
    // Tell the operator whether the paired phone will be able to use voice: the
    // mic only works on a secure (HTTPS) origin. Over plain HTTP, point them at
    // `tailscale serve` (or /chair on --serve) to get an HTTPS QR.
    const voiceLine = b.secure
      ? "  🔒 HTTPS via Tailscale — voice dictation enabled on the phone"
      : `  ⚠ HTTP — voice needs HTTPS: run \`${serveCommandHint(b.port)}\` then /chair qr, or /chair on --serve`;
    const lines = [
      "  ◉ CHAIR — scan to pair (token is in the QR only)",
      "",
      ...qrLines(b.pairingUrl).map((l) => "  " + l),
      "",
      voiceLine,
      `  ${b.displayUrl}   ·   /chair qr to hide`,
    ];
    // Render via a component FACTORY, not a string[]: pi caps array widgets at
    // MAX_WIDGET_LINES (10) and appends "... (widget truncated)", which chops a
    // scannable QR (~13–21 rows) mid-code and drops the pairing URL. The factory
    // path is exempt from that cap, so the whole QR + pair line stay pinned.
    // Mirrors pi's own array rendering (Text(line, 1, 0)) so appearance is identical.
    ctx.ui.setWidget(QR_WIDGET_KEY, () => {
      const box = new Container();
      for (const line of lines) box.addChild(new Text(line, 1, 0));
      return box;
    });
    qrVisible = true;
  }

  function hideQr(): void {
    ctx?.ui.setWidget(QR_WIDGET_KEY, undefined);
    qrVisible = false;
  }

  function showStatus(): void {
    if (!bridge) {
      emitResult(pi, "▶ chair: offline");
      return;
    }
    // status text never includes the token (it lives only in the QR fragment)
    emitResult(
      pi,
      [
        `▶ chair: online at ${bridge.displayUrl}`,
        `  bind ${bridge.bind}:${bridge.port} · clients ${bridge.clientCount()} · case://${openCaseName(process.env.OVERCAST_CASE || ctx?.cwd || process.cwd())}`,
        bridge.secure
          ? "  🔒 HTTPS — phone voice dictation enabled · pair with the QR (token is in the QR)"
          : `  ⚠ HTTP — voice needs HTTPS (\`${serveCommandHint(bridge.port)}\` or /chair on --serve) · pair with the QR, or over Tailscale: /chair on tailnet`,
      ].join("\n"),
    );
  }

  // --- /chair command ----------------------------------------------------------

  pi.registerFlag("chair", { type: "boolean", description: "start the man-in-the-chair remote bridge on launch" });

  pi.registerCommand("chair", {
    description: "man in the chair: remote-drive this session from your phone (on [tailnet|--serve|--url <u>]|off|status|qr)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
      return ["on", "off", "status", "qr", "on tailnet", "on --serve"]
        .filter((s) => s.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args: string, c): Promise<void> => {
      capture(c);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] || "status").toLowerCase();
      if (sub === "off" || sub === "stop") {
        chairOptedOut = true; // operator intent: stay off across reloads until /chair on
        chairDesired = false;
        sessionToken = undefined; // rotate: the next /chair on mints a fresh token
        await stopChair();
        // tear down the `tailscale serve` mapping WE brought up (--serve) — only
        // ever set for a serve we created, and disableServe additionally refuses
        // to touch a 443 config shared with the operator's own mappings.
        let served = "";
        if (serveEnabledPort !== undefined) {
          const r = await disableServe(serveEnabledPort);
          serveEnabledPort = undefined;
          served = r.ok ? " · tailscale serve stopped" : ` · ${r.skipped}`;
        }
        // honest about rotation: a pinned OVERCAST_CHAIR_TOKEN survives restarts
        emitResult(
          pi,
          (process.env.OVERCAST_CHAIR_TOKEN
            ? "▶ chair: offline (token pinned via OVERCAST_CHAIR_TOKEN — unset it to rotate)"
            : "▶ chair: offline (token rotated)") + served,
        );
        return;
      }
      if (sub === "qr") {
        if (!bridge) return void emitResult(pi, "▶ chair: offline — /chair on first");
        if (qrVisible) {
          hideQr();
          emitResult(pi, "▶ chair: QR hidden — /chair qr to show it again");
        } else {
          showQr();
        }
        return;
      }
      if (sub === "status") {
        showStatus();
        return;
      }
      if (sub === "on" || sub === "start") {
        chairOptedOut = false; // explicit re-enable clears any earlier /chair off
        const opts: StartOptions = {};
        const rest = tokens.slice(1);
        for (let i = 0; i < rest.length; i++) {
          const t = rest[i];
          if (t === "tailnet") {
            const addr = detectTailnetAddr();
            if (!addr) return void emitResult(pi, "▶ chair: no tailnet (100.64.0.0/10) address found — is Tailscale up?");
            opts.bind = addr;
          } else if (t === "--serve") opts.serve = true;
          else if (t === "--url") {
            const url = normalizePublicUrl(rest[++i]);
            if (!url) return void emitResult(pi, "▶ chair: --url must be a full origin, e.g. https://mac.tailnet.ts.net");
            opts.publicUrl = url;
          } else if (t === "--bind") opts.bind = rest[++i];
          else if (t === "--port") {
            const port = envPort(rest[++i]); // validates 0..65535 (0 = ephemeral, not falsy-dropped)
            if (port === undefined) return void emitResult(pi, "▶ chair: --port must be a number 0–65535");
            opts.port = port;
          }
        }
        await startChair(opts);
        return;
      }
      emitResult(pi, `▶ chair: unknown subcommand "${sub}" — use on | off | status | qr`);
    },
  });

  return {
    footerLabel: () => (bridge?.running ? `${bridge.bind}:${bridge.port} ·${bridge.clientCount()}` : undefined),
    bridge: () => bridge,
  };
}

function openCaseName(cwd: string): string {
  const c = openCase(cwd);
  return c.exists() ? c.info().name : cwd.split("/").pop() || cwd;
}

function envTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

function envPort(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

function summarizeArgs(args: unknown): string | undefined {
  if (args == null || typeof args !== "object") return undefined;
  const keys = Object.keys(args as Record<string, unknown>);
  if (!keys.length) return undefined;
  const parts: string[] = [];
  for (const k of keys.slice(0, 4)) {
    const v = (args as Record<string, unknown>)[k];
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${(s ?? "").slice(0, 40)}`);
  }
  return parts.join(" ");
}
