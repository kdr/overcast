// The situation server: a token-authenticated live view over the case record
// stream — wall tiles, feed, map, stills — served to a browser and refreshed by
// polling the store's change fingerprint (there is no store eventing; the
// mtime/size stamp makes a no-change poll nearly free). Built on the shared
// live-server core (src/live/httpd.ts) so token auth / SSE replay / CSRF /
// static serving are the same code the chair bridge runs.
//
// Two things are unique here:
//   /media/<id>/<name> — authenticated case-media serving with Range support.
//     A page served from http:// cannot load file:// media (the static wall's
//     trick), so local media streams through the server. The servable set is an
//     ALLOWLIST derived from the current model — only media the page actually
//     shows resolves; nothing else on disk is reachable, even with the token.
//   control.json — the cross-process control plane (.overcast/situation/):
//     `situation set/stop` (CLI, agent tool, chair→agent) writes it; the server
//     applies it on the next poll tick. See src/situation/state.ts.
//
// Deliberately pi-free and case-driven, so it runs identically under the CLI
// verb (own terminal pane) and the TUI extension (/situation on).

import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { LiveHttpd, MEDIA_CONTENT_TYPES, type LiveHttpdOptions } from "../live/httpd.js";
import { reportRemoteMediaEnabled, normalizeHtmlTheme } from "../report/html.js";
import { posterFrame } from "../media/ffmpeg.js";
import { listSources } from "../state/source.js";
import { realpathContained } from "../fs-path.js";
import type { Case } from "../case.js";
import { buildSituationModel, type SituationMediaRef, type SituationModel } from "./model.js";
import { consumeControl, readControl, type SituationConfig } from "./state.js";
import type { SituationSnapshot, SituationWireEvent } from "./wire.js";

type SituationEventInput = SituationWireEvent extends infer E
  ? E extends SituationWireEvent
    ? Omit<E, "seq">
    : never
  : never;

export const SITUATION_DEFAULT_PORT = 7374;
// Two cadences: DATA refresh (fingerprint → rebuild) defaults to once a minute
// so the page isn't churning every couple seconds, while CONTROL (situation
// set/stop from the agent/CLI/chair) stays snappy so retunes/stops apply within
// a couple seconds. The ⟳ Sync-now button and owned monitor passes force an
// immediate rebuild regardless.
const POLL_MS = 60_000;
const CONTROL_MS = 2000;

export interface SituationServerOptions extends LiveHttpdOptions {
  case: Case;
  version: string;
  /** initial view config (CLI flags); mutated at runtime by control.json */
  config?: SituationConfig;
  /** the monitor cadence string the serving process owns ("5m"), display only —
   *  passes are driven by the caller via monitorStarted/monitorEnded */
  every?: string | null;
  /** store/control poll cadence; default 2s */
  pollMs?: number;
  /** false disables the ffmpeg poster pass (tests / no-ffmpeg hosts) */
  posters?: boolean;
  /** fired when control.json requests a stop — the owner shuts the loop down */
  onStopRequested?: (reason: string) => void;
  /** injectable clock for tests */
  now?: () => number;
}

export class SituationServer extends LiveHttpd<SituationEventInput> {
  private readonly opts: SituationServerOptions;
  private readonly case: Case;
  private timer: ReturnType<typeof setInterval> | undefined;
  private controlTimer: ReturnType<typeof setInterval> | undefined;
  private snapshot: Omit<SituationSnapshot, "seq"> | undefined;
  private mediaMap = new Map<string, string>();
  private prevMediaMap = new Map<string, string>();
  private viewConfig: SituationConfig;
  private lastFingerprint = "";
  private configDirty = false;
  private building = false;
  private rebuildPending = false;
  private stopRequested = false;
  private monitorInfo = { passes: 0, lastPassAt: null as string | null, running: false };

  constructor(opts: SituationServerOptions) {
    super(opts, { label: "situation", defaultPort: SITUATION_DEFAULT_PORT });
    this.opts = opts;
    this.case = opts.case;
    this.viewConfig = { ...(opts.config ?? {}) };
  }

  get activeConfig(): SituationConfig {
    return { ...this.viewConfig };
  }

  override async start(): Promise<{ url: string; pairingUrl: string; port: number }> {
    const started = await super.start();
    await this.rebuild();
    const pollMs = this.opts.pollMs ?? POLL_MS;
    // data rebuild at the (slow) poll cadence; control at the fast cadence
    // (never slower than the data poll — a tiny --poll keeps both quick).
    this.timer = setInterval(() => void this.pollRebuildTick(), pollMs);
    this.timer.unref(); // the owner's serve loop keeps the process alive, not us
    this.controlTimer = setInterval(() => void this.applyControlTick(), Math.min(CONTROL_MS, pollMs));
    this.controlTimer.unref();
    return started;
  }

