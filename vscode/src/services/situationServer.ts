// Owns the `overcast situation serve` child process for the Situation panel.
//
// The extension mints its own token and pins it via OVERCAST_SITUATION_TOKEN
// (src/verbs/situation.ts:346) so the iframe URL is knowable without scraping;
// runtime.json appearing (never contains the token) is the readiness signal.
// Verified live: runtime.json url ends with "/" (e.g. "http://127.0.0.1:7391/"),
// the pairing URL is `${url}#t=<token>`, /api/* is 401 without auth, and
// SIGTERM removes runtime.json on clean exit.
//
// A live server started OUTSIDE the extension can only be offered
// "Restart under Overcast" — foreign tokens are unrecoverable by design.
// Liveness mirrors src/situation/state.ts runtimeAlive/runtimeServing (that
// module is not npm-exported): pid signal-0 probe + TCP connect to the port.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtDeps, SituationRuntime } from "../types.ts";

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 300;
const FOREIGN_STOP_TIMEOUT_MS = 10_000;
const KILL_ESCALATE_MS = 3_000;

export interface SituationState {
  phase: "idle" | "starting" | "running" | "error";
  /** `${runtime.url}#t=<token>` when running (url already ends with "/") */
  iframeUrl?: string;
  /** human-facing detail (starting step, error text, or the display URL) */
  message?: string;
}

function runtimePath(caseDir: string): string {
  return path.join(caseDir, ".overcast", "situation", "runtime.json");
}

function readRuntime(caseDir: string): SituationRuntime | undefined {
  try {
    const raw = fs.readFileSync(runtimePath(caseDir), "utf8");
    const v = JSON.parse(raw) as SituationRuntime;
    if (v && typeof v.pid === "number" && typeof v.port === "number") return v;
  } catch {
    /* missing or torn — treat as absent */
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours; anything else (ESRCH) = dead
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Loopback-only host check. `runtime.json` lives INSIDE the opened workspace,
 *  so it is attacker-authorable repo content: without this a planted descriptor
 *  could name any host, and we would both probe it and hand it the situation
 *  bearer token as an iframe origin. The real server always binds loopback (or
 *  a tailnet address the operator chose via the CLI, which the extension never
 *  spawns), so anything else is a plant. */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "0.0.0.0" || /^127\./.test(h);
}

/** Is `url` an http(s) URL on loopback, on exactly the port we told the child to
 *  use? Both halves matter — a plant that names the right port on a remote host
 *  would otherwise receive the token. */
function isOwnLoopbackUrl(url: string | undefined, expectedPort: number): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!isLoopbackHost(u.hostname)) return false;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return port === expectedPort;
}

