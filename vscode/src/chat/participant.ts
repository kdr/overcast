// The @overcast chat participant (ask-mode front door). Declared in package.json's
// contributes.chatParticipants; created here via vscode.chat.createChatParticipant.
// Free text (and /ask) → `ask`; /scan /status /brief /capture /sense /note map to
// the matching verb. Each request streams markdown + Open Record buttons and runs
// through the shared chat core (deps.bridge.run — tracked in the Runs view).
//
// v1 constraint: single-shot. We deliberately do NOT reconstruct multi-turn
// context from ChatContext.history — the overcast case store IS the memory and
// every verb reads it fresh, so replaying history would only duplicate it.
import * as vscode from "vscode";
import { recordForVerb } from "../lib/cliOutput.ts";
import type { CaseStatusPayload, ExtDeps, OvercastRecord } from "../types.ts";
import { runVerbForChat, resolveMediaFile } from "./core.ts";
import {
  CAPABILITY_MARKDOWN,
  FLAG_LIKE_MESSAGE,
  answerText,
  caseSummary,
  citedRecordIds,
  flagLikeText,
  isCapabilityQuestion,
  recordBlurb,
  scanHits,
  type CaseSummary,
} from "./summarize.ts";

const SENSE_VERBS = new Set(["watch", "listen", "see", "face", "exif"]);
const MAX_BUTTONS = 10;

const meta = (command: string, extra: Record<string, unknown> = {}): vscode.ChatResult => ({
  metadata: { command, ...extra },
});
const warn = (m?: string): string => `⚠️ ${m ?? "overcast failed."}`;

/** Pin the case the reply ran against — a button clicked after a case switch
 *  must open the record in ITS case, not whatever is active then. */
function openRecordButton(
  stream: vscode.ChatResponseStream,
  id: string,
  caseDir: string | undefined,
): void {
  stream.button({ command: "overcast.openRecord", title: `Open ${id}`, arguments: [id, caseDir] });
}

/** Stream a produced record (capture/sense/note) as a short summary + Open button. */
function streamRecord(
  stream: vscode.ChatResponseStream,
  records: OvercastRecord[],
  verb: string,
  caseDir: string | undefined,
): void {
  const rec = recordForVerb(records, verb) ?? records[0];
  if (!rec) {
    stream.markdown("_No record was produced._");
    return;
  }
  const state = rec.state && rec.state !== "ready" ? ` _(${rec.state})_` : "";
  stream.markdown(`**${verb}** → \`${rec.id}\`${state}\n\n${recordBlurb(rec)}\n`);
  openRecordButton(stream, rec.id, caseDir);
}

function renderStatusMarkdown(s: CaseSummary): string {
  const lines: string[] = [`### ${s.case}`];
  if (s.headline) lines.push(`_${s.headline}_`);
  lines.push(`${s.records} record(s) · ${s.suggestedLeads} suggested lead(s) awaiting review`);
  if (s.threads.length) {
    lines.push("\n**Lines of investigation**");
    for (const t of s.threads) {
      lines.push(
        `- **${t.line}** — ${t.status} · ${t.stage} · ${t.evidence} evidence · ${t.findings} finding(s)`,
      );
    }
  }
  if (s.sources.length) {
    lines.push("\n**Sources**");
    for (const c of s.sources) {
      lines.push(
        `- ${c.source} (${c.type}) — ${c.enabled ? "enabled" : "disabled"}, last scan ${c.lastScan}, ${c.hits} hit(s)${c.gap ? " ⚠️ never produced a hit" : ""}`,
      );
    }
  }
  return lines.join("\n");
}

// ---- per-command handlers ----------------------------------------------------

