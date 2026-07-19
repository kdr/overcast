// /situation — pi glue for the live monitoring page (CLAUDE.md invariant #1:
// pi touch-points live in src/extension/). Runs the SituationServer IN-PROCESS,
// bound to the TUI session lifecycle (started on /situation on or --situation,
// stopped on session shutdown, restarted across reloads with the SAME token so
// an open console stays paired) — the TUI twin of the blocking CLI
// `overcast situation` pane.
//
// Like the chair, the LLM gets NO tool that can OPEN the listener: /situation
// on is an operator command (invariant #10). The agent controls a running page
// through the `situation` verb's agent-safe ops (status/set/stop → control.json,
// consumed by this in-process server's poll tick like any other).
//
// The TUI server is a VIEWER: it never owns a monitor cadence (--every). In a
// session the AGENT is the ingestion loop (scan --pull / monitor --once); a
// standing cadence belongs in its own pane (`overcast situation --every 15m`).

import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { openCase } from "../case.js";
import { OVERCAST_VERSION } from "../version.js";
import { SituationServer } from "../situation/server.js";
import { situationConsoleDir } from "../situation/assets.js";
import {
  clearRuntime,
  clearStaleStop,
  parsePanels,
  readControl,
  controlBlocked,
  readRuntime,
  registerInProcessSituation,
  runtimeServing,
  writeRuntime,
  type SituationConfig,
} from "../situation/state.js";
import { situationVerb } from "../verbs/situation.js";
import { parseVerbArgs } from "../registry/to-cli.js";
import { persistRecords } from "../registry/persist.js";
import { tokenizeCommand } from "../providers/sources/index.js";
import { loadProfile, resolveHome } from "../profile.js";
import type { VerbContext } from "../registry/types.js";
import { renderForFormat } from "../render.js";
import { detectTailnetAddr } from "../chair/net.js";
import { qrLines } from "../chair/qr.js";
import { emitResult } from "./slash.js";
import { osOpen } from "../media/view.js";

const QR_WIDGET_KEY = "situation-qr";

interface StartOptions {
  bind?: string;
  port?: number;
  config?: SituationConfig;
  /** data-refresh cadence override (ms) — mirrors the CLI serve --poll */
  pollMs?: number;
  /** open the browser on the desk after binding (default true for /situation on) */
  open?: boolean;
  /** don't clearStaleStop before binding — a case-switch rebind already checked
   *  for a pending stop, and one landing DURING the rebind is fresh intent that
   *  the new server's first control tick must honor, not a stale leftover. */
  preservePendingStop?: boolean;
}

