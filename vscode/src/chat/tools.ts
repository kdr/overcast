// The six overcast_* language-model tools (agent-mode integration). Declared
// (hand-curated) in package.json's contributes.languageModelTools and registered
// here via vscode.lm.registerTool. Each tool: prepareInvocation echoes the EXACT
// argv in a confirmation dialog (network-reaching scan/capture and case-mutating
// note/sense get clear wording; case_status/ask are read-only), invoke runs via
// the shared chat core (deps.bridge.run — the Runs view tracks it, no notification
// spam) and returns a compact JSON record summary, or the failure message
// verbatim (needs_credentials included) so the model can relay it.
//
// The tool contributions carry `"when": "overcast.cliFound"`, so they're only
// offered once the CLI resolves; the case guard here covers the no-case case.
import * as vscode from "vscode";
import { recordForVerb } from "../lib/cliOutput.ts";
import type { CaseStatusPayload, ExtDeps } from "../types.ts";
import { runVerbForChat, resolveMediaFile } from "./core.ts";
import {
  FLAG_LIKE_MESSAGE,
  caseSummary,
  flagLikeText,
  scanHits,
  summarizeVerbResult,
  toModelJson,
} from "./summarize.ts";

const textResult = (s: string): vscode.LanguageModelToolResult =>
  new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

const NO_CASE =
  "No overcast case is active in this workspace. Initialize one (the 'Overcast: Initialize Case Here' command) before using this tool.";

const SENSE_VERBS = new Set(["watch", "listen", "see", "face", "exif"]);

interface AskInput {
  question: string;
  deep?: boolean;
}
interface ScanInput {
  query?: string;
  source?: string;
  since?: string;
  limit?: number;
}
interface CaptureInput {
  ref: string;
}
interface SenseInput {
  verb: string;
  file: string;
}
interface NoteInput {
  text: string;
  confidence?: string;
}

function askArgs(input: AskInput): string[] {
  const args = ["ask", input.question.trim()];
  if (input.deep) args.push("--deep");
  return args;
}

// Same argv surface + order as searchSource.ts (--source, --query, --since, --limit).
function scanArgs(input: ScanInput): string[] {
  const args = ["scan"];
  if (input.source?.trim()) args.push("--source", input.source.trim());
  if (input.query?.trim()) args.push("--query", input.query.trim());
  if (input.since?.trim()) args.push("--since", input.since.trim());
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) {
    args.push("--limit", String(Math.trunc(input.limit)));
  }
  return args;
}

function noteArgs(input: NoteInput): string[] {
  const args = ["note", input.text.trim()];
  if (input.confidence) args.push("--confidence", input.confidence);
  return args;
}

