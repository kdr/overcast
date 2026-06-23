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
overcast ask "every white van, with timestamps" --json
overcast brief --export ./brief.html
\`\`\`

\`overcast commands --json\` dumps the authoritative verb registry. Full man
pages are in [reference/verbs.md](reference/verbs.md) (progressive disclosure —
read it when you need a verb's exact flags).

## Setup

\`overcast doctor\` checks readiness (pi, vendored ffmpeg, Cloudglue creds, the
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
  vendored ffmpeg, and configure the Cloudglue key for the default perception
  backend. Use once before driving the \`overcast\` skill.
---

# overcast-init

One-time setup for overcast.

1. **Install the CLI** — \`pi install npm:@overcast/cli\` (inside pi) or
   \`npm i -g @overcast/cli\` for the standalone binary.
2. **Verify** — \`overcast doctor --json\` (pi pinned, ffmpeg/ffprobe runnable,
   Cloudglue key, tinycloud CLI).
3. **Cloudglue key** — the default \`watch\`/\`listen\` providers reach Cloudglue
   via the tinycloud CLI; configure it (\`tinycloud setup cloudglue\`) or export
   \`CLOUDGLUE_API_KEY\`.

Then use the \`overcast\` skill to drive the verbs.
`;
}
