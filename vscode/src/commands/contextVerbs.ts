// Curated explorer context-menu verbs (the overcast.ctx.* commands declared in
// package.json). Handlers receive (uri, uris?) — multi-select gives uris.
//
// Verified CLI shapes (v0.0.9 --help + fixture runs):
//   grid <input> --view --no-open        → board html in payload.view
//   view <ref> --no-open                 → player html in payload.viewer
//   enhance <input> --ops <comma list>   (ffmpeg ops: grayscale/denoise/…)
//   similar match <input> --index <id>   (action positional FIRST)
//   audio match <query> [reference] | --index <id>
//   voice match <clip> <sample> | voice match <sample> --index <id>
//   chronolocate [input] --lat --lng (--at-time | --shadow-azimuth [--date])
import * as path from "node:path";
import * as vscode from "vscode";
import { htmlPathsInPayload } from "../lib/cliOutput.ts";
import type { ExtDeps, OvercastRecord } from "../types.ts";

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|mpg|mpeg|ts)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

function targetPath(uri?: vscode.Uri): string | undefined {
  if (uri?.scheme === "file") return uri.fsPath;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") return active.fsPath;
  void vscode.window.showErrorMessage("Overcast: no file selected.");
  return undefined;
}

async function ensureCase(deps: ExtDeps): Promise<boolean> {
  if (!(await deps.bridge.ensureCli())) return false;
  if (deps.locator.caseDir) return true;
  const pick = await vscode.window.showWarningMessage(
    "Overcast verbs write records into a case — none found in this workspace.",
    "Initialize Case Here",
  );
  if (pick) await vscode.commands.executeCommand("overcast.initCase");
  return false;
}

/** Run one verb with progress; open the produced artifact/record; refresh. */
async function runAndRoute(
  deps: ExtDeps,
  args: string[],
  opts: { artifact?: (payload: unknown) => string | undefined } = {},
): Promise<void> {
  const verb = args[0];
  const result = await deps.bridge.runWithProgress(
    `overcast ${verb} ${path.basename(args[1] ?? "")}`.trim(),
    args,
  );
  if (!result) return;
  deps.router.refresh();
  const rec: OvercastRecord | undefined =
    result.records.find((r) => r.verb === verb) ?? result.records[0];
  if (!rec) return;
  const fromField = opts.artifact?.(rec.payload);
  const artifact = fromField ?? htmlPathsInPayload(rec.payload)[0];
  if (artifact) {
    await deps.router.openArtifact(artifact, `${verb} — ${path.basename(artifact)}`);
  } else if (rec.id) {
    await deps.router.openRecord(rec.id);
  }
  if (rec.id) {
    void vscode.window.showInformationMessage(
      `overcast ${verb} → ${rec.id}${rec.state === "pending" ? " (pending)" : ""}`,
    );
  }
}

const payloadStr =
  (key: string) =>
  (payload: unknown): string | undefined => {
    const v = (payload as Record<string, unknown> | undefined)?.[key];
    return typeof v === "string" && v ? v : undefined;
  };

// ---- per-verb prompt flows ---------------------------------------------------

async function enhanceFlow(deps: ExtDeps, p: string): Promise<void> {
  const ops = [
    "grayscale",
    "denoise",
    "normalize",
    "upscale",
    "stabilize",
    "voice-isolate",
  ].map((op) => ({ label: op }));
  const pick = await vscode.window.showQuickPick(
    [...ops, { label: "$(edit) Custom ops (comma list)…" }],
    { placeHolder: "enhance --ops", ignoreFocusOut: true },
  );
  if (!pick) return;
  let op = pick.label;
  if (op.startsWith("$(edit)")) {
    const raw = await vscode.window.showInputBox({
      prompt: "Comma list of ops (denoise,normalize,upscale,separate,segment,ela,panorama,…)",
      ignoreFocusOut: true,
    });
    if (!raw?.trim()) return;
    op = raw.trim();
  }
  await runAndRoute(deps, ["enhance", p, "--ops", op]);
}

async function similarFlow(deps: ExtDeps, p: string): Promise<void> {
  const idx = await vscode.window.showInputBox({
    prompt: "similar match --index — a local basic-clip (image) or basic-clap (audio) index id",
    placeHolder: "see `overcast index list` for ids",
    ignoreFocusOut: true,
  });
  if (!idx?.trim()) return;
  await runAndRoute(deps, ["similar", "match", p, "--index", idx.trim()]);
}