function portServing(port: number, bind?: string): Promise<boolean> {
  // Never probe a host the workspace file chose — loopback only.
  const host = bind && isLoopbackHost(bind) && bind !== "0.0.0.0" ? bind : "127.0.0.1";
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function runtimeLive(rt: SituationRuntime): Promise<boolean> {
  if (!pidAlive(rt.pid)) return false;
  return portServing(rt.port, rt.bind);
}

function lastUseful(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SituationServerManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SituationState>();
  readonly onDidChangeState = this.emitter.event;
  private current: SituationState = { phase: "idle" };
  private child: ChildProcessWithoutNullStreams | undefined;
  private childCaseDir: string | undefined;
  private starting = false;
  private stopping = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: ExtDeps) {
    this.disposables.push(
      deps.locator.onDidChangeCase(() => {
        if (this.child && this.childCaseDir && this.childCaseDir !== deps.locator.caseDir) {
          deps.output.appendLine(
            "situation: active case changed — stopping the server for the previous case",
          );
          void this.stop();
        }
      }),
    );
  }

  get state(): SituationState {
    return this.current;
  }

  private setState(next: SituationState): void {
    this.current = next;
    this.emitter.fire(next);
  }

  async start(): Promise<void> {
    if (this.starting) return;
    if (this.child && this.child.exitCode === null && this.current.phase === "running") return;
    const caseDir = this.deps.locator.caseDir;
    if (!caseDir) {
      this.setState({
        phase: "error",
        message: "No overcast case in this workspace — initialize a case first.",
      });
      return;
    }
    if (!(await this.deps.bridge.ensureCli())) {
      this.setState({ phase: "error", message: "overcast CLI not found — set overcast.path." });
      return;
    }
    this.starting = true;
    try {
      await this.doStart(caseDir);
    } finally {
      this.starting = false;
    }
  }

  private async doStart(caseDir: string): Promise<void> {
    this.setState({ phase: "starting", message: "Checking for an existing server…" });

    // Preflight: a LIVE runtime.json we didn't spawn = a foreign server whose
    // token we cannot learn. Offer the only viable path: restart under us.
    const existing = readRuntime(caseDir);
    if (existing && (await runtimeLive(existing))) {
      const pick = await vscode.window.showWarningMessage(
        "A situation server is already running for this case (started outside VS Code). Restart it under VS Code to embed it?",
        "Restart under Overcast",
        "Cancel",
      );
      if (pick !== "Restart under Overcast") {
        this.setState({
          phase: "error",
          message: `A situation server is already running at ${existing.displayUrl || existing.url} (its token can't be recovered here). Restart it under VS Code to embed it.`,
        });
        return;
      }
      this.setState({ phase: "starting", message: "Stopping the existing server…" });
      await this.deps.bridge.run(["situation", "stop"], { caseDir });
      const deadline = Date.now() + FOREIGN_STOP_TIMEOUT_MS;
      let gone = false;
      while (Date.now() < deadline) {
        const rt = readRuntime(caseDir);
        if (!rt || !(await runtimeLive(rt))) {
          gone = true;
          break;
        }
        await sleep(READY_POLL_MS);
      }
      if (!gone) {
        this.setState({
          phase: "error",
          message:
            "The existing situation server didn't stop in time. Stop it manually (`overcast situation stop --force`) and retry.",
        });
        return;
      }
    }

    // Spawn ours with a pinned token (the whole reason we can embed it).
    const token = randomBytes(32).toString("base64url");
    const args = ["situation", "serve", "--no-open"];
    const port = vscode.workspace.getConfiguration("overcast").get<number>("situation.port", 0);
    if (typeof port === "number" && port > 0) args.push("--port", String(port));
    this.setState({ phase: "starting", message: "Starting the situation server…" });
    const spawnFloor = Date.now() - 2000; // clock cushion for the freshness check
    const child = await this.deps.bridge.spawnLongLived(args, {
      caseDir,
      env: { OVERCAST_SITUATION_TOKEN: token },
    });
    if (!child) {
      this.setState({ phase: "error", message: "overcast CLI not found — set overcast.path." });
      return;
    }
    this.child = child;
    this.childCaseDir = caseDir;
    this.stopping = false;

    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.deps.output.appendLine(`  [situation] ${line}`);
      }
    });
    child.stdout.on("data", () => {
      /* keep the pipe drained; records go to stderr/stdout we don't need */
    });
    child.on("exit", (code, signal) => {
      const expected = this.stopping;
      if (this.child === child) {
        this.child = undefined;
        this.childCaseDir = undefined;
      }
      if (expected) {
        this.setState({ phase: "idle" });
        return;
      }
      const detail = lastUseful(stderrTail);
      this.setState({
        phase: "error",
        message: `The situation server exited unexpectedly (${signal ?? `code ${code}`}).${detail ? ` ${detail}` : ""}`,
      });
    });

    // Readiness: a FRESH runtime.json owned by our child, actually serving.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let runtime: SituationRuntime | undefined;
    while (Date.now() < deadline) {
      if (this.child !== child || child.exitCode !== null) return; // exit handler spoke
      const rt = readRuntime(caseDir);
      // Ownership must be PROVEN, not asserted. The old `startedAt >= spawnFloor`
      // fallback was a timestamp the untrusted file itself supplies, so a repo
      // shipping `.overcast/situation/runtime.json` with a future date and a
      // remote host was accepted as "our child" — and then handed the bearer
      // token as the panel's iframe origin. Require the real pid, and require the
      // URL to be loopback on the port we assigned.
      if (rt && rt.pid === child.pid && isLoopbackHost(rt.bind) && (await runtimeLive(rt))) {
        runtime = rt;
        break;
      }
      await sleep(READY_POLL_MS);
    }
    if (!runtime) {
      this.stopping = true;
      child.kill("SIGTERM");
      this.setState({
        phase: "error",
        message: `The situation server didn't become ready within ${READY_TIMEOUT_MS / 1000}s.${lastUseful(stderrTail) ? ` ${lastUseful(stderrTail)}` : ""}`,
      });
      return;
    }

    // runtime.url ends with "/" (verified) → pairing shape is `${url}#t=…`.
    // asExternalUri handles remote/SSH port forwarding; fragments are
    // client-side so we re-append after conversion. Desktop = passthrough.
    // Final gate before the token is bound to an origin: the URL we are about to
    // frame must be loopback on the port we assigned. (readRuntime already
    // matched the pid; this catches a torn/raced rewrite of the same file.)
    if (!isOwnLoopbackUrl(runtime.url, runtime.port)) {
      this.stopping = true;
      child.kill("SIGTERM");
      this.setState({
        phase: "error",
        message: `The situation runtime descriptor named an unexpected address (${runtime.url}) — refusing to open it.`,
      });
      return;
    }
    let base = runtime.url;
    try {
      base = (await vscode.env.asExternalUri(vscode.Uri.parse(runtime.url))).toString(true);
    } catch {
      /* keep the raw local URL */
    }
    if (!base.endsWith("/")) base += "/";
    this.deps.output.appendLine(`situation: serving for the panel at ${runtime.displayUrl}`);
    this.setState({
      phase: "running",
      iframeUrl: `${base}#t=${token}`,
      message: runtime.displayUrl || runtime.url,
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null) {
      this.stopping = true;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, KILL_ESCALATE_MS);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return; // exit handler sets phase idle
    }
    // Nothing of ours running — politely stop a live foreign server if any.
    const caseDir = this.deps.locator.caseDir;
    if (caseDir) {
      const rt = readRuntime(caseDir);
      if (rt && (await runtimeLive(rt))) {
        await this.deps.bridge.run(["situation", "stop"], { caseDir });
        this.deps.output.appendLine("situation: sent stop to the externally-started server");
      }
    }
    this.setState({ phase: "idle" });
  }

  dispose(): void {
    this.stopping = true;
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}
