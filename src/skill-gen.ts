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
overcast note "rear plate is missing" --ref <record-id> --at 12-18 --json
overcast face ./clip.mp4 --thumbnails --json  # detect faces (boxes + provider frame thumbnails)
overcast face ./clip.mp4 --match ./suspect.jpg --json   # find this person in the video (JPEG/PNG query image)
overcast crop <face-or-see-record-id> --all --class face --json  # materialize detection crops as evidence
overcast ask "every white van, with timestamps" --json
overcast case memory index status --json  # inspect default local-grep case search
overcast brief --export ./brief.html
\`\`\`

Built-in source refs for \`source add <type>:<ref>\`:

- \`youtube:@handle\` — enumerate a channel's videos.
- \`youtube:search:<query>\` or \`youtube:<keyword>\` — YouTube keyword search.
- \`youtube:playlist:<id>\` or \`youtube:<full YouTube URL>\` — enumerate a playlist/video URL.
- \`tiktok:@user\` — enumerate a TikTok profile.
- \`tiktok:#tag\` — enumerate a TikTok hashtag.
- \`web:<query>\` — web search through Tavily, falling back to Brave when Tavily is unset.

\`overcast commands --json\` dumps the authoritative verb registry. Full man
pages are in [reference/verbs.md](reference/verbs.md) (progressive disclosure —
read it when you need a verb's exact flags).

### Case search (default ask)

\`overcast ask "question"\` is the zero-config way to search the whole case:
notes, sensed media records, scan/capture artifacts, and other primary evidence
records. Operational/read records (\`setup\`, \`doctor\`, \`index\`, \`target\`,
\`source\`, \`prebrief\`, \`ask\`, \`case\`, etc.) are excluded from case memory and briefs so setup probes,
remote-index bookkeeping, and prior answers are not cited as evidence.
It uses the always-on \`local-grep\` backend over verb-specific indexable fields
(\`note.text\`, \`watch.content\`, \`listen.transcript\`, scan titles/snippets, …)
and returns cited \`record.id\` + \`media.at\` evidence. Use:

\`\`\`bash
overcast case memory list --json
overcast case memory index status --json
overcast ask "where did we see the white van?" --json
\`\`\`

For optional local semantic case search, bind qmd (default embedding model:
\`embeddinggemma-300M-Q8_0\`):

\`\`\`bash
npm install -g @tobilu/qmd
overcast setup memory qmd
overcast case memory index rebuild --memory qmd --json
overcast ask "where did we see the white van?" --deep --json
overcast ask "where did we see the white van?" --memory qmd --json
\`\`\`

qmd is lifecycle-managed: rebuild/start/retry refresh the materialized index,
plain \`ask\` stays on local-grep, and \`ask --deep\` selects configured
semantic providers such as qmd. The first qmd rebuild downloads/caches
\`embeddinggemma-300M-Q8_0\`; rebuilds replace the named qmd collection before
re-adding docs, so rerunning after new notes/watch records is safe.
\`face\` records contribute compact summary/moment fields to memory, not raw
box/thumbnail blobs. \`see\` detection records likewise index counts/categories
instead of the full detection array. Use \`crop <record-id> --all\` to turn
face/object detections into local cropped image evidence records; crop records
are fully memory-eligible and preserve source record, source media, crop source
media, timestamp, class/id, confidence, and box provenance. Use
\`face --thumbnails\` before \`crop\` when you want provider frame images
preserved for crop extraction.
\`overcast doctor\` reports qmd when installed or configured.

### Faces & indexes (register a target's videos, then ask / find a person)

An **index** is a tinycloud-backed searchable corpus of videos, searched one way
per TYPE — build one from the videos you gather for a target, then query it:

\`\`\`bash
# 1) index the target's videos (media-descriptions = ask/probe; face = find a person)
overcast index create case-media --type media-descriptions --json
overcast index attach existing-remote-index --json        # bind a remote tinycloud index to this case
overcast scan --pull --json                       # pull the target's videos into the case
overcast index add --all --to <index-id> --json   # register every captured/sensed video
overcast index add ./local.mp4 --to <index-id> --json # also creates missing watch evidence for local memory

# 2a) media-descriptions → ask / probe across ALL indexed videos
overcast ask "what objections came up?" --index <index-id> --json
overcast ask "moments a contract is signed" --index <index-id> --probe --json

# 2b) face-analysis → find a specific person across the index
overcast index create faces --type face --json
overcast index attach existing-face-index --type face --json
overcast index add --all --to <face-index-id> --json
overcast face --match ./suspect.jpg --index <face-index-id> --json
overcast face ./clip.mp4 --thumbnails --json
overcast crop <face-record-id> --all --class face --out ./.overcast/media/crops --json

# 2c) entities → same-schema extraction per video
overcast index create people --type entities --prompt "people, orgs, locations" --json
overcast index entities <entity-index-id> ./clip.mp4 --json
\`\`\`

\`face\` needs tinycloud ≥ 0.3.4 (\`overcast doctor\` flags an older install);
overcast currently recommends tinycloud 0.3.6 for the latest face validation and
CLI reliability behavior. Face detection counts are boxes per sampled frame, not
unique people; use \`--match <photo>\` for a specific person and \`crop\` when
you need durable cropped image evidence. If a local video lacks descriptive
content evidence, add it to the index with \`overcast index add ./clip.mp4 --to
<id>\`; overcast will create the missing \`watch\` record for local case memory.

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
   \`tinycloud update\`). The \`face\` + \`index\` verbs need **tinycloud ≥ 0.3.4**,
   and overcast currently recommends **0.3.6**;
   override the invocation with \`OVERCAST_TINYCLOUD_CMD\` if it isn't on \`PATH\`.
3. **Verify** — \`overcast doctor --json\` (pi pinned, ffmpeg/ffprobe runnable,
   Cloudglue key, tinycloud CLI + version).
4. **Cloudglue key** — the default \`watch\`/\`listen\`/\`face\`/\`index\` providers
   reach Cloudglue via the tinycloud CLI; configure it (\`tinycloud setup cloudglue\`)
   or export \`CLOUDGLUE_API_KEY\`.

Then use the \`overcast\` skill to drive the verbs.
`;
}