async function audioFlow(deps: ExtDeps, p: string): Promise<void> {
  const how = await vscode.window.showQuickPick(
    [
      { label: "$(file) Compare to another clip…", mode: "clip" as const },
      { label: "$(database) Search an audio-fp index…", mode: "index" as const },
    ],
    { placeHolder: "audio match — against what?", ignoreFocusOut: true },
  );
  if (!how) return;
  if (how.mode === "clip") {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Reference clip",
    });
    if (!picked?.[0]) return;
    await runAndRoute(deps, ["audio", "match", p, picked[0].fsPath]);
    return;
  }
  const idx = await vscode.window.showInputBox({
    prompt: "audio match --index — a local audio-fp index id (see `overcast index list`)",
    ignoreFocusOut: true,
  });
  if (!idx?.trim()) return;
  await runAndRoute(deps, ["audio", "match", p, "--index", idx.trim()]);
}

async function voiceFlow(deps: ExtDeps, p: string): Promise<void> {
  const how = await vscode.window.showQuickPick(
    [
      {
        label: "$(file) Rank WHERE a reference speaker talks in this clip…",
        detail: "voice match <clip> <sample> — pick the reference voice sample",
        mode: "sample" as const,
      },
      {
        label: "$(database) Search a voice-print index for this speaker…",
        detail: "voice match <sample> --index <id> — this file is the sample",
        mode: "index" as const,
      },
    ],
    { placeHolder: "voice match — which direction?", ignoreFocusOut: true },
  );
  if (!how) return;
  if (how.mode === "sample") {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Reference voice sample",
    });
    if (!picked?.[0]) return;
    await runAndRoute(deps, ["voice", "match", p, picked[0].fsPath]);
    return;
  }
  const idx = await vscode.window.showInputBox({
    prompt: "voice match --index — a local voice-print index id (see `overcast index list`)",
    ignoreFocusOut: true,
  });
  if (!idx?.trim()) return;
  await runAndRoute(deps, ["voice", "match", p, "--index", idx.trim()]);
}

async function chronolocateFlow(deps: ExtDeps, p: string): Promise<void> {
  const num = (v: string) =>
    v.trim() === "" || Number.isNaN(Number(v)) ? "must be a number" : undefined;
  const lat = await vscode.window.showInputBox({
    prompt: "Latitude (WGS84) — chronolocate needs a location",
    validateInput: num,
    ignoreFocusOut: true,
  });
  if (lat === undefined) return;
  const lng = await vscode.window.showInputBox({
    prompt: "Longitude (WGS84)",
    validateInput: num,
    ignoreFocusOut: true,
  });
  if (lng === undefined) return;
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: "Verify a claimed time",
        detail: "--at-time <ISO> — expected sun/shadow for that moment",
        mode: "verify" as const,
      },
      {
        label: "Solve from an observed shadow",
        detail: "--shadow-azimuth <deg> [--date] — when could this shadow occur?",
        mode: "solve" as const,
      },
    ],
    { placeHolder: "chronolocate mode", ignoreFocusOut: true },
  );
  if (!mode) return;
  const args = ["chronolocate", p, "--lat", lat.trim(), "--lng", lng.trim()];
  if (mode.mode === "verify") {
    const at = await vscode.window.showInputBox({
      prompt: "Claimed capture time (ISO 8601, e.g. 2026-07-04T17:30:00Z)",
      ignoreFocusOut: true,
    });
    if (!at?.trim()) return;
    args.push("--at-time", at.trim());
  } else {
    const az = await vscode.window.showInputBox({
      prompt: "Observed shadow bearing in degrees from North (0=N, 90=E, 180=S, 270=W)",
      validateInput: num,
      ignoreFocusOut: true,
    });
    if (az === undefined || az.trim() === "") return;
    args.push("--shadow-azimuth", az.trim());
    const date = await vscode.window.showInputBox({
      prompt: "Reference date YYYY-MM-DD (empty = today)",
      ignoreFocusOut: true,
    });
    if (date === undefined) return;
    if (date.trim()) args.push("--date", date.trim());
  }
  await runAndRoute(deps, args);
}

