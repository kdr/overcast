---
name: overcast-event-bisect
description: >-
  Localize the exact instant of a one-way state change (light on, door opens,
  poster removed) by binary-searching frames — ~log2(N) VLM calls.
---

# overcast-event-bisect

Use this skill when a video contains a single MONOTONE transition — a condition
that is false before some instant and true after it (or vice versa), and does not
flip back. Binary search finds it in about log2(window/precision) vision calls
(~12 calls localizes to ~1s inside an hour). Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags.

## Workflow

1. Local clip + record id (`see frame://` needs media on disk):

\`\`\`bash
overcast doctor --json
overcast case init --json
overcast watch ./clip.mp4 --json        # -> record id REC (also gives shot context)
\`\`\`

2. Confirm the transition is bracketed AND monotone — the two endpoints must
   disagree on the predicate:

\`\`\`bash
overcast see frame://REC@<lo> --prompt "Is <predicate> true? answer only yes or no" --json
overcast see frame://REC@<hi> --prompt "Is <predicate> true? answer only yes or no" --json
\`\`\`

   If both give the same answer, the flip isn't in `[lo,hi]`. If the predicate
   toggles more than once, it isn't monotone — use `overcast-pinpoint` instead.

3. Bisect: test the midpoint, keep the half that still straddles the flip, repeat
   until `hi - lo` is within your precision:

\`\`\`bash
overcast see frame://REC@<mid> --prompt "Is <predicate> true? answer only yes or no" --json
# keep the straddling half: if mid's answer == lo's answer, set lo=mid; else hi=mid
# (correct whichever way it flips — false->true OR true->false)
\`\`\`

4. Report the transition window and show it:

\`\`\`bash
overcast note "<predicate> flips" --ref REC --at <lo-hi> --confidence high --json
overcast view REC --at <lo-hi> --json
overcast brief --export ./transition.md --json
\`\`\`

## Output

The converged `[lo, hi]` bracket — the two adjacent `see` frames that straddle
the flip (their `record.id`s + `media.at`) — and the call count. That bracket IS
the answer window — don't over-claim a single frame.

## Caveats

Bisection is only valid for a one-way change; a light that blinks or a person who
comes and goes will mislead it — verify monotonicity at step 2, and fall back to
`overcast-pinpoint` (peak search) or `overcast-presence-window` for recurring or
interval events. Needs the video local.
