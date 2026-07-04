---
name: brief
description: Synthesize the case into a structured report.
---
Use the `brief` verb to synthesize the current case's records into a report.
By default the brief is **short**: it leads with the verdict, key findings,
lines of investigation (per-target threads with stage + activity), the triage
queue of suggested leads awaiting review, and coverage gaps — followed by a
compact record trail. Pass `--full` for the complete verbatim record timeline
(the audit dump). Every item is anchored to `record.id` + `media.at`; read any
record in full with `overcast case memory get <id>`. To produce a shareable
artifact, pass `--export ./brief.html` (or `.md`).

Scope (optional): $ARGUMENTS
