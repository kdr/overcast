// ---- situation (live monitoring page) ----------------------------------------
// "Monitor the situation": a token-authenticated live web page over the case —
// wall tiles looping at evidence moments, a reverse-chron feed of scan hits, a
// live map of gps-bearing records, and refreshing webcam/browser stills —
// updating as records land. The server/model live in src/situation/; this verb
// owns the CLI surface:
//
//   serve  (default; CLI-ONLY) — blocking foreground process for its own
//          terminal pane: start the server, print the pairing QR, open the
//          browser, optionally own the monitor cadence (--every), run until
//          Ctrl-C / `situation stop`. Opening a network listener is an operator
//          action (the chair rule) — the agent tool and TUI slash are refused
//          here (use /situation on in the TUI; it runs in-process).
//   status / set / stop — the control plane, agent-safe: they only read
//          .overcast/situation/runtime.json or write control.json, which the
//          serving process applies on its next poll tick (~2s).

import { makeRecord, errRecord, type OvercastRecord } from "../record.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";
import { persistRecords } from "../registry/persist.js";
import { normalizeHtmlTheme } from "../report/html.js";
import { parseSince } from "../providers/memory/local.js";
import { monitorVerb, parseInterval } from "./osint.js";
import { osOpen } from "../media/view.js";
import { qrLines } from "../chair/qr.js";
import { OVERCAST_VERSION } from "../version.js";
import { SituationServer } from "../situation/server.js";
import { situationConsoleDir } from "../situation/assets.js";
import { openCase, type Case } from "../case.js";
import {
  CLEARABLE_CONFIG_KEYS,
  clearRuntime,
  clearStaleStop,
  inProcessSituationCaseDir,
  parsePanels,
  readControl,
  readRuntime,
  runtimeAlive,
  runtimeServing,
  writeControl,
  writeRuntime,
  type ClearableConfigKey,
  type SituationConfig,
  type SituationControl,
} from "../situation/state.js";

const err = (message: string): OvercastRecord => errRecord("situation", message);

/** Persist immediately + mark persisted, so a record emitted from inside the
 *  blocking serve loop lands in case history without waiting for the return
 *  (the checkpoint pattern from scan --pull / monitor --every). */
function checkpoint(ctx: VerbContext, rec: OvercastRecord): OvercastRecord {
  rec.meta = { ...rec.meta, case: ctx.case.dir };
  ctx.case.writeRecord(rec);
  rec.meta = { ...rec.meta, persisted: true };
  return rec;
}

/** Parse the shared view-config flags (used by serve and set). Returns an error
 *  record on an invalid value. */
