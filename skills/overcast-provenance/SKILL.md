---
name: overcast-provenance
description: >-
  Trace a suspicious or viral clip back to its earliest appearance and originator —
  reverse-image-search distinctive frames, sweep sources with no recency floor, and
  return a cited origin verdict.
---

# overcast-provenance

Use this skill to answer "is this clip real / where did it come from?": given a
suspect video, find the oldest copy and who posted it first. It is the inverse of
`overcast-copycat-sweep` — searching backward toward the origin rather than forward
for rips — and reuses its geometry-gating and verdict conventions. This skill answers
WHERE a clip came from (origin / earliest copy); for whether it was ALTERED
(manipulation/authenticity — C2PA, EXIF re-save, ELA overlays, a shadow check) use
the complementary `overcast-verify-media`. Origin and authenticity are distinct,
non-overlapping questions — the leading `verify`/`exif` pass below establishes
provenance signals, not a fakery verdict. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags.

## Workflow

1. Check embedded provenance FIRST, then fingerprint the suspect clip. C2PA
   Content Credentials (`verify`) and EXIF capture metadata (`exif`) are the most
   direct origin evidence when present — a signed manifest names the creator + edit
   history. They're often stripped on re-upload, so also fingerprint distinctive
   frames (which survive the re-encodes, crops, and watermarks that defeat exact
   hashes AND that strip metadata):

```bash
overcast doctor --sources --json
overcast case init --json
overcast verify ./suspect.mp4 --json         # C2PA / Content Credentials: signer + edit manifest (needs c2patool)
overcast exif ./suspect.mp4 --json           # capture device/time, editing software, GPS (needs exiftool)
overcast watch ./suspect.mp4 --json          # content + transcript into memory
overcast index create origin --type image-ransac --local --json
overcast image add ./distinctive-frame.png --index <index-id> --json
```

2. Reverse-image-search the frames and sweep sources with topic keywords — crucially
   with NO `--since` floor, since older results sit closer to the origin:

```bash
overcast source add "lens:./distinctive-frame.png" --json
overcast source add "x:video:<topic keywords>" --json
overcast source add "youtube:search:<topic keywords>" --json
overcast source add "web:<topic keywords>" --json
overcast scan --limit 20 --json
```

3. Triage on metadata alone: sort candidate hits by `published` ASC — the earliest
   dates are your origin candidates; carry `author` + URL forward.

4. Capture the oldest few and confirm they are the SAME content (not a look-alike) —
   frame match plus transcript:

```bash
overcast capture <earliest-scan-hit-id> --json
overcast image match <captured-file> --index <index-id> --draw --json   # --draw writes the RANSAC overlay proof
overcast listen <captured-file> --json
```

5. Record the origin verdict. `--ref` the `image match` record so its overlay rides
   into the brief; ALWAYS leave a `tldr` note with the date chain — even
   "undetermined":

```bash
overcast finding create "origin: earliest confirmed copy is @<author> <date> (frame match 88 inliers, transcript identical); the viral <date2> post is a re-upload" --ref <image-match-record-id> --confidence high --json
overcast note "swept lens + x + youtube + web (no recency floor); <n> candidates; earliest confirmed <date> by @<author>; verdict: re-upload" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./provenance.html --json
```

## Output

An origin verdict — original / re-upload-of-<earliest> / undetermined — with the
date chain, the earliest confirmed poster and URL, which layers agreed (frame +
transcript), and the strongest `record.id` + `media.at` citations. "Undetermined"
is honest when the earliest copy can't be confirmed as the same content.

## Caveats

The earliest date you FIND is a floor, not proof of origin — deleted posts and
platforms you didn't search may predate it; say so. Confirm same-content with the
gated `image match` (a high inlier count on a degenerate homography is the main
false positive — eyeball the `--draw` overlay) plus transcript; a shared topic or a
look-alike frame is not the same clip. Face similarity is 0–100; `image match` is
an inlier count + a 0–1 ratio, never a 0–100 score. Apify sources bill per result.
`lens` ignores `--since`.