  override async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.controlTimer) clearInterval(this.controlTimer);
    this.timer = undefined;
    this.controlTimer = undefined;
    await super.stop();
  }

  /** Tell connected consoles the wall is going dark (control stop, Ctrl-C). */
  announceStopping(reason: string): void {
    this.publish({ type: "stopping", reason });
  }

  // --- monitor-cadence surface (driven by the owning serve loop) ---------------

  monitorStarted(pass: number): void {
    this.monitorInfo.running = true;
    this.publish({ type: "monitor", phase: "start", pass });
  }

  monitorEnded(pass: number, info: { newItems?: number; error?: string } = {}): void {
    this.monitorInfo.running = false;
    this.monitorInfo.passes = pass;
    this.monitorInfo.lastPassAt = new Date(this.now()).toISOString();
    this.publish({ type: "monitor", phase: "end", pass, ...info });
  }

  // --- poll ticks ---------------------------------------------------------------

  /** Apply any pending control (situation set/stop) — the FAST cadence, so a
   *  retune/stop from the agent/CLI/chair lands within a couple seconds. */
  private async applyControlTick(): Promise<void> {
    if (this.stopRequested) return;
    const ctl = readControl(this.case);
    if (!ctl) return;
    const { stop, ...patch } = ctl.control;
    this.applyConfig(patch);
    consumeControl(this.case, ctl.mtimeMs);
    if (stop === true) {
      this.stopRequested = true;
      this.announceStopping("stop requested via situation stop");
      this.opts.onStopRequested?.("control");
      return;
    }
    // a config change should reflect promptly (not wait for the slow data poll)
    if (this.configDirty) await this.rebuild();
  }

  /** Rebuild when the store (or the active config) changed — the SLOW cadence. */
  private async pollRebuildTick(): Promise<void> {
    if (this.stopRequested) return;
    const fp = this.fingerprint();
    if (fp !== this.lastFingerprint || this.configDirty) await this.rebuild();
  }

  /** Apply control then rebuild-on-change in one shot. Public so tests can drive
   *  the whole poll cycle deterministically without the timers. */
  async tick(): Promise<void> {
    await this.applyControlTick();
    if (!this.stopRequested) await this.pollRebuildTick();
  }

  /** Apply a config patch (from control.json), dropping invalid values rather
   *  than failing the tick — the writer already validated; this is the belt. */
  private applyConfig(patch: SituationConfig): void {
    let changed = false;
    const set = <K extends keyof SituationConfig>(key: K, value: SituationConfig[K] | undefined): void => {
      if (value === undefined) return;
      if (JSON.stringify(this.viewConfig[key]) === JSON.stringify(value)) return;
      this.viewConfig[key] = value;
      changed = true;
    };
    set("panels", patch.panels);
    set("source", patch.source);
    set("since", patch.since);
    if (patch.limit !== undefined && Number.isFinite(patch.limit) && patch.limit > 0) set("limit", Math.floor(patch.limit));
    if (patch.theme !== undefined && normalizeHtmlTheme(patch.theme)) set("theme", patch.theme);
    set("query", patch.query);
    if (changed) this.configDirty = true;
  }

  /** Store fingerprint extended with the state registries the model reads
   *  (sources.json / target.json) so a `source add` refreshes the page too. */
  private fingerprint(): string {
    const extra = [this.case.sourcesFile, this.case.targetFile]
      .map((f) => {
        try {
          const st = statSync(f);
          return `${st.mtimeMs}:${st.size}`;
        } catch {
          return "-";
        }
      })
      .join("|");
    return `${this.case.storeFingerprint()}#${extra}`;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  // --- model → wire ---------------------------------------------------------------

  private async rebuild(force = false): Promise<void> {
    if (this.building) {
      this.rebuildPending = true;
      // a forced rebuild (Sync-now) must not report success off an in-flight
      // build it didn't observe — tell the caller it couldn't rebuild now.
      if (force) throw new Error("rebuild already in progress");
      return;
    }
    this.building = true;
    try {
      const fp = this.fingerprint();
      const records = this.case.records();
      const model = buildSituationModel(records, {
        caseName: this.case.exists() ? this.case.info().name : basename(this.case.dir),
        caseDir: this.case.dir,
        config: this.viewConfig,
        sources: listSources(this.case),
        now: this.now(),
      });
      await this.attachPosters(model);
      const prevRecords = this.snapshot?.hud.records;
      this.toWire(model);
      this.lastFingerprint = fp;
      this.configDirty = false;
      // announce AFTER the snapshot swap so a console that reacts instantly
      // fetches the new state, not the old one. The very first build has no
      // audience state to invalidate — hello carries the seq.
      if (prevRecords !== undefined) {
        this.publish({ type: "refresh", generatedAt: model.generatedAt, records: model.hud.records });
      }
    } catch (e) {
      // a torn store read mid-write heals on the next tick; but a FORCED rebuild
      // (Sync-now) must surface the failure so the caller doesn't treat a stale
      // snapshot as a fresh sync (Bugbot #98/med).
      if (force) throw e;
    } finally {
      this.building = false;
      if (this.rebuildPending) {
        this.rebuildPending = false;
        void this.rebuild();
      }
    }
  }

  /** Best-effort poster stills for present-but-unplayable containers, exactly
   *  like the wall verb's pass (cached ≤640px frames in the case mediaDir). */
  private async attachPosters(model: SituationModel): Promise<void> {
    if (this.opts.posters === false) return;
    for (const tile of model.tiles) {
      if (tile.mode !== "still" || !tile.media?.local) continue;
      try {
        const poster = await posterFrame(tile.media.local, this.case.mediaDir, tile.anchor.at);
        if (poster) tile.poster = { local: poster };
      } catch {
        /* non-fatal — the console renders the static cover */
      }
    }
  }

  /** Swap in a fresh snapshot + media allowlist. The previous generation's ids
   *  stay resolvable so a console holding the old snapshot doesn't 404 its
   *  tiles between refresh and refetch. */
  private toWire(model: SituationModel): void {
    this.prevMediaMap = this.mediaMap;
    this.mediaMap = new Map();
    const remoteOk = reportRemoteMediaEnabled();
    const urlFor = (ref: SituationMediaRef | null): string | null => {
      if (!ref) return null;
      if (ref.local) {
        const abs = resolve(ref.local);
        // CONTAINMENT (Bugbot #98/high): only case-scoped media is servable.
        // The allowlist (model refs) already bounds it, but a record could
        // reference an absolute/symlinked path outside the case; refuse those so
        // the /media route can never stream arbitrary disk paths, even with the
        // token. realpathContained resolves symlinks, closing the escape hole.
        if (!realpathContained(this.case.dir, abs)) return null;
        const id = createHash("sha1").update(abs).digest("hex");
        this.mediaMap.set(id, abs);
        return `/media/${id}/${encodeURIComponent(basename(abs))}`;
      }
      // remote embeds are opt-in (OVERCAST_REPORT_REMOTE_MEDIA) — loading a
      // scraped URL beacons the operator's IP to the investigated host.
      return remoteOk ? (ref.remote ?? null) : null;
    };
    this.snapshot = {
      version: this.opts.version,
      caseName: model.hud.caseName,
      caseDir: model.hud.caseDir,
      generatedAt: model.generatedAt,
      panels: model.panels,
      config: model.config,
      hud: model.hud,
      tiles: model.tiles.map((t) => ({
        ref: t.ref,
        mediaUrl: urlFor(t.media),
        mode: t.mode,
        title: t.title,
        duration: t.duration,
        anchor: t.anchor,
        coverage: t.coverage,
        faceCount: t.faceCount,
        openFindings: t.openFindings,
        summary: t.summary,
        sourceType: t.sourceType,
        sourceUrl: t.sourceUrl,
        sourceAuthor: t.sourceAuthor,
        lastRecordTime: t.lastRecordTime,
        ageSeconds: t.ageSeconds,
        posterUrl: urlFor(t.poster),
      })),
      feed: model.feed.map((f) => ({
        recordId: f.recordId,
        time: f.time,
        source: f.source,
        sourceId: f.sourceId,
        title: f.title,
        url: f.url,
        snippet: f.snippet,
        published: f.published,
        author: f.author,
        thumbUrl: urlFor(f.thumb),
        state: f.state,
        error: f.error,
      })),
      points: model.points.map((p) => ({
        recordId: p.recordId,
        verb: p.verb,
        source: p.source,
        lat: p.lat,
        lng: p.lng,
        place: p.place,
        time: p.time,
        summary: p.summary,
        ref: p.ref,
        url: p.url,
        thumbUrl: urlFor(p.thumb),
        track: p.track,
        heading: p.heading,
        velocity: p.velocity,
        onGround: p.onGround,
        label: p.label,
      })),
      bounds: model.bounds,
      stills: model.stills.map((s) => ({
        key: s.key,
        recordId: s.recordId,
        title: s.title,
        source: s.source,
        url: s.url,
        mediaUrl: urlFor(s.media),
        time: s.time,
      })),
      monitor:
        this.opts.every != null
          ? { every: this.opts.every, ...this.monitorInfo }
          : { every: null, ...this.monitorInfo },
      sources: model.sources,
      pollSeconds: Math.round(((this.opts.pollMs ?? POLL_MS) / 1000) * 10) / 10,
    };
  }

  // --- routes ------------------------------------------------------------------

  protected routeApi(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method === "GET" && url.pathname === "/api/state") {
      if (!this.snapshot) {
        this.json(res, 503, { error: "warming up" });
        return true;
      }
      this.json(res, 200, { ...this.snapshot, seq: this.seq } satisfies SituationSnapshot);
      return true;
    }
    // force "sync to now": rebuild from the current store immediately (the poll
    // tick is ≤pollMs away, but the console's Sync button wants the freshest cut)
    // then return the new snapshot so the console renders it without a round-trip.
    if (req.method === "POST" && url.pathname === "/api/refresh") {
      void this.forceRebuild()
        .then(() => {
          if (!this.snapshot) return this.json(res, 503, { error: "warming up" });
          this.json(res, 200, { ...this.snapshot, seq: this.seq } satisfies SituationSnapshot);
        })
        .catch(() => {
          // the forced rebuild couldn't complete (torn read / in-flight build) —
          // report failure so the console doesn't treat it as a fresh sync.
          try {
            this.json(res, 503, { error: "could not sync now — try again" });
          } catch {
            /* headers already sent */
          }
        });
      return true;
    }
    return false;
  }

  /** Rebuild from the current store on demand (the Sync-now button). Bypasses
   *  the fingerprint short-circuit so it always reflects "now"; THROWS if the
   *  rebuild couldn't complete so the caller doesn't report a stale sync. */
  async forceRebuild(): Promise<void> {
    this.lastFingerprint = ""; // force rebuild() past the no-change guard
    await this.rebuild(true);
  }

  protected helloEvent(): Record<string, unknown> {
    const hello: SituationWireEvent = {
      type: "hello",
      seq: this.seq,
      caseName: this.snapshot?.caseName ?? basename(this.case.dir),
      version: this.opts.version,
      clients: this.clientCount(),
    };
    return hello;
  }

  protected override routeExtra(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!url.pathname.startsWith("/media/")) return false;
    if (!this.authorized(req, url)) {
      this.json(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.json(res, 405, { error: "method not allowed" });
      return true;
    }
    this.serveMedia(req, res, url);
    return true;
  }

  // --- media streaming ------------------------------------------------------------

  private serveMedia(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const id = url.pathname.split("/")[2] ?? "";
    const path = this.mediaMap.get(id) ?? this.prevMediaMap.get(id);
    if (!path) return this.json(res, 404, { error: "not found" });
    // re-verify containment at serve time (defense in depth; catches a symlink
    // swap between snapshot build and this request) — never stream outside the case.
    if (!realpathContained(this.case.dir, path)) return this.json(res, 404, { error: "not found" });
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      return this.json(res, 404, { error: "not found" });
    }
    if (!st.isFile()) return this.json(res, 404, { error: "not found" });
    const headers: Record<string, string | number> = {
      "Content-Type": MEDIA_CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      // media paths are content-stable (a recapture writes a NEW file), so a
      // short private cache keeps the loop windows from refetching
      "Cache-Control": "private, max-age=300",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "Content-Length": st.size });
      return void res.end();
    }
    const range = req.headers.range;
    if (typeof range === "string" && range.trim() !== "") {
      const parsed = parseRange(range, st.size);
      if (!parsed) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        return void res.end();
      }
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${parsed.start}-${parsed.end}/${st.size}`,
        "Content-Length": parsed.end - parsed.start + 1,
      });
      const stream = createReadStream(path, { start: parsed.start, end: parsed.end });
      stream.on("error", () => res.destroy());
      return void stream.pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": st.size });
    const stream = createReadStream(path);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
}

/** Parse a `bytes=start-end` / `bytes=start-` / `bytes=-suffix` range against a
 *  file size. Returns null for anything unsatisfiable (→ 416). Multi-range is
 *  deliberately unsupported (browsers don't send it for media). */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || size <= 0) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
