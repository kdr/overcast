---
name: overcast-copycat-sweep
description: >-
  Hunt re-uploads and reskins of original video content across X / YouTube /
  TikTok — escalate from cheap metadata triage to frame/face/transcript
  matching and produce citable copycat findings.
---

# overcast-copycat-sweep

Use this skill when the task is to find copies, re-uploads, or reskins of a
creator's original media (video theft / freebooting) and build an evidence-backed
report. Use the broad `overcast` skill and `overcast/reference/verbs.md` for
exact flags. Escalate tier by tier — never capture what metadata already rules
out.

## Workflow

1. Fingerprint the original (once per case). Reskins defeat exact hashes, so
   fingerprint three ways — distinctive frames, the creator's face, and the
   transcript:

```bash
overcast doctor --sources --json
overcast case init --json
overcast case setup --name copycat-sweep --target "<creator / original title>" --source "x:video:<topic keywords>" --yes --no-index --json
overcast watch ./original.mp4 --json      # content + transcript into case memory
overcast index create originals --type image-ransac --local --json
overcast image add ./title-card.png --index <index-id> --json   # + diagrams, key frames
```

2. Sweep sources for candidates published AFTER the original — media-targeted
   (`x:video:`) queries with topic keywords, not exact titles:

```bash
overcast source add 'youtube:search:<topic keywords>' --json
overcast scan --since <original-publish-date> --limit 20 --json
```

3. Triage on scan metadata alone (no downloads): keep hits whose `published`
   postdates the original, whose `duration` is close to it, or whose
   `title`/`snippet` echoes it; carry `author` and `views` into the report.

4. Escalate survivors — capture, then match every fingerprint layer:

```bash
overcast capture <scan-hit-id> --json
overcast image match <captured-file> --index <index-id> --draw --json   # frames survive reskins/subtitles; --draw writes match-overlay proof
overcast face <captured-file> --match ./creator.jpg --json   # the face survives re-branding
overcast listen <captured-file> --json                       # verbatim transcript = strongest signal
overcast ask "does this captured video repeat the original's content? cite moments" --json
```

Pass `--draw` on `image match` so each matched frame writes a RANSAC overlay
(original ↔ suspect keypoints). Cite the `image` match record as the finding's
`--ref` in step 5 — the brief embeds that overlay in the finding card as
visual proof.

**Local mode (no external source).** The skill works entirely on local files:
skip steps 2–3 and run `image match` / `face --match` / `listen` directly on
candidate videos already on disk (or captured earlier). This is how you compare a
suspected rip you already have against the original, and how the pipeline is
tested offline (fingerprint an original, confirm a reskinned copy, reject an
unrelated clip) — no scan, no API. `scan --local` also sweeps the case's own
media/indexes when no source is enabled.

5. Record verdicts and report; keep a standing watch. One `finding` per
   confirmed copycat stating the because-clause (which layers matched, with
   scores), and ALWAYS one narrative note tagged `tldr` — even when the sweep
   comes up clean ("checked N sources, M candidates triaged, no copycats
   found") — because the brief's TL;DR / sources-checked / matches header is
   derived from exactly these records:

```bash
overcast finding create "copycat: <original> re-uploaded by @<author> (<views> views) — image frames 3x (best 94 inliers), face 87/100" --ref <image-match-record-id> --confidence high --json
overcast note "checked x + youtube (<n> hits); <m> candidates escalated; <k> confirmed: @<author> ..." --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./copycats.html --json
overcast monitor --every 1d --json
```

Point the finding's `--ref` at the `image match` record (not the raw scan
hit) so its match-draw overlay rides into the finding card as visual proof.

## Output

For each confirmed copycat return: post URL, `author`, `views`, `published`,
which layers matched (image frames / face / transcript), the strongest
`record.id` + `media.at` citations, and the exported brief path. The exported
brief opens with the TL;DR narrative (from the `tldr`-tagged note), the
sources-checked rollup, and the matches & findings verdicts; a clean sweep
must still say so explicitly ("checked, found none").

## Caveats

Copycats retitle and re-caption, so search topic keywords and confirm with the
visual/transcript layers: burned-in subtitles and translated dubs defeat text
matching but not `image` frame matching or `face --match`. Face and image
similarity scores are 0–100, not 0–1. A repost/quote is a share, not a rip —
confirm the account re-uploaded the media natively (check `x:video:from:<handle>`).
Apify-backed sources bill per result — prefer few, broad queries over many
narrow ones.

Keyword overlap is NOT a match: accounts pump many videos that share your topic
words, so text triage only shortlists — the frame/face/transcript layers decide.
Do not trust an `image match` inlier count alone; a high count on a degenerate
homography is the main false positive. `image match` gates on planar-projection
validity by default (`--draw` writes the overlay so you can eyeball coherent
correspondences vs lines collapsing to a point). Call a video a confirmed rip
only when the gated match survives AND the transcript/face agree.
