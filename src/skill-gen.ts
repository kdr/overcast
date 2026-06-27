// Generate the flagship `overcast` skill's reference/verbs.md from the verb
// registry (CLAUDE.md invariant #5: one verb spec → three surfaces; the skill
// reference is the third). `overcast commands --json` is the source of truth —
// this renders the same registry into progressive-disclosure man pages.

import { VERBS } from "./registry/verbs.js";
import { renderVerbHelp } from "./registry/to-cli.js";
import type { VerbSpec } from "./registry/types.js";

const GROUP_TITLES: Record<VerbSpec["group"], string> = {
  sense: "Senses",
  inspect: "Inspect",
  osint: "OSINT",
  read: "Read",
  state: "State",
  config: "Config",
};

/** Render the full reference/verbs.md for the flagship skill. */
export function generateVerbReference(): string {
  const lines: string[] = [];
  lines.push("# overcast — verb reference");
  lines.push("");
  lines.push(
    "Generated from the verb registry (`overcast commands --json`). Drive any verb",
    "from a shell via `overcast <verb> [args] --json` and parse the emitted record.",
    "Every verb emits one or more loose records persisted to the case's `.overcast/`",
    "store; cite findings by `record.id` + `media.at`.",
    "",
  );

  // group the verbs
  const groups = new Map<VerbSpec["group"], VerbSpec[]>();
  for (const v of VERBS) {
    const arr = groups.get(v.group) ?? [];
    arr.push(v);
    groups.set(v.group, arr);
  }

  for (const [group, title] of Object.entries(GROUP_TITLES) as [VerbSpec["group"], string][]) {
    const verbs = groups.get(group);
    if (!verbs || verbs.length === 0) continue;
    lines.push(`## ${title}`, "");
    for (const v of verbs) {
      lines.push(`### \`overcast ${v.name}\``, "");
      lines.push(v.description ?? v.summary, "");
      lines.push("```");
      lines.push(renderVerbHelp(v).trimEnd());
      lines.push("```", "");
      lines.push(`Emits \`${v.outputKind}\` records.`, "");
    }
  }
  return lines.join("\n");
}

/** The flagship SKILL.md front-matter + body. */
export function generateFlagshipSkill(): string {
  const verbList = VERBS.map((v) => `- \`${v.name}\` — ${v.summary}`).join("\n");
  return `---
name: overcast
description: >-
  Give any agent senses (video/audio/image understanding) and OSINT reach
  (search/capture/monitor) organized around an investigation case. Use when the
  user wants to analyze a video/audio/image, scan or monitor sources for a
  target, or ask/brief over accumulated findings. Drives the \`overcast\` CLI
  (built on pi + the tinycloud/Cloudglue perception backend); see
  reference/verbs.md for the full verb surface.
---

# overcast

overcast turns a vanilla agent into a video-understanding OSINT investigator.
A **case** is just the current directory (its \`.overcast/\` store holds the
records). Every verb emits a loose, indexable **record**; cite findings by
\`record.id\` + \`media.at\`.

## Verbs

${verbList}

## How to drive it

Run any verb from bash and parse the JSON record:

\`\`\`bash
overcast watch ./clip.mp4 --json          # video.analysis record
overcast scan --pull --json               # enumerate sources, capture + sense
overcast face ./clip.mp4 --json           # detect faces (boxes + timestamps)
overcast face ./clip.mp4 --match ./suspect.jpg --json   # find this person in the video (JPEG/PNG query image)
overcast ask "every white van, with timestamps" --json
overcast brief --export ./brief.html
\`\`\`

\`overcast commands --json\` dumps the authoritative verb registry. Full man
pages are in [reference/verbs.md](reference/verbs.md) (progressive disclosure —
read it when you need a verb's exact flags).

### Faces & collections (register a target's videos, then ask / find a person)

A **collection** is a tinycloud (Cloudglue) index of videos, searchable one way
per TYPE — build one from the videos you gather for a target, then query it:

\`\`\`bash
# 1) index the target's videos (media-descriptions = ask/probe; face = find a person)
overcast collection create case-media --type media-descriptions --json
overcast scan --pull --json                       # pull the target's videos into the case
overcast collection add --all --to <col-id> --json   # register every captured/sensed video

# 2a) media-descriptions → ask / probe across ALL indexed videos
overcast ask "what objections came up?" --collection <col-id> --json
overcast ask "moments a contract is signed" --collection <col-id> --probe --json

# 2b) face-analysis → find a specific person across the index
overcast collection create faces --type face --json
overcast collection add --all --to <face-col-id> --json
overcast face --match ./suspect.jpg --collection <face-col-id> --json

# 2c) entities → same-schema extraction per video
overcast collection create people --type entities --prompt "people, orgs, locations" --json
overcast collection entities <ent-col-id> ./clip.mp4 --json
\`\`\`

\`face\` needs tinycloud ≥ 0.3.4 (\`overcast doctor\` flags an older install);
overcast currently recommends tinycloud 0.3.6 for the latest face validation and
CLI reliability behavior.

### Reading large records

A verb's JSON record can carry a large field (a \`watch\` \`content\` timeline, a
long \`listen\` transcript). Don't reconstruct it by \`head\`/\`tail\`-ing the raw
\`.overcast/records/*.jsonl\` — that truncates and silently drops the middle.
Page it deterministically instead:

\`\`\`bash
overcast case memory get <record-id>                              # manifest: field names + sizes (chars)
overcast case memory get <record-id> --field content --offset 0 --limit 16000 --json
# repeat with the returned next_offset until has_more is false; offsets are in chars
\`\`\`

## Setup

\`overcast doctor\` checks readiness (pi, system ffmpeg, Cloudglue creds, the
tinycloud CLI). \`overcast setup provider <verb> <spec>\` rebinds a verb to your
own provider with no code changes.
`;
}

/** The thin overcast-init SKILL.md (onboarding only). */
export function generateInitSkill(): string {
  return `---
name: overcast-init
description: >-
  Install and configure overcast for this harness: install the CLI, verify the
  system ffmpeg, and configure the Cloudglue key for the default perception
  backend. Use once before driving the \`overcast\` skill.
---

# overcast-init

One-time setup for overcast.

1. **Install the CLI** — \`pi install npm:@kdrrr/overcast\` (inside pi) or
   \`npm i -g @kdrrr/overcast\` for the standalone binary.
2. **Install/update tinycloud** — the default perception backend. Get the latest
   (\`npm i -g @cloudglue/tinycloud@0.3.6\` then \`tinycloud install --latest\`, or
   \`tinycloud update\`). The \`face\` + \`collection\` verbs need **tinycloud ≥ 0.3.4**,
   and overcast currently recommends **0.3.6**;
   override the invocation with \`OVERCAST_TINYCLOUD_CMD\` if it isn't on \`PATH\`.
3. **Verify** — \`overcast doctor --json\` (pi pinned, ffmpeg/ffprobe runnable,
   Cloudglue key, tinycloud CLI + version).
4. **Cloudglue key** — the default \`watch\`/\`listen\`/\`face\`/\`collection\` providers
   reach Cloudglue via the tinycloud CLI; configure it (\`tinycloud setup cloudglue\`)
   or export \`CLOUDGLUE_API_KEY\`.

Then use the \`overcast\` skill to drive the verbs.
`;
}