async function handleAsk(
  deps: ExtDeps,
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  if (!prompt.trim()) {
    stream.markdown("Ask a question about this case — e.g. `@overcast what vehicles appear in the footage?`");
    return meta("ask");
  }
  // "@overcast what can you do" is about the participant, not the case — an
  // `ask` would truthfully stream `No records match "what can you do"`.
  if (isCapabilityQuestion(prompt)) {
    stream.markdown(CAPABILITY_MARKDOWN);
    return meta("help");
  }
  if (flagLikeText(prompt)) {
    stream.markdown(warn(FLAG_LIKE_MESSAGE));
    return meta("ask");
  }
  stream.progress("Asking the case…");
  const outcome = await runVerbForChat(deps.bridge, ["ask", prompt.trim()], token);
  if (!outcome.ok) {
    stream.markdown(warn(outcome.message));
    return meta("ask");
  }
  const rec = recordForVerb(outcome.records, "ask");
  const answer = rec ? answerText(rec) : "";
  stream.markdown(answer || "_No answer was produced._");
  if (rec) for (const id of citedRecordIds(rec).slice(0, MAX_BUTTONS)) openRecordButton(stream, id, deps.locator.caseDir);
  return meta("ask");
}

async function handleScan(
  deps: ExtDeps,
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  if (prompt.trim() && flagLikeText(prompt)) {
    stream.markdown(warn(FLAG_LIKE_MESSAGE));
    return meta("scan");
  }
  stream.progress("Scanning sources…");
  const args = ["scan"];
  if (prompt.trim()) args.push("--query", prompt.trim());
  const outcome = await runVerbForChat(deps.bridge, args, token);
  // A plain scan exits non-zero when ANY single source is credential-gapped,
  // while healthy sources still returned real hits in the same records stream —
  // never swallow those hits behind the failure.
  const hits = scanHits(outcome.records);
  if (!outcome.ok && hits.length === 0) {
    stream.markdown(warn(outcome.message));
    return meta("scan");
  }
  if (hits.length === 0) {
    stream.markdown("No scan hits. Configure sources (the Sources view, or `/source`), then try again.");
    return meta("scan");
  }
  stream.markdown(`Found **${hits.length}** hit(s):\n`);
  const shown = hits.slice(0, MAX_BUTTONS);
  for (const h of shown) {
    const title = h.title || h.url || h.id || "(untitled)";
    stream.markdown(`- **${title}**${h.url ? ` — ${h.url}` : ""}${h.source ? ` _(${h.source})_` : ""}\n`);
    if (h.id) openRecordButton(stream, h.id, deps.locator.caseDir);
  }
  if (hits.length > shown.length) stream.markdown(`\n…and ${hits.length - shown.length} more.\n`);
  if (!outcome.ok) stream.markdown(`\n${warn(outcome.message)}\n`);
  stream.markdown("\nUse `/capture <scan-hit id | url>` to pull one into the case.");
  return meta("scan", { topHitId: shown.find((h) => h.id)?.id });
}

async function handleStatus(
  deps: ExtDeps,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  stream.progress("Reading case status…");
  const outcome = await runVerbForChat(deps.bridge, ["case", "status"], token);
  if (!outcome.ok) {
    stream.markdown(warn(outcome.message));
    return meta("status");
  }
  const rec = recordForVerb(outcome.records, "case");
  if (!rec || typeof rec.payload !== "object" || rec.payload === null) {
    stream.markdown("_No status available._");
    return meta("status");
  }
  stream.markdown(renderStatusMarkdown(caseSummary(rec.payload as CaseStatusPayload)));
  return meta("status");
}

async function handleBrief(
  deps: ExtDeps,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  stream.progress("Rendering the brief…");
  // brief with no --json prints its markdown report straight to stdout (a
  // report-shaped record renders its md body — see cli.ts renderForFormat).
  const outcome = await runVerbForChat(deps.bridge, ["brief"], token, { rawOutput: true });
  if (!outcome.ok) {
    stream.markdown(warn(outcome.message));
    return meta("brief");
  }
  stream.markdown((outcome.stdout ?? "").trim() || "_The brief is empty._");
  return meta("brief");
}

async function handleCapture(
  deps: ExtDeps,
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const ref = prompt.trim();
  if (!ref) {
    stream.markdown("Usage: `/capture <scan-hit id | url>` — pull a scan hit or URL into the case (reaches the network).");
    return meta("capture");
  }
  if (flagLikeText(ref)) {
    stream.markdown(warn(FLAG_LIKE_MESSAGE));
    return meta("capture");
  }
  stream.progress(`Capturing ${ref}…`);
  const outcome = await runVerbForChat(deps.bridge, ["capture", ref], token);
  if (!outcome.ok) {
    stream.markdown(warn(outcome.message));
    return meta("capture");
  }
  streamRecord(stream, outcome.records, "capture", deps.locator.caseDir);
  return meta("capture");
}

