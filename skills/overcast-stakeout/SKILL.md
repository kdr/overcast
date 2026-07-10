---
name: overcast-stakeout
description: >-
  Run a standing surveillance watch on public sources for a target — auto-sense
  new media, auto-suggest matches into a triage queue, and keep a live control-room
  wall — so new evidence surfaces itself over time.
---

# overcast-stakeout

Use this skill when the task is to sit on a target and catch new media as it is
published (a "stakeout"), rather than a one-shot recon pass. Use the broad
`overcast` skill and `overcast/reference/verbs.md` for exact flags. Only start a
continuous loop when the user asks for ongoing monitoring.

## Workflow

1. Set the standing scope. As new media arrives, matches auto-**suggest** leads —
   score/text triggers (a `face` ≥75 match, an `image` RANSAC hit, `similar`
   ≥85, `cluster` ≥70, or a **text** target the `watch`/`listen` text mentions)
   emit `status:"suggested"` findings that queue for triage (out of ask/brief
   until reviewed). `--findings suggest` is the default; pair it with
   `--auto-sense watch`:

```bash
overcast doctor --sources --json
overcast case init --json
overcast case setup --name stakeout --target "<name / plate / phrase>" --source "x:@handle,youtube:@channel" --auto-sense watch --findings suggest --yes --json
```

2. Sanity pass — one diff cycle, scheduler-friendly, to confirm sources resolve
   before you leave a loop running:

```bash
overcast monitor --once --pipe watch --json
```

3. Stand the watch up. Run the continuous loop under tmux; `--alert` mirrors new
   records to a sink and `--brief` summarizes each batch:

```bash
overcast monitor --every 15m --limit 5 --pipe watch --alert ./stakeout.jsonl --brief --json
```

4. Work the triage queue as leads accrue — `finding list --state triage` shows the
   suggested leads awaiting review; `accept` promotes a lead to evidence (it enters
   ask/brief), `dismiss` blocks it (never re-suggested for that match, but still
   auditable):

```bash
overcast finding list --state triage --json
overcast finding accept <finding-id> --json
overcast finding dismiss <finding-id> --json
```

5. Keep the control-room wall up as the visual surface — every case video muted
   and looping at its best evidence moment, freshest first, auto-restarting:

```bash
overcast wall --refresh 60 --theme csi --json
overcast wall --source x --since 24h --theme csi --json    # scope to one feed / window
overcast brief --export ./stakeout.html --json             # periodic cited report
```

**Face-forward stakeout.** A face/image suspect is an image target, which is
excluded from text auto-findings. Pipe detection instead (`monitor --pipe face`)
to surface faces in new media, then escalate the flagged clips manually with
`overcast face <clip> --match ./suspect.jpg --json`, or keep a face-analysis index
and search it (`face --match ./suspect.jpg --index <id>`).

**Page-watch stakeout.** To sit on a WEB PAGE instead of a feed, register the
rendered-page source: `overcast source add browser:<url>` (no key; playwright
optional dep), then `monitor --every 30m` — each pass re-renders the current
page state to a PNG that flows into image auto-sense. `wayback:<url>` is the
retrospective twin (its `collapse=digest` view surfaces content changes).

## Output

A standing case that accrues cited findings over time: accepted matches with their
source URL, `record.id`, and `media.at`; the alert-sink JSONL of new records; the
freshness-overlaid wall; and periodic `brief` exports. State the cadence and which
sources are live.

## Caveats

Hard processing failures are marked seen (no infinite retry); credential/pending
gaps stay retryable — run `doctor --sources` when a feed goes quiet. Apify-backed
sources (`x`, `tiktok`, `lens`) bill per result, so keep `--limit` low on a
frequent loop. The wall decodes real video — ~25 tiles is a practical ceiling
(`--limit`); use `--source`/`--since` to scope it. Auto-findings are keyword
matches on sensed text, so they shortlist — confirm before acting.
