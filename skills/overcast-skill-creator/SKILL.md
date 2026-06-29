---
name: overcast-skill-creator
description: >-
  Create small, installable agent skills that wrap focused Overcast workflows.
  Use when the user asks to make an Overcast skill for a specific investigation,
  media analysis, recon, monitoring, or case-memory workflow.
---

# overcast-skill-creator

Use this when the user wants a focused skill built on Overcast instead of the
broad `overcast` skill. Example requests: "make an Overcast skill for analyzing
security camera clips", "create a skill that monitors a target and briefs me",
or "turn this Overcast workflow into an installable agent skill".

Reference the broad `overcast` skill and its
`overcast/reference/verbs.md` man pages for exact flags. Do not duplicate the
full verb reference.

## Design Rules

1. Pick one case lifecycle: initialize/setup, gather or sense evidence, add
   notes/findings, ask/brief, then export.
2. Choose the minimum verbs needed. Prefer `case setup`, `watch`,
   `listen`, `see`, `face`, `scan`, `capture`, `monitor`, `note`,
   `finding`, `ask`, and `brief` only when they serve the workflow.
3. Preserve citations. Evidence claims should cite `record.id` plus
   `media.at` when a timestamp or range exists.
4. Prefer `ask` and `brief` over raw JSON spelunking for synthesis. Use raw
   records for verification and exact fields, not as the default reading path.
5. For large `watch` content or `listen` transcripts, use
   `case memory get <record-id> --field <field> --offset <n> --limit <n>`
   rather than head/tail reads of JSONL.
6. State setup assumptions: `overcast doctor`, provider credentials, system
   `ffmpeg`/`ffprobe`, tinycloud version, and whether the workflow needs live
   sources or only local files.

## Template

````markdown
---
name: overcast-<workflow-name>
description: >-
  <One sentence about when an agent should use this focused Overcast workflow.>
---

# overcast-<workflow-name>

Use this skill when <trigger conditions>.

## Quickstart

```bash
overcast doctor --json
overcast case init --json
overcast case setup --target "<target>" --json
overcast <gather-or-sense-verb> <input> --json
overcast ask "<question>" --json
overcast brief --export ./brief.md --json
```

## Evidence Rules

- Cite `record.id` and `media.at` for every media-derived claim.
- Record human observations with `note --ref <record-id> --at <time-range>`.
- Separate observed facts, inferred expected behavior, and open questions.

## Failure Handling

- Run `overcast doctor --json` when a provider or system dependency fails.
- If a record field is large, page it with `case memory get`.
- If a source is unavailable, report the missing source and continue with local
  case evidence.

## Validation

```bash
overcast commands --json
overcast <main-verb> --help
overcast ask "<workflow-specific verification question>" --json
```
````
