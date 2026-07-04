---
name: overcast-frame-grid
description: >-
  Triage a whole clip in one VLM call — tile sampled frames into a labeled
  contact sheet, ask which cells show the target, then zoom in.
---

# overcast-frame-grid

Use this skill to find roughly WHERE in a clip something appears with a single
vision call, before spending per-frame calls. It's the "grid trick" from
temporal-search research (frames tiled into one image; Set-of-Mark numbering over
time). Pairs with `overcast-pinpoint` for the frame-precise follow-up. Use the
broad `overcast` skill and `overcast/reference/verbs.md` for exact flags.

## Workflow

\`\`\`bash
overcast doctor --json
overcast case init --json
overcast grid ./clip.mp4 --count 16 --json     # -> media.grid: payload.montage + payload.cells + payload.cols
overcast see <montage-path> --prompt "Which numbered cells show <X>? Reply with cell numbers and why." --json
\`\`\`

- If the grid record's `payload.labeled` is `false` (this ffmpeg build has no
  `drawtext`), tell `see` it's a `<cols>`-column grid numbered left-to-right,
  top-to-bottom (`cols` is in the record), so it can reference cells by position.
- Only the first `count` cells hold frames; the last row may be blank padding
  (those `payload.cells[].at` are `null`), so have `see` pick from 1..`count`
  and ignore blank tiles.
- Always map the chosen cell number back through `payload.cells[n].at` to get the
  real timestamp — never use a time the model typed out.

Zoom in on the winning region (narrow the window, or hand the timestamp to
`overcast-pinpoint`):

\`\`\`bash
overcast grid ./clip.mp4 --start <a> --end <b> --count 16 --json   # finer sheet around the hit
overcast see frame://<watch-record>@<t> --prompt "Is <X> here? yes/no + detail" --json
overcast note "<X> first visible" --ref <record> --at <t1-t2> --json
overcast brief --export ./grid-triage.md --json
\`\`\`

Use `--at "s1,s2,s3"` instead of `--count` when you already have candidate
timestamps to compare side by side; `--start/--end` to focus a window; `--cols`
/ `--width` to shape the sheet. Add `--view` (`--no-open` in a headless run) to
also write a clickable HTML board — numbered, timestamped cells that seek the
source clip — for eyeballing the sheet by hand; the montage PNG stays the input
you hand to `see`.

## Output

The cell(s) that matched, the timestamp each maps to (via `payload.cells`), and
the grid `record.id`. Treat grid hits as coarse (one frame per cell) — confirm
the exact moment by `see`-ing that frame before citing it as evidence.

## Caveats

One contact sheet samples sparsely, so a brief event between cells can be missed —
raise `--count` or re-grid a tighter `--start/--end`. The montage is a still, so
motion/audio cues are gone; use `watch`/`listen` when those matter. Video can be
local or a URL, but the `see frame://` zoom-in step needs it local.
