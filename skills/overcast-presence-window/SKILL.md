---
name: overcast-presence-window
description: >-
  Find the interval a person or object is present — anchor one appearance, then
  sweep outward with face-match / detect until it drops off both sides.
---

# overcast-presence-window

Use this skill to answer "from when to when is <target> on screen?" — a first/last
appearance interval, not a single instant. It anchors one confirmed appearance and
expands until the target stops appearing, the presence-tracking analog of a
temporal search. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags.

## Workflow

1. Local clip + record id:

\`\`\`bash
overcast doctor --json
overcast case init --json
overcast watch ./clip.mp4 --json        # -> record id REC
\`\`\`

2. Anchor one appearance (whichever fits the target):

\`\`\`bash
overcast face ./clip.mp4 --match ./person.jpg --json          # a specific person (similarity 0-100)
overcast grid ./clip.mp4 --count 16 --json                    # then see the montage for an object
\`\`\`

3. Sweep outward from the anchor until K consecutive misses on each side:

\`\`\`bash
# person: widen the window; --fps controls sample density (precision vs cost)
overcast face ./clip.mp4 --match ./person.jpg --start <a> --end <b> --fps 1 --min-similarity 55 --json
# object: step frames outward and check presence
overcast see frame://REC@<t> --prompt "Is <target> present? answer only yes or no" --json
\`\`\`

4. Emit the presence interval(s) and show them:

\`\`\`bash
overcast note "<target> present" --ref REC --at <first-last> --confidence medium --json
overcast view REC --at <first-last> --json
overcast brief --export ./presence.md --json
\`\`\`

## Output

One or more `[first-last]` intervals with the per-hit citations (`record.id` +
`media.at`) that bound them, and the sample density used. If the target leaves
and returns, report each interval separately rather than one span covering the
gap.

## Caveats

Sampled detections are per-frame, not continuous — presence between samples is
inferred; raise `--fps` to tighten boundaries at higher cost. Occlusion or an
off-camera moment splits one presence into several intervals — that's a real
result, not noise. Face similarity is 0-100. Needs the video local.