export function registerChatTools(deps: ExtDeps): void {
  const caseStatusTool: vscode.LanguageModelTool<Record<string, never>> = {
    prepareInvocation() {
      return {
        invocationMessage: "Reading overcast case status",
        confirmationMessages: {
          title: "Read case status",
          message:
            "Run `overcast case status` — reads this case's threads, suggested leads, and source freshness. No network, no changes.",
        },
      };
    },
    async invoke(_options, token) {
      if (!deps.locator.caseDir) return textResult(NO_CASE);
      const outcome = await runVerbForChat(deps.bridge, ["case", "status"], token);
      if (!outcome.ok) return textResult(outcome.message ?? "overcast failed.");
      const rec = recordForVerb(outcome.records, "case");
      if (!rec || typeof rec.payload !== "object" || rec.payload === null) {
        return textResult(toModelJson({ note: "no case status payload was produced" }));
      }
      return textResult(toModelJson(caseSummary(rec.payload as CaseStatusPayload)));
    },
  };

  const askTool: vscode.LanguageModelTool<AskInput> = {
    prepareInvocation(options) {
      return {
        invocationMessage: `Asking the case: "${options.input.question}"`,
        confirmationMessages: {
          title: "Ask the case",
          message: `Run \`overcast ${askArgs(options.input).join(" ")}\` — reads the case memory and returns a cited answer. No network, no changes.`,
        },
      };
    },
    async invoke(options, token) {
      if (!deps.locator.caseDir) return textResult(NO_CASE);
      if (!options.input.question?.trim()) return textResult("Provide a non-empty question.");
      if (flagLikeText(options.input.question)) return textResult(FLAG_LIKE_MESSAGE);
      const outcome = await runVerbForChat(deps.bridge, askArgs(options.input), token);
      if (!outcome.ok) return textResult(outcome.message ?? "overcast failed.");
      // ask answers can run long — raise the field cap so the answer text survives
      // while the whole JSON stays within the overall budget.
      return textResult(summarizeVerbResult(outcome.records, "ask", { fieldCap: 2000 }));
    },
  };

  const scanTool: vscode.LanguageModelTool<ScanInput> = {
    prepareInvocation(options) {
      return {
        invocationMessage: "Scanning overcast sources",
        confirmationMessages: {
          title: "Scan OSINT sources (reaches the network)",
          message: `Run \`overcast ${scanArgs(options.input).join(" ")}\` — this **reaches the network**, scanning the case's configured OSINT sources, and writes scan.hit records into the case.`,
        },
      };
    },
    async invoke(options, token) {
      if (!deps.locator.caseDir) return textResult(NO_CASE);
      const flaggy = [options.input.query, options.input.source, options.input.since];
      if (flaggy.some((v) => v && flagLikeText(v))) return textResult(FLAG_LIKE_MESSAGE);
      const outcome = await runVerbForChat(deps.bridge, scanArgs(options.input), token);
      // scan exits non-zero when ANY source is credential-gapped even though
      // healthy sources returned hits — report both, never swallow the hits.
      const hits = scanHits(outcome.records);
      if (!outcome.ok && hits.length === 0) return textResult(outcome.message ?? "overcast failed.");
      const doc: Record<string, unknown> = { hits: hits.length, results: hits };
      if (!outcome.ok) doc.warning = outcome.message;
      return textResult(toModelJson(doc));
    },
  };

  const captureTool: vscode.LanguageModelTool<CaptureInput> = {
    prepareInvocation(options) {
      return {
        invocationMessage: `Capturing ${options.input.ref}`,
        confirmationMessages: {
          title: "Capture into the case (reaches the network)",
          message: `Run \`overcast capture ${options.input.ref}\` — **fetches the resource** (a URL may reach the network) and writes a capture record into the case.`,
        },
      };
    },
    async invoke(options, token) {
      if (!deps.locator.caseDir) return textResult(NO_CASE);
      if (!options.input.ref?.trim()) return textResult("Provide a ref: a URL, a scan-hit record id, or a local path.");
      if (flagLikeText(options.input.ref)) return textResult(FLAG_LIKE_MESSAGE);
      const outcome = await runVerbForChat(deps.bridge, ["capture", options.input.ref.trim()], token);
      if (!outcome.ok) return textResult(outcome.message ?? "overcast failed.");
      return textResult(summarizeVerbResult(outcome.records, "capture"));
    },
  };

  const senseTool: vscode.LanguageModelTool<SenseInput> = {
    prepareInvocation(options) {
      return {
        invocationMessage: `Running ${options.input.verb} on ${options.input.file}`,
        confirmationMessages: {
          title: "Run a perception sense",
          message: `Run \`overcast ${options.input.verb} ${options.input.file}\` — runs the ${options.input.verb} perception provider on the file (may reach a cloud backend, e.g. tinycloud) and writes an evidence record into the case.`,
        },
      };
    },
    async invoke(options, token) {
      if (!deps.locator.caseDir) return textResult(NO_CASE);
      if (!SENSE_VERBS.has(options.input.verb)) {
        return textResult("verb must be one of: watch, listen, see, face, exif.");
      }
      const abs = resolveMediaFile(deps.locator.caseDir, options.input.file);
      if (!abs) {
        return textResult(
          `File not found: ${options.input.file}. Provide a path that exists (absolute, or relative to the workspace/case folder).`,
        );
      }
      const outcome = await runVerbForChat(deps.bridge, [options.input.verb, abs], token);
      if (!outcome.ok) return textResult(outcome.message ?? "overcast failed.");
      return textResult(summarizeVerbResult(outcome.records, options.input.verb));
    },
  };

  const noteTool: vscode.LanguageModelTool<NoteInput> = {
    prepareInvocation(options) {
      return {
        invocationMessage: "Adding an analyst note",
        confirmationMessages: {
          title: "Add an analyst note",
          message: `Run \`overcast ${noteArgs(options.input).join(" ")}\` — writes a human observation into the case (searchable by ask, shown in the brief). No network.`,
        },
      };
    },
    async invoke(options, token) {
      if (!deps.locator.caseDir) return textResult(NO_CASE);
      if (!options.input.text?.trim()) return textResult("Provide non-empty note text.");
      if (flagLikeText(options.input.text)) return textResult(FLAG_LIKE_MESSAGE);
      const outcome = await runVerbForChat(deps.bridge, noteArgs(options.input), token);
      if (!outcome.ok) return textResult(outcome.message ?? "overcast failed.");
      return textResult(summarizeVerbResult(outcome.records, "note"));
    },
  };

  deps.context.subscriptions.push(
    vscode.lm.registerTool("overcast_case_status", caseStatusTool),
    vscode.lm.registerTool("overcast_ask", askTool),
    vscode.lm.registerTool("overcast_scan", scanTool),
    vscode.lm.registerTool("overcast_capture", captureTool),
    vscode.lm.registerTool("overcast_sense", senseTool),
    vscode.lm.registerTool("overcast_note", noteTool),
  );
}