async function batchSense(deps: ExtDeps, uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const files = (uris?.length ? uris : uri ? [uri] : [])
    .filter((u) => u.scheme === "file")
    .map((u) => u.fsPath);
  if (files.length === 0) {
    void vscode.window.showErrorMessage("Overcast: no files selected.");
    return;
  }
  const jobs = files
    .map((p) => {
      const verb = VIDEO_EXT.test(p)
        ? "watch"
        : IMAGE_EXT.test(p)
          ? "see"
          : AUDIO_EXT.test(p)
            ? "listen"
            : undefined;
      return verb ? { p, verb } : undefined;
    })
    .filter((j): j is { p: string; verb: string } => !!j);
  const skipped = files.length - jobs.length;
  if (jobs.length === 0) {
    void vscode.window.showErrorMessage("Overcast: no media files in the selection.");
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Overcast: sensing ${jobs.length} file(s)`,
      cancellable: true,
    },
    async (progress, token) => {
      let ok = 0;
      const failed: string[] = [];
      for (const [i, job] of jobs.entries()) {
        if (token.isCancellationRequested) break;
        progress.report({
          message: `${i + 1}/${jobs.length} ${job.verb} ${path.basename(job.p)}`,
          increment: 100 / jobs.length,
        });
        const res = await deps.bridge.run([job.verb, job.p], { token });
        // A per-job cancel (Runs view) skips the file; a batch cancel breaks
        // at the loop top via `token`.
        if (res.cancelled) continue;
        if (res.failure) failed.push(`${path.basename(job.p)} (${res.failure.message})`);
        else ok++;
      }
      deps.router.refresh();
      const bits = [`${ok} ok`];
      if (failed.length) bits.push(`${failed.length} failed`);
      if (skipped) bits.push(`${skipped} skipped (not media)`);
      const message = `Overcast batch sense: ${bits.join(", ")}`;
      if (failed.length) {
        void vscode.window.showWarningMessage(`${message} — ${failed[0]}${failed.length > 1 ? " …" : ""}`);
      } else {
        void vscode.window.showInformationMessage(message);
      }
    },
  );
}

// ---- registration --------------------------------------------------------------

export function registerContextVerbs(deps: ExtDeps): void {
  const simple = (verb: string) => async (uri?: vscode.Uri) => {
    if (!(await ensureCase(deps))) return;
    const p = targetPath(uri);
    if (!p) return;
    await runAndRoute(deps, [verb, p]);
  };
  const flow =
    (fn: (deps: ExtDeps, p: string) => Promise<void>) => async (uri?: vscode.Uri) => {
      if (!(await ensureCase(deps))) return;
      const p = targetPath(uri);
      if (!p) return;
      await fn(deps, p);
    };

  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.ctx.watch", simple("watch")),
    vscode.commands.registerCommand("overcast.ctx.listen", simple("listen")),
    vscode.commands.registerCommand("overcast.ctx.see", simple("see")),
    vscode.commands.registerCommand("overcast.ctx.exif", simple("exif")),
    vscode.commands.registerCommand("overcast.ctx.face", simple("face")),
    vscode.commands.registerCommand(
      "overcast.ctx.grid",
      flow(async (d, p) =>
        runAndRoute(d, ["grid", p, "--view", "--no-open"], { artifact: payloadStr("view") }),
      ),
    ),
    vscode.commands.registerCommand(
      "overcast.ctx.view",
      flow(async (d, p) =>
        runAndRoute(d, ["view", p, "--no-open"], { artifact: payloadStr("viewer") }),
      ),
    ),
    vscode.commands.registerCommand("overcast.ctx.enhance", flow(enhanceFlow)),
    vscode.commands.registerCommand("overcast.ctx.similar", flow(similarFlow)),
    vscode.commands.registerCommand("overcast.ctx.audio", flow(audioFlow)),
    vscode.commands.registerCommand("overcast.ctx.voice", flow(voiceFlow)),
    vscode.commands.registerCommand("overcast.ctx.chronolocate", flow(chronolocateFlow)),
    vscode.commands.registerCommand(
      "overcast.ctx.batchSense",
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        if (!(await ensureCase(deps))) return;
        await batchSense(deps, uri, uris);
      },
    ),
  );
}
