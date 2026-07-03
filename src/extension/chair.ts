// Man in the chair — pi glue for the remote-drive bridge (CLAUDE.md invariant
// #1: all pi touch-points live here + registry/to-agent-tool.ts). Registers the
// `/chair` command and the `--chair` startup flag, captures the live session
// context, translates pi events into the chair wire protocol, and injects
// remote prompts back into the loop. The transport/auth/HTTP lives in the
// pi-free core (src/chair/bridge.ts) so it stays unit-testable.
//
// The LLM gets NO chair tool: opening a network listener is an operator action,
// never something the agent can trigger (invariant #10, untrusted content).

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
  let autostarted = false;
  let qrVisible = false;
  // count of chair-injected prompts awaiting their message_start, so a live
  // "chair" label reflects an ACTUAL injection — not merely a desk message that
  // happens to start with the [chair] marker (Bugbot round 4).
  let pendingChairMsgs = 0;

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

  const capture = (c: ExtensionContext): void => {
    ctx = c;
  };

  // the live case dir for this session (follows --case / a session switch), read
  // fresh each call so a running bridge never reports a stale case.
  const caseCwd = (): string => process.env.OVERCAST_CASE || ctx?.cwd || process.cwd();

  // Classify a user message as desk- or chair-originated. `live` (message_start)
  // consumes a pending injection so the label reflects a real chair prompt, not
  // a desk message that merely starts with the marker. Replayed history has no
  // such signal, so it falls back to the marker heuristic (best-effort).
  const classifyUser = (raw: string, live: boolean): { source: "desk" | "chair"; text: string } => {
    const marked = raw.startsWith(CHAIR_PREFIX);
    const chair = marked && (live ? pendingChairMsgs > 0 : true);
    if (live && chair) pendingChairMsgs--;
    return chair ? { source: "chair", text: raw.slice(CHAIR_PREFIX.length) } : { source: "desk", text: raw };
  };

  const buildAgent = (): ChairAgent => ({
    isIdle: () => ctx?.isIdle() ?? true,
    abort: () => ctx?.abort(),
    sendUserMessage: (text, opts) => {
      pendingChairMsgs++;
      pi.sendUserMessage(CHAIR_PREFIX + text, opts);
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
    onRemotePrompt: (info) => ctx?.ui.notify(`chair: remote prompt (${info.mode})`, "info"),
  });

  // --- event → wire translators -----------------------------------------------

  pi.on("session_start", async (_e, c) => {
    capture(c);
    if (!autostarted && (pi.getFlag("chair") === true || envTruthy(process.env.OVERCAST_CHAIR))) {
      await startChair();
      // only latch on success — a failed autostart (e.g. EADDRINUSE) stays
      // retryable on the next session_start (reload/new/resume) or via /chair on
      autostarted = bridge?.running === true;
    }
  });
  pi.on("session_shutdown", async () => {
    await stopChair(); // flushes coalesced deltas before the sockets close
    // reload/new/resume/fork fire session_shutdown then session_start; clear the
    // latch so an OVERCAST_CHAIR / --chair bridge re-autostarts for the next
    // session (and rebinds to its — possibly changed — case) instead of staying
    // offline until a manual /chair on.
    autostarted = false;
  });

  pi.on("agent_start", (_e, c) => {
    capture(c);
    bridge?.publish({ type: "agent", phase: "start" });
  });
  pi.on("agent_end", (_e, c) => {
    capture(c);
    flush();
    bridge?.publish({ type: "agent", phase: "end" });
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
    bridge?.publish({ type: "state", busy: !(ctx?.isIdle() ?? true), pending: ctx?.hasPendingMessages() ?? false, model: e.model.id });
  });

  pi.on("message_start", (e, c) => {
    capture(c);
    const role = (e.message as { role?: string }).role;
    if (role === "assistant") livePartial = ""; // fresh assistant line begins
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
    if (ev.type === "text_delta") textBuf += ev.delta; // livePartial advances on flush
    else if (ev.type === "thinking_delta") thinkBuf += ev.delta;
    else return;
    if (bridge) scheduleFlush();
  });
  pi.on("message_end", (e, c) => {
    capture(c);
    const role = (e.message as { role?: string }).role;
    if (role === "assistant") livePartial = ""; // finalized; snapshot uses getBranch now
    if (!bridge) return;
    flush();
    if (role === "assistant") {
      const text = messageText(e.message);
      bridge.publish({ type: "message", phase: "end", role: "assistant", text });
    }
  });

  pi.on("tool_execution_start", (e, c) => {
    capture(c);
    bridge?.publish({ type: "tool", phase: "start", toolCallId: e.toolCallId, name: e.toolName, argsSummary: summarizeArgs(e.args) });
  });
  pi.on("tool_execution_end", (e, c) => {
    capture(c);
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
    const bind = opts.bind || process.env.OVERCAST_CHAIR_BIND || "127.0.0.1";
    const port = opts.port ?? envPort(process.env.OVERCAST_CHAIR_PORT) ?? 7373;
    const profile = loadProfile({ profile: process.env.OVERCAST_PROFILE || undefined });
    const b = new ChairBridge({
      agent: buildAgent(), // caseName/caseDir are read live from the agent
      profile: profile.name ?? "default",
      version: OVERCAST_VERSION,
      bind,
      port,
      token: process.env.OVERCAST_CHAIR_TOKEN || undefined,
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
    showQr();
    showStatus();
  }

  async function stopChair(): Promise<void> {
    if (!bridge) return;
    flush(); // deliver any coalesced assistant text before the sockets close
    const b = bridge;
    bridge = undefined; // rotate: the next start mints a fresh token (unless pinned)
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
