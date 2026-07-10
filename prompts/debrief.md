---
name: debrief
description: Triage suggested leads, narrate each line of investigation, then export the brief.
---
Run an analyst debrief over the current case. The verbs are deterministic; YOU
supply the judgment and narrative (overcast never runs an LLM inside a verb).
Work through these steps in order, using the tools:

1. **Triage the suggested leads.** Run `finding list --state triage --json`. For
   each suggested finding, weigh its `signal.score` and the cited record's
   provenance (`source_url` / `source_excerpt`). Then either
   `finding accept <id> --target <target_id>` (it becomes evidence in ask/brief;
   `--target` attributes it to a line of investigation so it renders inside that
   thread — pass the target id or value, omit only when no line fits) or
   `finding dismiss <id>` (a dismissed lead never re-suggests). Say why in one
   line per decision.

2. **Read the mission board.** Run `case status --json` and look at
   `pulse`/`threads` — each target is a line of investigation with a stage
   (cold → collecting → leads → corroborated). For every active thread, write ONE
   note tagged `thread:<target_id>` (2–3 sentences: the state of that line and the
   next move, or why it's a dead end):
   `note "…" --tag thread:<target_id>`. The brief renders these into the thread
   cards, so keep them tight and evidence-anchored.

3. **Close resolved lines.** If a thread is answered, `target close <id> --as
   answered --note "…"`; if it led nowhere, `target close <id> --as dead-end
   --note "…"`. Closed lines stop seeding scans and show dimmed in the report.

4. **Refresh the TL;DR.** Write (or update) one narrative note tagged `tldr`
   summarizing the case's current verdict: `note "…" --tag tldr`.

5. **Export the brief.** Run `brief --export ./brief.html --theme csi` (add
   `--full` only if the reader needs the verbatim record dump). Report the path
   and a two-line summary of where the investigation stands.

Optional focus / scope: $ARGUMENTS