export interface SituationHandle {
  /** For tests: the live server, if any. */
  server(): SituationServer | undefined;
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

export function registerSituation(pi: ExtensionAPI): SituationHandle {
  let ctx: ExtensionContext | undefined;
  let server: SituationServer | undefined;
  let qrVisible = false;
  // intent flags, mirroring the chair: a manual /situation on survives reloads
  // (session_shutdown → session_start restarts the server with the SAME token
  // so an open console stays paired); /situation off suppresses autostart.
  let desired = false;
  let optedOut = false;
  let sessionToken: string | undefined;
  let lastStartOpts: StartOptions = {};
  let stopping: Promise<void> = Promise.resolve();
  // the case dir the in-process server was bound to; if the session switches case
  // (a `--case`/session change) while the page is up, we rebind to the new case
  // so the page + control loop follow the session (Bugbot #98/med — otherwise the
  // pinned server keeps serving the old store while set/stop write the new case).
  let serverCaseDir: string | undefined;
  let rebinding = false;

  // In-process seam (Bugbot #98/med): the verb's status/set/stop — run by the
  // agent tool / slash in THIS process — steer the case the live page is
  // actually bound to, even while a session case switch hasn't rebound it yet.
  registerInProcessSituation(() => (server?.running ? serverCaseDir : undefined));

  const caseCwd = (): string => process.env.OVERCAST_CASE || ctx?.cwd || process.cwd();

  /** Rebind the running page when the session's case changed under it. */
  const reconcileCase = (): void => {
    if (!server?.running || !serverCaseDir || rebinding) return;
    const cur = openCase(caseCwd()).dir;
    if (cur === serverCaseDir) return;
    rebinding = true;
    void (async () => {
      try {
        // A stop already queued on the NEW case (a `situation stop` that landed
        // in the window before this rebind) is fresh operator/agent intent —
        // honor it instead of restarting over it (Bugbot #98/high: the restart
        // used to clearStaleStop it away and bring the page straight back up).
        const next = openCase(cur);
        // readControl only returns the APPLYABLE prefix, so a stop sitting
        // behind an unreadable patch is invisible here. Treat a blocked log as
        // "cannot confirm" and leave the page up rather than acting on a
        // half-read queue — the server's own tick is equally stuck, so nothing
        // is silently skipped.
        if (!controlBlocked(next) && readControl(next)?.stop === true) {
          optedOut = true;
          desired = false;
          sessionToken = undefined;
          clearStaleStop(next); // consumed: the page goes down now
          await stopSituation();
          emitResult(pi, "▶ situation: stopped (a stop was pending on the switched-to case)");
          return;
        }
        await stopSituation();
        // The view config is CASE-scoped — panels/source/since were tuned for
        // the OLD case's content (Bugbot #98/med) — so reset it to auto on a
        // case switch; bind/port/token stay session-scoped. A `situation set`
        // already written to the new case still applies on the first tick, and
        // a stop landing mid-rebind is preserved for the first tick to honor.
        await startSituation({ ...lastStartOpts, config: {}, open: false, preservePendingStop: true });
      } finally {
        rebinding = false;
      }
    })();
  };

  const capture = (c: ExtensionContext): void => {
    ctx = c;
    reconcileCase();
  };

  async function startSituation(opts: StartOptions = {}): Promise<void> {
    const c = openCase(caseCwd());
    c.ensure();
    // a CLI pane already serving this case → point at it instead of fighting
    // over runtime.json (and probably the port). Require the port to actually be
    // served (not just a live/reused pid) before deferring to it.
    const existing = readRuntime(c);
    if (existing && existing.pid !== process.pid && (await runtimeServing(existing))) {
      emitResult(pi, `▶ situation: already live at ${existing.displayUrl} (pid ${existing.pid}, ${existing.mode}) — /situation off won't touch it; use \`overcast situation stop\``);
      return;
    }
    if (server?.running) {
      // bare `/situation on` while running just reports; an explicit bind/port
      // rebinds (rotating nothing — the session token is reused).
      if (opts.bind === undefined && opts.port === undefined && opts.config === undefined && opts.pollMs === undefined) {
        await showStatus();
        return;
      }
      await stopSituation();
    }
    await stopping; // wait for any in-flight stop to release the port
    if (!opts.preservePendingStop) clearStaleStop(c); // drop a stale stop:true that would kill us on tick 1
    const bind = opts.bind || lastStartOpts.bind || process.env.OVERCAST_SITUATION_BIND || "127.0.0.1";
    const port = opts.port ?? lastStartOpts.port ?? envPort(process.env.OVERCAST_SITUATION_PORT) ?? 7374;
    const token = process.env.OVERCAST_SITUATION_TOKEN || sessionToken || randomBytes(32).toString("base64url");
    const config = opts.config ?? lastStartOpts.config ?? {};
    const pollMs = opts.pollMs ?? lastStartOpts.pollMs;
    const s = new SituationServer({
      case: c,
      version: OVERCAST_VERSION,
      bind,
      port,
      token,
      assetsDir: situationConsoleDir(),
      publicUrl: process.env.OVERCAST_SITUATION_URL || undefined,
      config,
      pollMs,
      every: null, // TUI server is a viewer; the agent (or a CLI pane) ingests
      onStopRequested: () => {
        // `situation stop` (agent/CLI) reached the in-process server — honor it
        // as an operator-visible off, including across reloads.
        optedOut = true;
        desired = false;
        sessionToken = undefined;
        void stopSituation().then(() => emitResult(pi, "▶ situation: stopped (control)"));
      },
    });
    try {
      await s.start();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      emitResult(pi, `▶ situation: could not start — ${code === "EADDRINUSE" ? `port ${port} already in use (try /situation on --port <n>)` : (e as Error).message}`);
      return;
    }
    server = s;
    serverCaseDir = c.dir; // track the bound case so a session case switch rebinds
    sessionToken = process.env.OVERCAST_SITUATION_TOKEN ? undefined : token;
    desired = true;
    lastStartOpts = { bind, port: s.port, config, pollMs };
    writeRuntime(c, {
      pid: process.pid,
      port: s.port,
      bind: s.bind,
      url: s.url,
      displayUrl: s.displayUrl,
      startedAt: new Date().toISOString(),
      caseDir: c.dir,
      every: null,
      mode: "tui",
    });
    if (opts.open !== false) osOpen(s.pairingUrl);
    showQr();
    await showStatus();
  }

  async function stopSituation(): Promise<void> {
    const s = server;
    if (!s) return;
    server = undefined;
    hideQr();
    // clear the runtime of the case the SERVER was bound to (serverCaseDir), NOT
    // the session's current case — on a case-switch rebind those differ, and
    // clearing caseCwd() would leave the old case's runtime dangling and wrongly
    // wipe the new one.
    const boundCase = serverCaseDir ?? caseCwd();
    serverCaseDir = undefined;
    // Stop the LISTENER first, THEN clear runtime.json (Bugbot #98/med): clearing
    // it while the port is still open advertises "offline" to another
    // `situation`/glance for the shutdown window, which could race a rebind.
    stopping = s.stop();
    await stopping;
    try {
      clearRuntime(openCase(boundCase));
    } catch {
      /* best-effort */
    }
  }

  function showQr(): void {
    if (!server || ctx?.mode !== "tui") return;
    const s = server;
    const lines = [
      "  ◉ SITUATION — scan to open the live wall (token is in the QR only)",
      "",
      ...qrLines(s.pairingUrl).map((l) => "  " + l),
      "",
      `  ${s.displayUrl}   ·   /situation qr to hide`,
    ];
    // component factory, not string[] — pi caps array widgets at 10 lines,
    // which would chop the QR (same fix as the chair widget).
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

  async function showStatus(): Promise<void> {
    if (!server) {
      // an EXTERNAL runtime is "live" only if its port is actually served (pid +
      // port), not off a live/reused pid alone (Bugbot #98/med) — matching the
      // verb's status/set/stop and the chair glance.
      const rt = readRuntime(openCase(caseCwd()));
      if (await runtimeServing(rt)) {
        emitResult(pi, `▶ situation: live at ${rt!.displayUrl} (pid ${rt!.pid}, ${rt!.mode} — external to this session)`);
      } else {
        emitResult(pi, "▶ situation: offline — /situation on");
      }
      return;
    }
    emitResult(
      pi,
      [
        `▶ situation: live at ${server.displayUrl}`,
        `  bind ${server.bind}:${server.port} · clients ${server.clientCount()} · viewer mode (the agent feeds it; \`overcast situation --every 15m\` in a pane owns a cadence)`,
        "  pair with the QR (token is in the QR) · situation set/stop steer it (also from the agent or chair)",
      ].join("\n"),
    );
  }

  /** Run an agent-safe verb op (status/set/stop) through the real verb, so flag
   *  parsing/validation/records match the CLI exactly. */
  async function runVerbOp(action: string, argv: string[]): Promise<void> {
    const parsed = parseVerbArgs(situationVerb, [action, ...argv]);
    if (parsed.errors.length) {
      emitResult(pi, `▶ situation: ${parsed.errors.join("; ")}`);
      return;
    }
    // The verb itself resolves the bound case via the in-process seam
    // (registerInProcessSituation above), so the ctx case here is just the
    // session case the record persists to.
    const c = openCase(caseCwd());
    c.ensure();
    const profileName = process.env.OVERCAST_PROFILE || "default";
    const vctx: VerbContext = {
      input: parsed.input,
      rest: parsed.rest,
      opts: parsed.opts,
      case: c,
      profile: loadProfile({ profile: profileName }),
      home: resolveHome(),
      profileName,
      surface: "slash",
    };
    try {
      const recs = await situationVerb.run(vctx);
      persistRecords(c, recs);
      const fmt = parsed.opts.json ? "json" : (parsed.opts.format as string | undefined);
      emitResult(pi, recs.map((r) => `▶ ${renderForFormat(r, fmt)}`).join("\n\n"));
    } catch (e) {
      emitResult(pi, `▶ situation ${action} failed: ${(e as Error).message}`);
    }
  }

  pi.on("session_start", async (_e, c) => {
    capture(c);
    const wantByConfig = pi.getFlag("situation") === true || envTruthy(process.env.OVERCAST_SITUATION);
    if (!optedOut && (desired || wantByConfig)) {
      desired = true;
      if (!server?.running) await startSituation({ ...lastStartOpts, open: false }); // a reload must not pop a second tab
    }
  });
  pi.on("session_shutdown", async () => {
    // reload/new/resume/fork: stop the listener but keep desired/token so the
    // next session_start restarts it and the open console stays paired.
    await stopSituation();
  });
  // Follow a mid-session case switch promptly (Bugbot #98/high): capture (→
  // reconcileCase) on the same live events the chair uses, not only at
  // session_start / a slash command — so an agent-tool `situation set/stop`
  // right after a switch finds the page already rebound (or its queued stop
  // honored by the rebind).
  pi.on("agent_start", (_e, c) => capture(c));
  pi.on("turn_start", (_e, c) => capture(c));
  pi.on("tool_execution_start", (_e, c) => capture(c));
  pi.on("tool_execution_end", (_e, c) => capture(c));

  pi.registerFlag("situation", { type: "boolean", description: "start the live situation page on launch" });

  pi.registerCommand("situation", {
    description:
      "monitor the situation: live wall/feed/map page over this case (on [tailnet|--bind|--port|--panels|--no-open …]|off|status|qr|set …|stop)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
      return ["on", "off", "status", "qr", "set", "stop", "on tailnet"]
        .filter((s) => s.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args: string, c): Promise<void> => {
      capture(c);
      const tokens = args.trim() ? tokenizeCommand(args.trim()) : [];
      const sub = (tokens[0] || "status").toLowerCase();
      if (sub === "off") {
        optedOut = true;
        desired = false;
        sessionToken = undefined; // rotate: the next /situation on mints a fresh token
        const wasRunning = server?.running === true;
        await stopSituation();
        emitResult(pi, wasRunning ? "▶ situation: offline (token rotated)" : "▶ situation: already offline");
        return;
      }
      if (sub === "qr") {
        if (!server) return void emitResult(pi, "▶ situation: offline — /situation on first");
        if (qrVisible) {
          hideQr();
          emitResult(pi, "▶ situation: QR hidden — /situation qr to show it again");
        } else {
          showQr();
        }
        return;
      }
      if (sub === "status") {
        await showStatus();
        return;
      }
      if (sub === "set" || sub === "stop") {
        await runVerbOp(sub, tokens.slice(1));
        return;
      }
      if (sub === "on" || sub === "start") {
        optedOut = false;
        const opts: StartOptions = {};
        const config: SituationConfig = {};
        const rest = tokens.slice(1);
        for (let i = 0; i < rest.length; i++) {
          const t = rest[i];
          if (t === "tailnet") {
            const addr = detectTailnetAddr();
            if (!addr) return void emitResult(pi, "▶ situation: no tailnet (100.64.0.0/10) address found — is Tailscale up?");
            opts.bind = addr;
          } else if (t === "--bind") opts.bind = rest[++i];
          else if (t === "--port") {
            const port = envPort(rest[++i]);
            if (port === undefined) return void emitResult(pi, "▶ situation: --port must be a number 0–65535");
            opts.port = port;
          } else if (t === "--panels") {
            try {
              const raw = rest[++i] ?? "";
              config.panels = raw.toLowerCase() === "auto" ? [] : parsePanels(raw);
            } catch (e) {
              return void emitResult(pi, `▶ situation: ${(e as Error).message}`);
            }
          } else if (t === "--no-open") opts.open = false;
          else if (t === "--source") config.source = rest[++i];
          else if (t === "--since") config.since = rest[++i];
          else if (t === "--limit") {
            const n = Number(rest[++i]);
            if (!Number.isFinite(n) || n <= 0) return void emitResult(pi, "▶ situation: --limit must be a positive number");
            config.limit = Math.floor(n);
          } else if (t === "--query") config.query = rest[++i];
          else if (t === "--poll") {
            const n = Number(rest[++i]);
            if (!Number.isFinite(n) || n <= 0) return void emitResult(pi, "▶ situation: --poll must be seconds > 0");
            opts.pollMs = Math.round(n * 1000);
          } else if (t === "--theme") {
            const theme = rest[++i];
            if (theme !== "csi" && theme !== "plain") return void emitResult(pi, "▶ situation: --theme must be csi or plain");
            config.theme = theme;
          } else {
            // don't silently drop a flag the CLI serve documents (or a typo)
            return void emitResult(pi, `▶ situation: unknown option "${t}" — on [tailnet] [--bind a] [--port n] [--panels p] [--source s] [--since t] [--limit n] [--query q] [--poll s] [--theme csi|plain] [--no-open]`);
          }
        }
        if (Object.keys(config).length) opts.config = config;
        await startSituation(opts);
        return;
      }
      emitResult(pi, `▶ situation: unknown subcommand "${sub}" — use on | off | status | qr | set | stop`);
    },
  });

  return { server: () => server };
}
