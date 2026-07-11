---
name: overcast-pinpoint
description: >-
  Pinpoint WHEN a specific thing happens in a video — funnel from cheap
  coarse candidates (shots / CLIP / grid) to a frame-verified time window.
---

# overcast-pinpoint

Use this skill to answer "exactly when does X happen?" in a clip and back it
with evidence the model actually looked at. It mirrors the temporal-search
pattern from the VLM video literature (T\* / VideoAgent): score cheaply over the
whole clip, then spend expensive VLM calls only on a few candidate frames and
zoom in. Use the broad `overcast` skill and `overcast/reference/verbs.md` for
exact flags.

Two rules that make the answer trustworthy:

- **Report a window, not a frame.** Frame-exact localization is unreliable; emit
  `[t1-t2]` plus one verified keyframe.
- **Every timestamp must trace to a frame you `see`-verified.** Never emit a
  time the model merely guessed — models answer correctly while grounding on the
  wrong moment, so confirm by looking at the frame.

## Workflow

1. Make the clip local and get a record id (`see frame://` needs media on disk —
   capture a remote clip first). `watch` also gives per-shot timestamped content
   to search:

```bash
overcast doctor --json
overcast case init --json
overcast watch ./clip.mp4 --json         # -> video.analysis record id (REC)
```

2. Get COARSE candidates cheaply (pick what's available):

```bash
overcast ask "moments where <X> happens, with timestamps" --json      # over watch shots/notes
overcast grid ./clip.mp4 --count 16 --json                            # one contact sheet ...
overcast see <montage-path> --prompt "which numbered cells show <X>? give cell numbers" --json
overcast similar search "<X>" --index <basic-clip-id> --json          # if a local CLIP index exists
overcast ask "moments <X> happens" --index <media-descriptions-id> --probe --json  # remote index
```

   For `grid`, translate the chosen cell number to a time via the grid record's
   `payload.cells[n].at` (don't trust a model-guessed time). CLIP/shots only
   SHORTLIST — CLIP is weak on actions/order — so verify next.

3. VERIFY + zoom on each candidate time T (expensive, precise):

```bash
overcast see frame://REC@T --prompt "Is <X> happening here? answer yes/no and what you see" --json
# refine: sample T-d and T+d, halve d each round until adjacent frames flip yes<->no
overcast see frame://REC@<T-2> --prompt "Is <X> happening?" --json
overcast see frame://REC@<T+2> --prompt "Is <X> happening?" --json
```

4. Record the verified window and eyeball it:

```bash
overcast note "<X> occurs" --ref REC --at <t1-t2> --confidence medium --json
overcast view REC --at <t1-t2> --json
overcast brief --export ./pinpoint.md --json
```

## Output

The tightest `[t1-t2]` window, the single `see` keyframe that confirms it (its
`record.id`), and how it was found (shots / grid / CLIP / probe). Cite
`record.id` + `media.at` for every claim; state the window, not a false-precise
single frame.

## Caveats

Needs the video local (a URL-only `watch` record can't extract frames). CLIP and
shot text shortlist but don't decide — the `see` frame check does. If `X` recurs,
pinpoint each occurrence separately; don't collapse them into one window.
