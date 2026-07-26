---
name: overcast-bolo
description: >-
  Be on the lookout — stand up a standing face/image watchlist: register a
  reference face, point a monitor at incoming feeds, auto-match every new item
  against the reference, and surface hits as a triage queue + alert so a match
  announces itself.
---

# overcast-bolo

Use this skill for a be-on-the-lookout / all-points-bulletin: "here is a face,
alert me on any match across incoming media." It is a standing watch keyed on a
VISUAL reference (a face or image), not a one-shot lineup search. Use the broad
`overcast` skill and `overcast/reference/verbs.md` for exact flags. Only leave a
continuous loop running when the user asks for ongoing monitoring.

This packages existing machinery: a `target --image` is the reference line hits
attach to, `monitor --pull --pipe` captures + senses new media, and the persist
hook auto-runs the score triggers on every evidence record — a `face --match`
≥75 (or `similar match` ≥85) auto-emits a `suggested` finding linked to that
line. The BOLO flow names and sequences those pieces. It is the close cousin of
`overcast-stakeout` (a general standing watch, often keyed on a text target) and
`overcast-lineup` (a one-shot identify against a local face DB); reach for those
when the watch is text-keyed or the job is a single database lookup.

## Prerequisites

Pick the matcher up front — it decides the backend the watch needs:

- **tinycloud face** (default `face` provider): `CLOUDGLUE_API_KEY` set, tinycloud
  CLI on PATH. No local Python. `face <clip> --match <ref>` runs against the clip.
- **deepface-local** (offline, no cloud): the uv-managed visual-DB Python
  (`scripts/visual-db-uv.sh --face`, then `OC_VISUAL_DB_PY`). Reference faces live
  in a local `deepface-local` index; `similar match` uses a local `basic-clip`
  index instead. Nothing leaves the case.

```bash
overcast doctor --json                 # confirm the face/visual-db backend is ready
overcast case init --json
```

## Workflow

1. Register the watchlist reference. The reference face becomes an **image
   target** — the line of investigation every hit attaches to. Add one target per
   person/object you are looking out for:

```bash
overcast target add ./suspect.jpg --image --question "Does the watchlisted person appear in incoming media?" --json
overcast target list --json                                  # confirm the image line (kind: image)
```

   For LOCAL matching, also stand up a face/image index and register the
   reference(s) in it, so you can match case-wide without re-passing the file:

```bash
overcast index create bolo-faces --type deepface-local --local --json    # local face DB
overcast index add ./suspect.jpg --to <index-id> --json                  # enroll the reference face
# semantic image alternative: overcast index create bolo-seen --type basic-clip --local --json
```

2. Point the watch at incoming feeds and stand it up. Reuse any configured source
   (`x` / `youtube` / `tiktok` / `instagram` / `telegram` / `browser` / …).
   Recording the reference as a case `--face-ref` with `--findings suggest` +
   `--auto-sense watch` makes new captures auto-sense and auto-suggest without a
   manual pass:

```bash
overcast source add "x:<query>" --json
overcast case setup --name bolo --face-ref ./suspect.jpg --findings suggest --auto-sense watch --yes --json
overcast monitor --once --pull --pipe watch --json           # one diff pass: confirm sources resolve
overcast monitor --every 30m --pull --pipe watch --json      # the standing loop (run under tmux)
```

3. Auto-match incoming media against the reference — the BOLO core. Because
   `face --match` / `similar match` fire the suggested-finding trigger on run,
   run the reference match over each newly captured item. A hit at/above the
   threshold (face ≥75, similar ≥85) auto-emits a `suggested` finding linked to
   the image target line:

```bash
overcast face <new-clip> --match ./suspect.jpg --json                      # tinycloud/deepface: find the face IN the clip
overcast face <new-clip> --match ./suspect.jpg --index <index-id> --json   # deepface-local matcher over the clip
overcast similar match ./suspect.jpg --index <index-id> --json             # basic-clip semantic image match
```

4. The alert / triage queue — the BOLO board. New hits queue as `suggested`
   leads (quarantined from ask/brief until reviewed). Confirm a real hit with
   `accept` (stamping it onto the reference line); reject a false positive with
   `dismiss` (never re-fires for that match):

```bash
overcast finding list --state triage --json                          # the BOLO board (leads awaiting review)
overcast finding accept <finding-id> --target <target-id> --json     # confirm the hit onto the reference line
overcast finding dismiss <finding-id> --note "wrong person" --json   # reject a false positive
```

5. The wall / live surface (optional). Keep a control-room view of the standing
   watch — every case video muted and looping at its best evidence moment,
   freshest first:

```bash
overcast wall --refresh 60 --theme csi --json          # static HTML monitor wall
overcast brief --export ./bolo.html --json             # periodic cited report
```

   For a LIVE self-updating page, an **operator** serves the situation room
   (`overcast situation` in its own pane, or `/situation on` in the TUI) — never
   the agent. Full drill: `overcast-situation-room`.

## Output

A standing case that alerts on visual matches over time. For each confirmed hit
return: the reference (image target) it matched, the source clip's `record.id` +
`media.at`, the match score (face similarity 0–100 / similar 0–100), the
`suggested`→`accepted` finding id, and the reference target line it lands on.
State the cadence, which sources are live, and which matcher (tinycloud vs
deepface-local) the watch runs on.

## Caveats

- A face/image target is EXCLUDED from text auto-findings — the visual match is
  the trigger, so you must run `face --match` / `similar match` on new media (or
  wire it via `case setup`), not rely on a text phrase.
- Auto-suggested visual hits are LEADS, not identifications — face embeddings
  degrade on poor lighting, small faces, and heavy angles. Corroborate a single
  borderline match (a second clip, `overcast-lineup`) before naming anyone.
- Apify-backed sources (`x`, `tiktok`, `instagram`, `lens`) bill per result;
  keep `--limit` low on a frequent loop. The wall decodes real video (~25 tiles
  is a practical ceiling — use `--source`/`--since` to scope it).
- Hard processing failures are marked seen (no infinite retry); credential/pending
  gaps stay retryable — run `overcast doctor --sources` when a feed goes quiet.

## Deferred follow-up (not in v1)

- **Alert on a text description** ("a person in a red hoodie carrying a
  backpack"). This needs a standing open-vocab detector (`see --detect`) on every
  incoming frame — noisier and costlier than a reference match, so it is out of
  scope for v1. Today, key a BOLO on a face/image reference. For a text-KEYWORD
  watch (a name/phrase in sensed transcripts), use `overcast-stakeout` with a
  non-image text target instead.
- **A first-class `bolo` state verb** wrapping steps 1–4 (register → watch →
  auto-match → triage) is a possible future convenience. v1 is skill-only over
  the existing verbs; no new verb was added.
