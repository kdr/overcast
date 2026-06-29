---
name: overcast-media-bug-triage
description: >-
  Analyze screen recordings, product demos, customer support videos, and audio
  notes into actionable, cited bug reports for coding agents.
---

# overcast-media-bug-triage

Use this skill when media evidence should become a bug report, reproduction
steps, or engineering triage notes. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact command flags.

## Workflow

```bash
overcast doctor --json
overcast case init --json
overcast case setup --yes --json
overcast watch ./screen-recording.mp4 --json
overcast listen ./screen-recording.mp4 --describe --json
overcast see frame://<record-id>@<timestamp> --ocr --json
overcast note "observed UI state or suspected failure" --ref <record-id> --at <time-range> --json
overcast ask "summarize the bug with reproduction steps and citations" --json
overcast brief --export ./bug-brief.md --json
```

Use `watch` for screen recordings and demos. Add `listen --describe` when
spoken narration, audio cues, or support-call context matters. Use `see --ocr`
on key frames when UI text, error messages, button labels, or form values are
important.

## Output

Produce a cited bug summary with:

- observed behavior with timestamps;
- expected behavior when it is inferable from the media or product context;
- reproduction steps grounded in `record.id` and `media.at`;
- UI text or OCR evidence from `see --ocr`;
- open questions when the media is ambiguous.

## Evidence Rules

Keep observed media facts separate from engineering inference. Add human
observations with `note`. Prefer `ask` and `brief` for synthesis; use
`case memory get` to page large `watch` or `listen` fields when exact
timeline text is needed.
