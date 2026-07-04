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
import { openCase } from "../case.js";
import { loadProfile } from "../profile.js";
import { OVERCAST_VERSION } from "../version.js";
import { ChairBridge, type ChairAgent } from "../chair/bridge.js";
import { buildCaseGlance } from "../chair/glance.js";
import { chairConsoleDir } from "../chair/assets.js";
import { detectTailnetAddr } from "../chair/net.js";
import { qrLines } from "../chair/qr.js";
import type { TranscriptItem } from "../chair/wire.js";
import { emitResult } from "./slash.js";

const CHAIR_PREFIX = "[chair] ";
const QR_WIDGET_KEY = "chair-qr";
const DELTA_FLUSH_MS = 40;

interface StartOptions {
  bind?: string;
  port?: number;
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
  // exact "[chair] …" strings of injected prompts awaiting their message_start.
  // Matching a live user message against this queue (by content, FIFO) — rather
  // than a blind counter — means a desk message that merely starts with the
  // marker can't consume a remote slot or get relabeled chair (Bugbot round 10).
  const pendingChair: string[] = [];

  // true between agent_start and agent_end — the authoritative "run active"
  // signal. ctx.isIdle() only means "not streaming" and is true between LLM
  // responses (e.g. while a tool runs), so routing/busy must not rely on it
  // alone (Bugbot round 11).
  let agentRunning = false;
  // tools started but not yet ended, so a resyncing console can re-register
  // their rows (they aren't in the finalized snapshot transcript).
  const runningTools = new Map<string, { name: string; argsSummary?: string }>();

  // delta coalescing — message_update fires per token; batch to ≤1 flush/40ms
  let textBuf = "";
  let thinkBuf = "";
  // The in-flight assistant text ALREADY PUBLISHED as delta events, surfaced in
  // the snapshot so a mid-stream resync rebuilds the live line (getBranch only
  // holds finalized messages). It's advanced in flush(), in lockstep with the
  // deltas + lastSeq — so a resync seeds `live` and then resumes from that seq
  // with no overlap: the unflushed textBuf arrives as a *later* delta, never
  // double-counted (Bugbot round 4).
  let livePartial = "";
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (textBuf) {
      livePartial += textBuf; // published now → part of the snapshot baseline
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
  // so only a message we actually injected is labeled chair — a desk message
  // that merely starts with the marker (even one identical in prefix) stays desk
  // unless its full text matches a real pending injection. Replayed history has
  // no such signal, so it falls back to the marker heuristic (best-effort).
  const classifyUser = (raw: string, live: boolean): { source: "desk" | "chair"; text: string } => {
    let chair: boolean;
    if (live) {
      const i = pendingChair.indexOf(raw);
      chair = i >= 0;
      if (chair) pendingChair.splice(i, 1);
    } else {
      chair = raw.startsWith(CHAIR_PREFIX);
    }
    return chair ? { source: "chair", text: raw.slice(CHAIR_PREFIX.length) } : { source: "desk", text: raw };
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
      //  2. we prefix CHAIR_PREFIX ("[chair] "), so the text never starts with
      //     "/" — pi's command detection (`text.startsWith("/")`) can't match
      //     even hypothetically.
      // queue the exact injected string up front (message_start may fire
      // synchronously), rolling it back if the dispatch throws so a failed send
      // can't leave a phantom entry that mislabels a later message (Bugbot r5/r10)
      const full = CHAIR_PREFIX + text;
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
    livePartial: () => livePartial,
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
    // this session's run is abandoned — clear run state so a reload's restarted
    // bridge doesn't report ghost busy / runningTools while the new session is idle
    // (agent_end may never fire on a mid-run reload).
    agentRunning = false;
    runningTools.clear();
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
    if (!bridge) return; // no consumer — don't accumulate deltas while offline
    const ev = e.assistantMessageEvent;
    if (ev.type === "text_delta") textBuf += ev.delta; // livePartial advances on flush
    else if (ev.type === "thinking_delta") thinkBuf += ev.delta;
    else return;
    scheduleFlush();
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

  async function startChair(opts: StartOptions = {}): Promise<void> {
    if (bridge?.running) {
      // explicit bind/port → rebind: stop (rotating the token unless pinned)
      // and fall through to a fresh start; a bare `/chair on` just reports.
      if (opts.bind === undefined && opts.port === undefined) {
        showStatus();
        return;
      }
      await stopChair();
    }
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
    const b = new ChairBridge({
      agent: buildAgent(), // caseName/caseDir are read live from the agent
      profile: profile.name ?? "default",
      version: OVERCAST_VERSION,
      bind,
      port,
      token,
      assetsDir: chairConsoleDir(),
    });
    try {
      await b.start();
    } catch (e) {
      const msg = (e as NodeJS.ErrnoException).code === "EADDRINUSE" ? `port ${port} already in use — try /chair on --port <n>` : (e as Error).message;
      emitResult(pi, `▶ chair: could not start — ${msg}`);
      return;
    }
    bridge = b;
    sessionToken = process.env.OVERCAST_CHAIR_TOKEN ? undefined : token; // reuse across reloads (pin isn't ours to keep)
    chairDesired = true; // now running by intent → survives reloads
    // store the RESOLVED bind + the ACTUAL bound port, so a reload rebinds to the
    // same concrete address the phone is paired to (an ephemeral 0 became a real
    // port; a partial rebind kept the prior bind)
    lastStartOpts = { bind, port: b.port };
    showQr();
    showStatus();
  }

  async function stopChair(): Promise<void> {
    if (!bridge) return;
    flush(); // deliver any coalesced assistant text before the sockets close
    resetStream(); // drop live/partial state so a later bridge can't expose a ghost `live`
    pendingChair.length = 0; // a pending injection can't attribute across a restart
    const b = bridge;
    bridge = undefined;
    hideQr();
    await b.stop();
  }

  function showQr(): void {
    if (!bridge || ctx?.mode !== "tui") return;
    const lines = [
      "  ◉ CHAIR — scan to pair (token is in the QR only)",
      "",
      ...qrLines(bridge.pairingUrl).map((l) => "  " + l),
      "",
      `  ${bridge.url}   ·   /chair qr to hide`,
    ];
    ctx.ui.setWidget(QR_WIDGET_KEY, lines);
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
        `▶ chair: online at ${bridge.url}`,
        `  bind ${bridge.bind}:${bridge.port} · clients ${bridge.clientCount()} · case://${openCaseName(process.env.OVERCAST_CASE || ctx?.cwd || process.cwd())}`,
        `  pair with the QR above (token is in the QR), or over Tailscale: /chair on tailnet`,
      ].join("\n"),
    );
  }

  // --- /chair command ----------------------------------------------------------

  pi.registerFlag("chair", { type: "boolean", description: "start the man-in-the-chair remote bridge on launch" });

  pi.registerCommand("chair", {
    description: "man in the chair: remote-drive this session from your phone (on|off|status|qr)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
      return ["on", "off", "status", "qr", "on tailnet"]
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
        // honest about rotation: a pinned OVERCAST_CHAIR_TOKEN survives restarts
        emitResult(
          pi,
          process.env.OVERCAST_CHAIR_TOKEN
            ? "▶ chair: offline (token pinned via OVERCAST_CHAIR_TOKEN — unset it to rotate)"
            : "▶ chair: offline (token rotated)",
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