async function handleSense(
  deps: ExtDeps,
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const trimmed = prompt.trim();
  const sp = trimmed.indexOf(" ");
  const verb = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const file = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
  if (!SENSE_VERBS.has(verb) || !file) {
    stream.markdown("Usage: `/sense <watch|listen|see|face|exif> <file>` — analyze a media file.");
    return meta("sense");
  }
  const abs = resolveMediaFile(deps.locator.caseDir, file);
  if (!abs) {
    stream.markdown(warn(`File not found: ${file} (absolute, or relative to the workspace/case folder).`));
    return meta("sense");
  }
  stream.progress(`Running ${verb} on ${file}…`);
  const outcome = await runVerbForChat(deps.bridge, [verb, abs], token);
  if (!outcome.ok) {
    stream.markdown(warn(outcome.message));
    return meta("sense");
  }
  streamRecord(stream, outcome.records, verb, deps.locator.caseDir);
  return meta("sense");
}

async function handleNote(
  deps: ExtDeps,
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  const text = prompt.trim();
  if (!text) {
    stream.markdown("Usage: `/note <text>` — record an analyst observation into the case.");
    return meta("note");
  }
  if (flagLikeText(text)) {
    stream.markdown(warn(FLAG_LIKE_MESSAGE));
    return meta("note");
  }
  stream.progress("Adding note…");
  const outcome = await runVerbForChat(deps.bridge, ["note", text], token);
  if (!outcome.ok) {
    stream.markdown(warn(outcome.message));
    return meta("note");
  }
  streamRecord(stream, outcome.records, "note", deps.locator.caseDir);
  return meta("note");
}

const followupProvider: vscode.ChatFollowupProvider = {
  provideFollowups(result) {
    const md = (result.metadata ?? {}) as { command?: string; topHitId?: string };
    if (md.command === "ask") {
      return [
        { prompt: "", label: "Show the mission brief", command: "brief" },
        { prompt: "", label: "Scan sources for related media", command: "scan" },
      ];
    }
    if (md.command === "scan") {
      return [{ prompt: md.topHitId ?? "", label: "Capture the top hit", command: "capture" }];
    }
    return [];
  },
};

export function registerChatParticipant(deps: ExtDeps): void {
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    const cli = await deps.bridge.resolve();
    if (!cli) {
      stream.markdown(
        "The **overcast** CLI wasn't found. Install it with `npm install -g @kdrrr/overcast`, or set `overcast.path` to a binary or a built `dist/bin/overcast.js`.",
      );
      return {};
    }
    if (!deps.locator.caseDir) {
      stream.markdown("No overcast case in this workspace. A case is a folder with an `.overcast/` store.");
      stream.button({ command: "overcast.initCase", title: "Initialize Case Here" });
      return {};
    }
    switch (request.command) {
      case "scan":
        return handleScan(deps, request.prompt, stream, token);
      case "status":
        return handleStatus(deps, stream, token);
      case "brief":
        return handleBrief(deps, stream, token);
      case "capture":
        return handleCapture(deps, request.prompt, stream, token);
      case "sense":
        return handleSense(deps, request.prompt, stream, token);
      case "note":
        return handleNote(deps, request.prompt, stream, token);
      case "ask":
      default:
        return handleAsk(deps, request.prompt, stream, token);
    }
  };

  const participant = vscode.chat.createChatParticipant("overcast.chat", handler);
  // Explicit-color svg pair (not the currentColor master): chat avatars render
  // the file as-is, so currentColor would come out black on dark themes.
  participant.iconPath = {
    light: vscode.Uri.joinPath(deps.context.extensionUri, "media", "overcast-light.svg"),
    dark: vscode.Uri.joinPath(deps.context.extensionUri, "media", "overcast-dark.svg"),
  };
  participant.followupProvider = followupProvider;
  deps.context.subscriptions.push(participant);
}
