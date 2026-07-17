// Investigation sidebar: one collapsible node per line of investigation
// (TargetThread from `case status --json` payload.threads) — label = target
// value, description = stage + funnel, tooltip = question/narrative. Children:
// linked findings (text joined from the model's finding map) + recent evidence
// record ids (click → record detail). Closed lines sort to the bottom, dimmed.
//
// After the threads comes a single "Notes & leads" group: suggested findings
// (payload.triage — the merged former Triage view, inline ✓/✗ preserved via
// contextValue "overcast.finding") then recent notes (verb "note"), newest-first
// within each. The activity-bar badge (triage count) is set in extension.ts.
import * as vscode from "vscode";
import type { ExtDeps, TargetThread, TriageRow } from "../types.ts";

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}…` : text;
}

function stageIcon(thread: TargetThread): vscode.ThemeIcon {
  if (thread.status === "answered") return new vscode.ThemeIcon("check");
  if (thread.status === "dead-end") return new vscode.ThemeIcon("circle-slash");
  switch (thread.stage) {
    case "answered":
      return new vscode.ThemeIcon("check");
    case "dead-end":
      return new vscode.ThemeIcon("circle-slash");
    case "corroborated":
      return new vscode.ThemeIcon("verified");
    case "leads":
      return new vscode.ThemeIcon("search");
    case "collecting":
      return new vscode.ThemeIcon("sync");
    default:
      return new vscode.ThemeIcon("target");
  }
}

function isClosed(thread: TargetThread): boolean {
  return thread.status === "answered" || thread.status === "dead-end";
}

export class ThreadItem extends vscode.TreeItem {
  constructor(readonly thread: TargetThread) {
    const closed = isClosed(thread);
    const hasChildren =
      (thread.findingIds?.length ?? 0) > 0 || (thread.recentEvidenceIds?.length ?? 0) > 0;
    super(
      thread.value,
      // Open lines of investigation show their evidence at a glance; closed
      // ones start folded (they still sort to the bottom, dimmed).
      hasChildren
        ? closed
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    const funnel = thread.funnel ?? { scan: 0, captures: 0, senses: 0, matches: 0 };
    const funnelText = `scan ${funnel.scan} · cap ${funnel.captures} · sense ${funnel.senses}`;
    this.description = closed ? `${thread.stage} (closed)` : `${thread.stage} · ${funnelText}`;
    this.iconPath = stageIcon(thread);
    const lines: string[] = [];
    if (thread.question) lines.push(`Q: ${thread.question}`);
    if (thread.narrative) lines.push(thread.narrative);
    lines.push(`stage: ${thread.stage} · status: ${thread.status}`);
    lines.push(funnelText);
    this.tooltip = lines.join("\n\n");
    this.contextValue = "overcast.thread";
    this.id = `thread:${thread.id}`;
  }
}

class ThreadFindingItem extends vscode.TreeItem {
  readonly findingId: string;
  constructor(findingId: string, text: string, status: string) {
    super(truncate(text), vscode.TreeItemCollapsibleState.None);
    this.findingId = findingId;
    this.description = status;
    this.iconPath = new vscode.ThemeIcon(
      status === "accepted" ? "star-full" : status === "dismissed" ? "trash" : "lightbulb",
    );
    this.contextValue = "overcast.finding";
    this.command = {
      command: "overcast.openRecord",
      title: "Open Record",
      arguments: [findingId],
    };
  }
}

class ThreadEvidenceItem extends vscode.TreeItem {
  readonly recordId: string;
  constructor(recordId: string, verb: string | undefined) {
    super(verb ? `${verb} ${recordId}` : recordId, vscode.TreeItemCollapsibleState.None);
    this.recordId = recordId;
    this.iconPath = new vscode.ThemeIcon("file-media");
    this.contextValue = "overcast.record";
    this.command = {
      command: "overcast.openRecord",
      title: "Open Record",
      arguments: [recordId],
    };
  }
}

// The "Notes & leads" section header. Its tooltip folds in the (former Triage
// view) explainer of what a suggested lead is.
class NotesLeadsGroupItem extends vscode.TreeItem {
  constructor(leads: number, notes: number) {
    super("Notes & leads", vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon("note");
    this.description = [leads ? `${leads} lead${leads === 1 ? "" : "s"}` : "", notes ? `${notes} note${notes === 1 ? "" : "s"}` : ""]
      .filter(Boolean)
      .join(" · ");
    this.tooltip =
      "Suggested findings + your notes.\n\n" +
      "Leads are auto-raised when a match crosses a threshold (face/similar/voice/audio, an EXIF/provenance flag, a target-phrase hit). They stay out of ask/brief until you review them: ✓ accept promotes a lead to evidence, 🗑 dismiss rejects it. Notes are human observations you add.";
    this.contextValue = "overcast.notesLeads";
    this.id = "notes-leads";
  }
}

// A suggested lead (payload.triage row) rendered note-style. Must keep
// contextValue "overcast.finding" + a `findingId` field so the existing inline
// accept/dismiss + accept-with-target commands (findingCommands.idFrom) work.
class LeadItem extends vscode.TreeItem {
  readonly findingId: string;
  constructor(row: TriageRow) {
    super(truncate(String(row.text ?? "")), vscode.TreeItemCollapsibleState.None);
    this.findingId = row.id;
    const parts: string[] = [];
    // confidence is untyped payload data — only a non-empty string renders
    if (typeof row.confidence === "string" && row.confidence) parts.push(row.confidence);
    if (typeof row.score === "number") parts.push(`score ${row.score}`);
    this.description = parts.join(" · ");
    const tip = [
      `Suggested lead — ${row.text}`,
      "",
      "✓ Accept as evidence (promotes it into ask/brief)",
      "🗑 Dismiss (not relevant — never re-fires)",
    ];
    if (row.excerpt) tip.push("", String(row.excerpt));
    if (row.url) tip.push("", String(row.url));
    this.tooltip = tip.join("\n");
    this.iconPath = new vscode.ThemeIcon("lightbulb");
    this.contextValue = "overcast.finding";
    this.id = `lead:${row.id}`;
    this.command = {
      command: "overcast.openRecord",
      title: "Open Record",
      arguments: [row.id],
    };
  }
}

// A recent note record. Body is enriched lazily by the model; before it lands
// the id stands in.
class NoteItem extends vscode.TreeItem {
  readonly recordId: string;
  constructor(id: string, text: string | undefined) {
    const body = text?.trim();
    super(body ? truncate(body) : id, vscode.TreeItemCollapsibleState.None);
    this.recordId = id;
    this.iconPath = new vscode.ThemeIcon("note");
    this.tooltip = body ? `${body}\n\n${id}` : id;
    this.contextValue = "overcast.record";
    this.id = `note:${id}`;
    this.command = {
      command: "overcast.openRecord",
      title: "Open Record",
      arguments: [id],
    };
  }
}

export class InvestigationTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: ExtDeps) {
    deps.model.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  // Only ROOT elements are ever reveal()ed (the extension's one-time layout
  // nudge) — a flat undefined parent satisfies TreeView.reveal's requirement.
  getParent(): vscode.TreeItem | undefined {
    return undefined;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      const threads = this.deps.model.status?.threads ?? [];
      const open = threads.filter((t) => !isClosed(t));
      const closed = threads.filter(isClosed);
      const items: vscode.TreeItem[] = [...open, ...closed].map((t) => new ThreadItem(t));
      const leads = this.deps.model.status?.triage?.length ?? 0;
      const notes = this.deps.model.notes.length;
      // Empty in every section → return [] so the no-case/no-CLI welcome shows.
      if (leads + notes > 0) items.push(new NotesLeadsGroupItem(leads, notes));
      return items;
    }
    if (element instanceof ThreadItem) {
      const items: vscode.TreeItem[] = [];
      const verbById = new Map(this.deps.model.records.map((r) => [r.id, r.verb]));
      for (const fid of element.thread.findingIds ?? []) {
        const f = this.deps.model.findings.get(fid);
        items.push(new ThreadFindingItem(fid, f?.text ?? fid, f?.status ?? "open"));
      }
      for (const rid of element.thread.recentEvidenceIds ?? []) {
        items.push(new ThreadEvidenceItem(rid, verbById.get(rid)));
      }
      return items;
    }
    if (element instanceof NotesLeadsGroupItem) {
      // Leads first (newest-first from payload.triage), then recent notes
      // (newest-first from the model). No shared per-item timestamp exists to
      // interleave the two groups by time — see the model note.
      const leads = (this.deps.model.status?.triage ?? []).map((r) => new LeadItem(r as TriageRow));
      const notes = this.deps.model.notes.map((n) => new NoteItem(n.id, n.text));
      return [...leads, ...notes];
    }
    return [];
  }
}
