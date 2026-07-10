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
  readRuntime,
  runtimeAlive,
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
  /** open the browser on the desk after binding (default true for /situation on) */
  open?: boolean;
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

  const capture = (c: ExtensionContext): void => {
    ctx = c;
  };
  const caseCwd = (): string => process.env.OVERCAST_CASE || ctx?.cwd || process.cwd();

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
      if (opts.bind === undefined && opts.port === undefined && opts.config === undefined) {
        showStatus();
        return;
      }
      await stopSituation();
    }
    await stopping; // wait for any in-flight stop to release the port
    clearStaleStop(c); // drop a stale stop:true that would kill us on tick 1
    const bind = opts.bind || lastStartOpts.bind || process.env.OVERCAST_SITUATION_BIND || "127.0.0.1";
    const port = opts.port ?? lastStartOpts.port ?? envPort(process.env.OVERCAST_SITUATION_PORT) ?? 7374;
    const token = process.env.OVERCAST_SITUATION_TOKEN || sessionToken || randomBytes(32).toString("base64url");
    const config = opts.config ?? lastStartOpts.config ?? {};
    const s = new SituationServer({
      case: c,
      version: OVERCAST_VERSION,
      bind,
      port,
      token,
      assetsDir: situationConsoleDir(),
      publicUrl: process.env.OVERCAST_SITUATION_URL || undefined,
      config,
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
    sessionToken = process.env.OVERCAST_SITUATION_TOKEN ? undefined : token;
    desired = true;
    lastStartOpts = { bind, port: s.port, config };
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
    showStatus();
  }

  async function stopSituation(): Promise<void> {
    const s = server;
    if (!s) return;
    server = undefined;
    hideQr();
    // Stop the LISTENER first, THEN clear runtime.json (Bugbot #98/med): clearing
    // it while the port is still open advertises "offline" to another
    // `situation`/glance for the shutdown window, which could race a rebind.
    stopping = s.stop();
    await stopping;
    try {
      clearRuntime(openCase(caseCwd()));
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

  function showStatus(): void {
    if (!server) {
      const rt = readRuntime(openCase(caseCwd()));
      if (runtimeAlive(rt)) {
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

  pi.registerFlag("situation", { type: "boolean", description: "start the live situation page on launch" });

  pi.registerCommand("situation", {
    description:
      "monitor the situation: live wall/feed/map page over this case (on [tailnet|--bind|--port|--panels …]|off|status|qr|set …|stop)",
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
        showStatus();
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
          } else if (t === "--source") config.source = rest[++i];
          else if (t === "--since") config.since = rest[++i];
          else if (t === "--theme") {
            const theme = rest[++i];
            if (theme !== "csi" && theme !== "plain") return void emitResult(pi, "▶ situation: --theme must be csi or plain");
            config.theme = theme;
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
