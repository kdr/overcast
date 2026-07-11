---
name: brief
description: Synthesize the case into a structured report.
---
Use the `brief` verb to synthesize the current case's records into a report.
By default the brief is **short** and story-first: a Verdict block (the analyst
TL;DR leading; the machine coverage line, goal-progress headline, and a "since
last brief" delta demoted to one meta line under it), then one story per line
of investigation (question → answer so far → linked findings → latest evidence
→ NEXT move), findings not linked to any line, the triage queue (each lead with
its trigger score + source excerpt and the exact accept/dismiss commands), ONE
coverage table (configured sources + ad-hoc sweeps, never-scanned flagged), and
a newest-first record trail. Pass `--full` for the complete verbatim record
timeline (the audit dump). Every item is anchored to `record.id` + `media.at`;
read any record in full with `overcast case memory get <id>`. To produce a
shareable artifact, pass `--export ./brief.html` (or `.md`).

Scope (optional): $ARGUMENTS