function parseConfigFlags(ctx: VerbContext): { config: SituationConfig } | { error: OvercastRecord } {
  const config: SituationConfig = {};
  if (ctx.opts.panels != null) {
    const raw = String(ctx.opts.panels).trim();
    try {
      config.panels = raw.toLowerCase() === "auto" ? [] : parsePanels(raw);
    } catch (e) {
      return { error: err((e as Error).message) };
    }
  }
  if (ctx.opts.source != null) {
    const source = String(ctx.opts.source).trim();
    if (!source) return { error: err("--source requires a value (source id or type, comma list)") };
    config.source = source;
  }
  if (ctx.opts.since != null) {
    const since = String(ctx.opts.since);
    if (parseSince(since) == null) return { error: err(`invalid --since: ${since} (try 24h, 7d, or 2026-06-01)`) };
    config.since = since;
  }
  if (ctx.opts.limit != null) {
    const n = Number(ctx.opts.limit);
    if (!Number.isFinite(n) || n <= 0) return { error: err(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`) };
    config.limit = Math.floor(n);
  }
  if (ctx.opts.theme != null) {
    const theme = normalizeHtmlTheme(ctx.opts.theme);
    if (!theme) return { error: err(`invalid --theme '${ctx.opts.theme}' (expected plain or csi)`) };
    config.theme = theme;
  }
  if (ctx.opts.query != null) config.query = String(ctx.opts.query);
  return { config };
}

function hasConfigFlags(config: SituationConfig): boolean {
  return Object.keys(config).length > 0;
}

function parsePort(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** The case whose control plane status/set/stop steer: normally the ctx case,
 *  but when THIS process hosts the in-process TUI page bound to a different
 *  case (the mid-case-switch window before reconcileCase rebinds), steer the
 *  BOUND case — that's the store the live page actually polls (Bugbot #98/med:
 *  agent/chair set/stop used to write control the server never read). */
function controlCase(ctx: VerbContext): Case {
  const bound = inProcessSituationCaseDir();
  if (bound && bound !== ctx.case.dir) return openCase(bound);
  return ctx.case;
}

export const situationVerb: VerbSpec = {
  name: "situation",
  group: "inspect",
  summary:
    "Monitor the situation: a live web page over the case — wall + feed + map + stills, updating as records land (serve | status | set | stop).",
  description:
    "`serve` (default; operator/CLI only — run it in its own terminal pane) starts a token-authenticated " +
    "local server (default 127.0.0.1:7374) and opens the live console: video-wall tiles looping at their " +
    "evidence moments, a reverse-chron feed of scan hits, a live map of every gps-bearing record " +
    "(flights build tracks), and the freshest webcam/browser stills — panels auto-picked from your " +
    "configured sources unless --panels pins them. The page refreshes itself whenever case records land " +
    "(from the agent, `scan --pull`, or a separate `monitor --every`); with --every the serving process " +
    "runs the monitor cadence itself, so one command IS 'monitor the situation'. Local media streams " +
    "over an authenticated /media route (remote embeds stay off unless OVERCAST_REPORT_REMOTE_MEDIA=1). " +
    "`status`/`set`/`stop` are the agent-safe control plane via .overcast/situation/ — `set` retunes " +
    "panels/filters/theme on the fly, `stop` shuts the page down (applied within ~2s). In the TUI, " +
    "/situation on runs the server in-process instead.",
  args: [
    {
      name: "action",
      summary: "serve | status | set | stop (default: serve)",
      required: false,
      choices: ["serve", "status", "set", "stop"],
    },
  ],
  flags: [
    { name: "every", summary: "serve: own the monitor cadence (e.g. 5m, 1h) — runs a monitor pass each interval", type: "string" },
    { name: "port", summary: "serve: listen port (default 7374; 0 = ephemeral)", type: "number" },
    { name: "bind", summary: "serve: bind address (default 127.0.0.1 — keep it off public ifaces)", type: "string" },
    { name: "panels", summary: "Panels to show: comma list of wall,feed,map,stills — or 'auto' (default: auto from sources)", type: "string" },
    { name: "source", summary: "Only content from these source ids/types (comma list)", type: "string" },
    { name: "since", summary: "Only content since (e.g. 24h, 7d, 2026-06-01)", type: "string" },
    { name: "limit", summary: "Max wall tiles (default 12; other panels have fixed caps)", type: "number" },
    { name: "theme", summary: "Console theme: csi | plain", type: "string", choices: ["csi", "plain"], default: "csi" },
    { name: "query", summary: "Ad-hoc monitor query (used by the --every cadence)", type: "string" },
    { name: "clear", summary: "set: drop filters back to default/auto (comma list of panels,source,since,limit,theme,query)", type: "string" },
    { name: "poll", summary: "serve: data-refresh cadence seconds (default 60; control stays ~2s; ⟳/monitor passes force now)", type: "number" },
    { name: "no-open", summary: "serve: don't launch the browser", type: "boolean" },
    { name: "force", summary: "stop: also SIGTERM the serving pid (when control isn't picked up)", type: "boolean" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "situation",
  providerKey: "situation",
  run: async (ctx) => {
    // Default action is surface-aware: a bare `situation` from the CLI opens the
    // page (serve), but from the AGENT tool / TUI slash it defaults to `status`
    // — a useful read-only op — rather than hitting the operator-only serve guard
    // and returning an error (Bugbot #98/med). status/set/stop are the agent
    // entrypoints; serve stays CLI-only.
    const action = (ctx.input ?? (ctx.surface === "cli" ? "serve" : "status")).toLowerCase();

    // status/set/stop steer the control case (the in-process page's bound case
    // when it lags a session case switch; else the ctx case).
    const cc = controlCase(ctx);

    if (action === "status") return [await statusRecord(ctx, cc)];

    if (action === "set") {
      const parsed = parseConfigFlags(ctx);
      if ("error" in parsed) return [parsed.error];
      // --clear drops filters back to default/auto — without it, a running
      // server has no way to REMOVE a source/since/query filter (Bugbot
      // #98/med: applyConfig only assigns keys present in the patch).
      let clear: ClearableConfigKey[] | undefined;
      if (ctx.opts.clear != null) {
        const keys = String(ctx.opts.clear).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        const bad = keys.filter((k) => !(CLEARABLE_CONFIG_KEYS as readonly string[]).includes(k));
        if (bad.length) return [err(`--clear: unknown key(s) ${bad.join(", ")} (expected ${CLEARABLE_CONFIG_KEYS.join(" | ")})`)];
        if (keys.length) clear = [...new Set(keys)] as ClearableConfigKey[];
      }
      if (!hasConfigFlags(parsed.config) && !clear) {
        return [err("situation set: nothing to set (pass --panels/--source/--since/--limit/--theme/--query, or --clear <keys>)")];
      }
      const merged = writeControl(cc, { ...parsed.config, ...(clear ? { clear } : {}) });
      const rt = readRuntime(cc);
      // "running" must reflect a server actually SERVING (pid alive AND the port
      // is up), not just a live/reused pid (Bugbot #98/med) — else `set` tells
      // the operator "applied within ~2s" when nothing is listening.
      const running = runtimeAlive(rt) && (await runtimeServing(rt));
      return [
        makeRecord({
          verb: "situation",
          format: "json",
          payload: {
            op: "set",
            control: merged,
            running,
            note: running
              ? `applied by the live page within ~2s (${rt!.displayUrl})`
              : "no situation is running — the control applies when one starts",
            ...(cc.dir !== ctx.case.dir ? { steered_case: cc.dir } : {}),
          },
          meta: { provider: "situation", case: ctx.case.dir },
          state: "ready",
        }),
      ];
    }

    if (action === "stop") {
      const rt = readRuntime(cc);
      // a server is only "running" when its port is actually served (pid + port),
      // not off a live/reused pid alone (Bugbot #98/med).
      const running = runtimeAlive(rt) && (await runtimeServing(rt));
      if (!running) {
        clearRuntime(cc); // sweep a stale runtime from a crashed serve
        // Still queue the stop (Bugbot #98/high): the in-process TUI page
        // follows a session case switch by rebinding, and a stop issued in the
        // window before that rebind sees no runtime here yet — the queued
        // control is honored by the rebound server's first tick. A genuinely
        // fresh serve is unaffected: every serve clears a stale stop at start.
        writeControl(cc, { stop: true } satisfies SituationControl);
        return [
          makeRecord({
            verb: "situation",
            format: "json",
            payload: {
              op: "stop",
              running: false,
              note: "no situation is running — stop queued (honored by a server starting on this case; a fresh serve clears it)",
              ...(cc.dir !== ctx.case.dir ? { steered_case: cc.dir } : {}),
            },
            meta: { provider: "situation", case: ctx.case.dir },
            state: "ready",
          }),
        ];
      }
      writeControl(cc, { stop: true } satisfies SituationControl);
      let delivered = "control";
      // --force SIGTERM is ONLY for a dedicated CLI serve pane. For a `/situation
      // on` (mode "tui") the runtime pid IS the whole TUI session, so signalling
      // it would kill the operator's editor (Bugbot #98/high) — the in-process
      // server honors the control-file stop on its poll tick instead. And gate
      // the signal on the port actually being served, so a reused pid after a
      // crash (Bugbot #98/med) isn't SIGTERM'd.
      if (ctx.opts.force === true && rt) {
        if (rt.mode !== "cli") {
          delivered = "control (—force ignored: /situation on stops via control, not signal)";
        } else if (await runtimeServing(rt)) {
          try {
            process.kill(rt.pid, "SIGTERM");
            delivered = "control+signal";
          } catch {
            /* already exiting */
          }
        } else {
          delivered = "control (—force ignored: no live server on the recorded port)";
        }
      }
      return [
        makeRecord({
          verb: "situation",
          format: "json",
          payload: {
            op: "stop",
            running: true,
            pid: rt!.pid,
            url: rt!.displayUrl,
            delivered,
            ...(cc.dir !== ctx.case.dir ? { steered_case: cc.dir } : {}),
          },
          meta: { provider: "situation", case: ctx.case.dir },
          state: "ready",
        }),
      ];
    }

    // ---- serve (default) ------------------------------------------------------
    // Opening a network listener is an operator action (invariant #10, the chair
    // rule) — the agent tool must not be able to trigger it. status/set/stop
    // above stay fully agent-drivable.
    if (ctx.surface !== "cli") {
      return [
        err(
          "situation serve opens a network listener — an operator action. " +
            "Run `overcast situation` in a terminal pane (or /situation on in the TUI). " +
            "From here you can use `situation status | set | stop`.",
        ),
      ];
    }

    // refuse a second serve only when a server is ACTUALLY up (pid alive AND the
    // port is being served) — a stale runtime.json from a crash, or a reused pid
    // (Bugbot #98/med), must not block a fresh serve. This is a soft pre-check;
    // the REAL mutex is binding the port (below): two racing serves both pass
    // here, but only one can listen(), and we defer every runtime.json write
    // until AFTER a successful bind so the loser never clobbers the winner's
    // runtime (Bugbot #98/med — the pre-bind clearRuntime used to do exactly that).
    const existing = readRuntime(ctx.case);
    if (runtimeAlive(existing) && (await runtimeServing(existing))) {
      return [err(`a situation is already live at ${existing!.displayUrl} (pid ${existing!.pid}) — \`overcast situation stop\` first`)];
    }

    const parsed = parseConfigFlags(ctx);
    if ("error" in parsed) return [parsed.error];
    const config = parsed.config;

    const everyStr = ctx.opts.every != null ? String(ctx.opts.every) : undefined;
    let everyMs: number | undefined;
    if (everyStr) {
      everyMs = parseInterval(everyStr);
      if (!everyMs || everyMs <= 0) return [err(`bad --every '${everyStr}' (try 15m, 1h)`)];
    }
    const port = ctx.opts.port != null ? parsePort(ctx.opts.port) : parsePort(process.env.OVERCAST_SITUATION_PORT);
    if (ctx.opts.port != null && port === undefined) return [err("--port must be a number 0–65535")];
    let pollMs: number | undefined;
    if (ctx.opts.poll != null) {
      const n = Number(ctx.opts.poll);
      if (!Number.isFinite(n) || n <= 0) return [err(`invalid --poll: ${ctx.opts.poll} (expected seconds > 0)`)];
      pollMs = Math.round(n * 1000);
    }

    // stop plumbing: control-file stop, Ctrl-C/SIGTERM, and the agent-tool abort
    // signal all converge on one resolved reason.
    let stopReason: string | undefined;
    let resolveStop!: (reason: string) => void;
    const stopped = new Promise<string>((res) => (resolveStop = res));
    const requestStop = (reason: string): void => {
      if (stopReason) return;
      stopReason = reason;
      resolveStop(reason);
    };

    const server = new SituationServer({
      case: ctx.case,
      version: OVERCAST_VERSION,
      bind: ctx.opts.bind != null ? String(ctx.opts.bind) : process.env.OVERCAST_SITUATION_BIND || undefined,
      port,
      token: process.env.OVERCAST_SITUATION_TOKEN || undefined,
      assetsDir: situationConsoleDir(),
      publicUrl: process.env.OVERCAST_SITUATION_URL || undefined,
      config,
      every: everyStr ?? null,
      pollMs,
      onStopRequested: () => requestStop("control"),
    });
    try {
      await server.start();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // the loser of a bind race lands here and returns WITHOUT touching
      // runtime.json/control.json, so it can't clobber the winner's state.
      return [
        err(
          code === "EADDRINUSE"
            ? `port ${port ?? 7374} already in use — try --port <n>`
            : `could not start: ${(e as Error).message}`,
        ),
      ];
    }

    // bound successfully — NOW claim the case: drop a stale stop:true (so the
    // first control tick doesn't stop us) and stamp runtime.json. Only the winner
    // of the port race reaches this point.
    clearStaleStop(ctx.case);
    writeRuntime(ctx.case, {
      pid: process.pid,
      port: server.port,
      bind: server.bind,
      url: server.url,
      displayUrl: server.displayUrl,
      startedAt: new Date().toISOString(),
      caseDir: ctx.case.dir,
      every: everyStr ?? null,
      mode: "cli",
    });

    const onSignal = (): void => requestStop("signal");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const onAbort = (): void => requestStop("abort");
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    // operator-facing banner on stderr (stdout stays clean for records). The
    // pairing URL carries the token in the FRAGMENT — terminal-only, like the
    // chair QR; runtime.json/status never contain it.
    const banner = [
      `situation: live at ${server.displayUrl}`,
      `situation: pair ${server.pairingUrl}`,
      ...qrLines(server.pairingUrl).map((l) => `  ${l}`),
      `situation: ${everyStr ? `monitor cadence ${everyStr} · ` : ""}Ctrl-C or \`overcast situation stop\` to stop`,
    ];
    process.stderr.write(banner.join("\n") + "\n");
    if (ctx.opts["no-open"] !== true) osOpen(server.pairingUrl);

    checkpoint(
      ctx,
      makeRecord({
        verb: "situation",
        format: "json",
        payload: {
          op: "serve",
          url: server.url,
          display_url: server.displayUrl,
          bind: server.bind,
          port: server.port,
          every: everyStr ?? null,
          config,
        },
        meta: { provider: "situation" },
        state: "ready",
      }),
    );

    // test/scheduler knob, mirroring OVERCAST_MONITOR_MAX_PASSES
    const rawMax = Number(process.env.OVERCAST_SITUATION_MAX_PASSES);
    const maxPasses = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : Infinity;
    let passes = 0;
    let nextPassAt = everyMs ? Date.now() : Infinity;

    const runMonitorPass = async (): Promise<void> => {
      passes++;
      server.monitorStarted(passes);
      let newItems: number | undefined;
      let passError: string | undefined;
      try {
        // live config: a `situation set --source/--query/--since` mid-run
        // retunes the NEXT pass, not just the page.
        const live = server.activeConfig;
        const recs = await monitorVerb.run({
          ...ctx,
          input: undefined,
          rest: [],
          opts: {
            once: true,
            ...(live.source ? { source: live.source } : {}),
            ...(live.query ? { query: live.query } : {}),
            ...(live.since ? { since: live.since } : {}),
          },
        });
        persistRecords(ctx.case, recs);
        const summary = recs.find((r) => r.verb === "monitor");
        const items = summary && typeof summary.payload === "object" ? (summary.payload as Record<string, unknown>).new_items : undefined;
        newItems = typeof items === "number" ? items : undefined;
        if (summary?.state === "error" || summary?.state === "needs_credentials") passError = summary.error ?? summary.state;
      } catch (e) {
        passError = (e as Error).message;
      }
      server.monitorEnded(passes, { ...(newItems !== undefined ? { newItems } : {}), ...(passError ? { error: passError } : {}) });
      // the owned cadence just wrote records — refresh the page NOW rather than
      // waiting up to a full (slow) data-poll interval. Best-effort: a transient
      // rebuild failure must not break the monitor loop (the poll retries).
      await server.forceRebuild().catch(() => {});
      process.stderr.write(
        `situation: pass ${passes}${newItems !== undefined ? ` — ${newItems} new` : ""}${passError ? ` — ${passError}` : ""}\n`,
      );
    };

    try {
      while (!stopReason) {
        if (everyMs && Date.now() >= nextPassAt) {
          await runMonitorPass();
          nextPassAt = Date.now() + everyMs;
          if (passes >= maxPasses) requestStop("max_passes");
          continue;
        }
        const waitMs = Math.min(everyMs ? Math.max(250, nextPassAt - Date.now()) : 3600e3, 30e3);
        await Promise.race([stopped, sleep(waitMs)]);
      }
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      ctx.signal?.removeEventListener("abort", onAbort);
      if (stopReason !== "control") server.announceStopping(stopReason ?? "shutdown");
      await server.stop();
      clearRuntime(ctx.case);
    }
    process.stderr.write(`situation: stopped (${stopReason})\n`);

    return [
      makeRecord({
        verb: "situation",
        format: "json",
        payload: {
          op: "serve_end",
          url: server.url,
          passes,
          every: everyStr ?? null,
          stopped: stopReason,
        },
        meta: { provider: "situation", case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};

async function statusRecord(ctx: VerbContext, cc: Case = ctx.case): Promise<OvercastRecord> {
  const rt = readRuntime(cc);
  // running = pid alive AND the recorded port is actually served (Bugbot #98/med:
  // a read-only surface must not report "live" off a reused pid alone).
  const running = runtimeAlive(rt) && (await runtimeServing(rt));
  const pending = readControl(cc) ?? null;
  return makeRecord({
    verb: "situation",
    format: "json",
    payload: {
      op: "status",
      running,
      ...(rt && running
        ? {
            url: rt.url,
            display_url: rt.displayUrl,
            bind: rt.bind,
            port: rt.port,
            pid: rt.pid,
            started_at: rt.startedAt,
            every: rt.every,
            mode: rt.mode,
          }
        : {}),
      ...(rt && !running ? { note: "stale runtime.json (server not alive) — start with `overcast situation`" } : {}),
      ...(pending ? { pending_control: pending } : {}),
      ...(cc.dir !== ctx.case.dir ? { steered_case: cc.dir } : {}),
    },
    meta: { provider: "situation", case: ctx.case.dir, transient: true },
    state: "ready",
  });
}
