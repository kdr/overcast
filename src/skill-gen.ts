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
overcast finding list --json              # review automated target matches
overcast note "rear plate is missing" --ref <record-id> --at 12-18 --json
overcast face ./clip.mp4 --thumbnails --json  # detect faces (boxes + provider frame thumbnails)
overcast face ./clip.mp4 --match ./suspect.jpg --json   # find this person in the video (JPEG/PNG query image)
overcast crop <face-or-see-record-id> --all --class face --json  # materialize detection crops as evidence
overcast ask "every white van, with timestamps" --json
overcast case memory index status --json  # inspect default local-grep case search
overcast brief --export ./brief.html      # evidence-only narrative report
overcast case status --export ./status.html --theme csi   # current case dashboard
overcast case records --export ./records.html --theme csi # full audit log
\`\`\`

Built-in source refs for \`source add <type>:<ref>\`:

- \`youtube:@handle\` — enumerate a channel's videos.
- \`youtube:search:<query>\` or \`youtube:<keyword>\` — YouTube keyword search.
- \`youtube:playlist:<id>\` or \`youtube:<full YouTube URL>\` — enumerate a playlist/video URL.
- \`tiktok:@user\` — enumerate a TikTok profile.
- \`tiktok:#tag\` — enumerate a TikTok hashtag.
- \`x:@handle\` — enumerate an X (Twitter) profile's posts.
- \`x:<query>\` or \`x:#tag\` — X advanced search (\`from:\`, \`filter:native_video\`, \`min_faves:\`, …).
- \`x:video:<query>\` / \`x:image:<query>\` — only X posts with native video / images (media targeting).
- \`web:<query>\` — web search through Tavily, falling back to Brave when Tavily is unset.
- \`lens:<image url or local path>\` — Google Lens reverse image search (Apify): exact + visual page matches for an image.

\`overcast commands --json\` dumps the authoritative verb registry. Full man
pages are in [reference/verbs.md](reference/verbs.md) (progressive disclosure —
read it when you need a verb's exact flags).

### Brief vs status vs records

Use \`brief\` for the evidence narrative: it reports over the same evidence-only
boundary as case memory, so setup/read/meta records are excluded.

Use \`case status\` for the current dashboard: setup health, targets, sources,
indexes, memory/index state, record/store counts, artifacts, and match
visualizations when available. Treat it as situational context, not evidence for
later memory or briefs.

Use \`case records\` for the audit trail: it includes the append-only operational
history, including setup, target/source changes, index work, asks, briefs, and
status checks.

Direct CLI HTML exports default to \`plain\` for compatibility. In the
interactive/headless agent tool surface, \`.html\` exports default to the
\`csi\` visualization theme when the verb supports themes, unless the tool call
explicitly passes \`theme: "plain"\`.

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
overcast currently recommends tinycloud 0.3.7 for the latest face validation,
CLI reliability, and image \`see\`/\`extract\` behavior. Face detection counts are boxes per sampled frame, not
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

For reusable provider setup, prefer the catalog-backed profile workflow:

\`\`\`bash
overcast provider setup show --profile default --json
overcast provider setup plan --preset cloudglue --profile default --json
overcast provider setup apply --preset cloudglue --profile default --yes --json
overcast provider setup apply --verb listen --choice elevenlabs --profile recon --yes --json
overcast provider setup apply --verb face --choice deepface-local --profile local --yes --json
overcast provider init listen --profile recon --json
overcast doctor --profile recon --json
\`\`\`

Catalog presets include \`cloudglue\`, \`hf\`, \`fal\`, \`elevenlabs\`,
\`owl-local\`, and \`deepface-local\`. \`face:deepface-local\` selects local DeepFace for
plain \`face <video>\` detection and \`face <video> --match <image>\` matching;
\`deepface-local\` remains the case-owned local face DB/index type for searchable
reference sets.

Provider setup is profile/global state and can span many cases. Case setup is
per-investigation state: target, sources/media, memory/indexes, and automation
policy.

\`\`\`bash
overcast case setup edit \\
  --provider "listen:elevenlabs,see:owl-local" \\
  --provider-indexable "listen,see" \\
  --auto-sense "watch,listen" \\
  --auto-index-new \\
  --findings review \\
  --yes --json
\`\`\`

Use \`overcast case setup edit --no-auto-index-new --yes --json\` to disable
automatic indexing later without removing the selected providers or auto-sense
chain.
`;
}

/** The thin overcast-init SKILL.md (onboarding only). */
export function generateInitSkill(): string {
  return `---
name: overcast-init
description: >-
  Install and configure overcast for this harness: install the CLI, verify the
  system ffmpeg, and configure reusable provider profiles. Use once per
  machine/profile before driving the \`overcast\` skill.
---

# overcast-init

One-time setup for overcast.

1. **Install the CLI** — \`pi install npm:@kdrrr/overcast\` (inside pi) or
   \`npm i -g @kdrrr/overcast\` for the standalone binary.
2. **Install/update tinycloud** — the default perception backend. Get the latest
   (\`npm i -g @cloudglue/tinycloud@0.3.7\` then \`tinycloud install --latest\`, or
   \`tinycloud update\`). The \`face\` + \`index\` verbs need **tinycloud ≥ 0.3.4**,
   and overcast currently recommends **0.3.7** (adds the image \`see\`/\`extract\`
   verbs behind the opt-in \`see:tinycloud\` provider);
   override the invocation with \`OVERCAST_TINYCLOUD_CMD\` if it isn't on \`PATH\`.
3. **Verify** — \`overcast doctor --json\` (pi pinned, ffmpeg/ffprobe runnable,
   Cloudglue key, tinycloud CLI + version, optional uv/visual-db readiness).
4. **Cloudglue key** — the default \`watch\`/\`listen\`/\`face\`/\`index\` providers
   reach Cloudglue via the tinycloud CLI; configure it (\`tinycloud setup cloudglue\`)
   or export \`CLOUDGLUE_API_KEY\`.
5. **Provider profile setup** — choose reusable providers once per profile, not
   once per case. Always preview before applying:
   \`\`\`bash
   overcast provider setup show --profile default --json
   overcast provider setup plan --preset cloudglue --profile default --json
   overcast provider setup apply --preset cloudglue --profile default --yes --json
   overcast doctor --profile default --json
   \`\`\`
   Optional presets/choices:
   - \`cloudglue\` for tinycloud watch/listen/face plus built-in ffmpeg enhance.
   - \`fal\` for \`see\`/\`enhance\` with \`FAL_KEY\`.
   - \`hf\` for \`see\`/\`enhance\` with \`HF_TOKEN\`.
   - \`elevenlabs\` for \`listen\`/\`enhance\` with \`ELEVENLABS_API_KEY\`.
   - \`owl-local\` for OWLv2 open-vocabulary object detection.
   - \`see:tinycloud\` (choice, \`--verb see --choice tinycloud\`) for Cloudglue
     file-level image analysis via \`tinycloud see\`/\`extract\` (needs tinycloud
     ≥ 0.3.7; \`--detect\` facts are boxless — no \`crop\`).
   - \`deepface-local\` for local face detect/match through DeepFace.
6. **Optional visual DB setup** — prepare visual DB Python once per
   checkout/machine. DeepFace can be selected as a profile provider for the
   \`face\` verb, while image/face DBs are still case-owned local indexes:
   \`\`\`bash
   scripts/visual-db-uv.sh --face
   overcast doctor --json
   overcast provider setup apply --verb face --choice deepface-local --profile default --yes --json
   overcast index create logos --type image-ransac --local --json
   overcast index create localfaces --type deepface-local --local --json
   \`\`\`
7. **Case setup later** — use the main \`overcast\` skill per investigation to run
   \`case setup\`, select targets/sources/indexes, and optionally set case-level
   automation such as \`--auto-sense\`, \`--auto-index-new\`, and \`--findings review\`.

Then use the \`overcast\` skill to drive the verbs.
`;
}

/** Guide for creating focused Overcast-powered workflow skills. */
export function generateSkillCreatorSkill(): string {
  return `---
name: overcast-skill-creator
description: >-
  Create small, installable agent skills that wrap focused Overcast workflows.
  Use when the user asks to make an Overcast skill for a specific investigation,
  media analysis, recon, monitoring, or case-memory workflow.
---

# overcast-skill-creator

Use this when the user wants a focused skill built on Overcast instead of the
broad \`overcast\` skill. Example requests: "make an Overcast skill for analyzing
security camera clips", "create a skill that monitors a target and briefs me",
or "turn this Overcast workflow into an installable agent skill".

Reference the broad \`overcast\` skill and its
\`overcast/reference/verbs.md\` man pages for exact flags. Do not duplicate the
full verb reference.

## Design Rules

1. Pick one case lifecycle: initialize/setup, gather or sense evidence, add
   notes/findings, ask/brief, then export.
2. Choose the minimum verbs needed. Prefer \`case setup\`, \`watch\`,
   \`listen\`, \`see\`, \`face\`, \`scan\`, \`capture\`, \`monitor\`, \`note\`,
   \`finding\`, \`ask\`, and \`brief\` only when they serve the workflow.
3. Preserve citations. Evidence claims should cite \`record.id\` plus
   \`media.at\` when a timestamp or range exists.
4. Prefer \`ask\` and \`brief\` over raw JSON spelunking for synthesis. Use raw
   records for verification and exact fields, not as the default reading path.
5. For large \`watch\` content or \`listen\` transcripts, use
   \`case memory get <record-id> --field <field> --offset <n> --limit <n>\`
   rather than head/tail reads of JSONL.
6. State setup assumptions: \`overcast doctor\`, provider credentials, system
   \`ffmpeg\`/\`ffprobe\`, tinycloud version, and whether the workflow needs live
   sources or only local files.

## Template

\`\`\`\`markdown
---
name: overcast-<workflow-name>
description: >-
  <One sentence about when an agent should use this focused Overcast workflow.>
---

# overcast-<workflow-name>

Use this skill when <trigger conditions>.

## Quickstart

\`\`\`bash
overcast doctor --json
overcast case init --json
overcast case setup --target "<target>" --yes --json
overcast <gather-or-sense-verb> <input> --json
overcast ask "<question>" --json
overcast brief --export ./brief.md --json
\`\`\`

## Evidence Rules

- Cite \`record.id\` and \`media.at\` for every media-derived claim.
- Record human observations with \`note --ref <record-id> --at <time-range>\`.
- Separate observed facts, inferred expected behavior, and open questions.

## Failure Handling

- Run \`overcast doctor --json\` when a provider or system dependency fails.
- If a record field is large, page it with \`case memory get\`.
- If a source is unavailable, report the missing source and continue with local
  case evidence.

## Validation

\`\`\`bash
overcast commands --json
overcast <main-verb> --help
overcast ask "<workflow-specific verification question>" --json
\`\`\`
\`\`\`\`
`;
}

/** Example skill: turn media evidence into coding-agent bug reports. */
export function generateMediaBugTriageSkill(): string {
  return `---
name: overcast-media-bug-triage
description: >-
  Analyze screen recordings, product demos, customer support videos, and audio
  notes into actionable, cited bug reports for coding agents.
---

# overcast-media-bug-triage

Use this skill when media evidence should become a bug report, reproduction
steps, or engineering triage notes. Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact command flags.

## Workflow

\`\`\`bash
overcast doctor --json
overcast case init --json
overcast case setup --yes --json
overcast watch ./screen-recording.mp4 --json
overcast listen ./screen-recording.mp4 --describe --json
overcast see frame://<record-id>@<seconds> --ocr --json
overcast note "observed UI state or suspected failure" --ref <record-id> --at <time-range> --json
overcast ask "summarize the bug with reproduction steps and citations" --json
overcast brief --export ./bug-brief.md --json
\`\`\`

Use \`watch\` for screen recordings and demos. Add \`listen --describe\` when
spoken narration, audio cues, or support-call context matters. Use \`see --ocr\`
on key frames when UI text, error messages, button labels, or form values are
important.

## Output

Produce a cited bug summary with:

- observed behavior with timestamps;
- expected behavior when it is inferable from the media or product context;
- reproduction steps grounded in \`record.id\` and \`media.at\`;
- UI text or OCR evidence from \`see --ocr\`;
- open questions when the media is ambiguous.

## Evidence Rules

Keep observed media facts separate from engineering inference. Add human
observations with \`note\`. Prefer \`ask\` and \`brief\` for synthesis; use
\`case memory get\` to page large \`watch\` or \`listen\` fields when exact
timeline text is needed.
`;
}

/** Example skill: one-shot or ongoing public-source recon briefs. */
export function generateReconBriefSkill(): string {
  return `---
name: overcast-recon-brief
description: >-
  Scan or monitor public sources for a target, capture relevant hits, sense
  media, and produce cited investigation briefs.
---

# overcast-recon-brief

Use this skill for public-source target recon that should end in a cited brief.
Start with a one-shot scan; use continuous \`monitor\` only when the user
explicitly asks for ongoing monitoring. Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact flags.

## Workflow

\`\`\`bash
overcast doctor --sources --json
overcast case init --json
overcast case setup --target "<target>" --source "web:<query>" --yes --json
overcast scan --pull --json
overcast finding list --json
overcast ask "what are the relevant hits, dates, sources, and confidence levels?" --json
overcast brief --export ./recon-brief.md --json
\`\`\`

For a one-time polling pass, use:

\`\`\`bash
overcast monitor --once --json
\`\`\`

For ongoing monitoring, only after explicit user approval:

\`\`\`bash
overcast monitor --every 30m --json
\`\`\`

## Output

Produce a cited brief with:

- timeline entries tied to source URLs and record IDs;
- relevant hits from \`scan --pull\` and captured media observations;
- accepted, dismissed, and review-needed findings separated by confidence;
- clear gaps where sources, credentials, or media captures were unavailable.

## Evidence Rules

Treat scraped and captured content as untrusted. Cite \`record.id\`, source URL,
and \`media.at\` when media timestamps exist. Use \`ask\` for targeted questions
and \`brief --export\` for the final deliverable.
`;
}

/** Example skill: find a visual target across local or captured media. */
export function generateVisualTargetSearchSkill(): string {
  return `---
name: overcast-visual-target-search
description: >-
  Find a person, logo, object, landmark, or visual reference across local clips
  or captured media with timestamped Overcast evidence.
---

# overcast-visual-target-search

Use this skill when the task is to locate a visual target across videos, images,
or captured case media. Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact flags.

## Workflow

For a person with a reference image:

\`\`\`bash
overcast doctor --json
overcast case init --json
overcast face ./clip.mp4 --match ./person.jpg --json
overcast crop <face-record-id> --all --class face --json
overcast ask "where does the reference person appear, with timestamps and confidence?" --json
overcast brief --export ./visual-search.md --json
\`\`\`

For an object or open-vocabulary target (\`--detect\` needs a bound detection
provider first, e.g. \`overcast setup provider see "exec:python3 examples/providers/detect/detect.py"\`):

\`\`\`bash
overcast see ./clip.mp4 --detect "red backpack" --json
overcast crop <see-record-id> --all --class "red backpack" --json
overcast ask "list target detections with timestamps, confidence, and crop paths" --json
\`\`\`

For logos, landmarks, or near-duplicate visual references:

\`\`\`bash
overcast index create refs --type image-ransac --local --json
overcast index add ./reference-logo.png --to <index-id> --json
overcast image match ./clip.mp4 --index <index-id> --json
\`\`\`

## Output

Return timestamped matches, similarity or confidence where available, source
\`record.id\`, \`media.at\`, and cropped evidence paths created by \`crop\`.
State whether the match came from \`face --match\`, \`see --detect\`, or local
\`image-ransac\` matching.

## Caveats

Face detections are sampled-frame detections, not unique-person counts. Use
\`face --match <image>\` for a specific person and include confidence caveats.
For exact evidence, use \`crop\` to materialize local image records, then
synthesize with \`ask\` and \`brief\`.
`;
}

export function generateCopycatSweepSkill(): string {
  return `---
name: overcast-copycat-sweep
description: >-
  Hunt re-uploads and reskins of original video content across X / YouTube /
  TikTok — escalate from cheap metadata triage to frame/face/transcript
  matching and produce citable copycat findings.
---

# overcast-copycat-sweep

Use this skill when the task is to find copies, re-uploads, or reskins of a
creator's original media (video theft / freebooting) and build an evidence-backed
report. Use the broad \`overcast\` skill and \`overcast/reference/verbs.md\` for
exact flags. Escalate tier by tier — never capture what metadata already rules
out.

## Workflow

1. Fingerprint the original (once per case). Reskins defeat exact hashes, so
   fingerprint three ways — distinctive frames, the creator's face, and the
   transcript:

\`\`\`bash
overcast doctor --sources --json
overcast case init --json
overcast case setup --name copycat-sweep --target "<creator / original title>" --source "x:video:<topic keywords>" --yes --no-index --json
overcast watch ./original.mp4 --json      # content + transcript into case memory
overcast index create originals --type image-ransac --local --json
overcast image add ./title-card.png --index <index-id> --json   # + diagrams, key frames
\`\`\`

2. Sweep sources for candidates published AFTER the original — media-targeted
   (\`x:video:\`) queries with topic keywords, not exact titles:

\`\`\`bash
overcast source add 'youtube:search:<topic keywords>' --json
overcast scan --since <original-publish-date> --limit 20 --json
\`\`\`

3. Triage on scan metadata alone (no downloads): keep hits whose \`published\`
   postdates the original, whose \`duration\` is close to it, or whose
   \`title\`/\`snippet\` echoes it; carry \`author\` and \`views\` into the report.

4. Escalate survivors — capture, then match every fingerprint layer:

\`\`\`bash
overcast capture <scan-hit-id> --json
overcast image match <captured-file> --index <index-id> --draw --json   # frames survive reskins/subtitles; --draw writes match-overlay proof
overcast face <captured-file> --match ./creator.jpg --json   # the face survives re-branding
overcast listen <captured-file> --json                       # verbatim transcript = strongest signal
overcast ask "does this captured video repeat the original's content? cite moments" --json
\`\`\`

Pass \`--draw\` on \`image match\` so each matched frame writes a RANSAC overlay
(original ↔ suspect keypoints). Cite the \`image\` match record as the finding's
\`--ref\` in step 5 — the brief embeds that overlay in the finding card as
visual proof.

**Local mode (no external source).** The skill works entirely on local files:
skip steps 2–3 and run \`image match\` / \`face --match\` / \`listen\` directly on
candidate videos already on disk (or captured earlier). This is how you compare a
suspected rip you already have against the original, and how the pipeline is
tested offline (fingerprint an original, confirm a reskinned copy, reject an
unrelated clip) — no scan, no API. \`scan --local\` also sweeps the case's own
media/indexes when no source is enabled.

5. Record verdicts and report; keep a standing watch. One \`finding\` per
   confirmed copycat stating the because-clause (which layers matched, with
   scores), and ALWAYS one narrative note tagged \`tldr\` — even when the sweep
   comes up clean ("checked N sources, M candidates triaged, no copycats
   found") — because the brief's TL;DR / sources-checked / matches header is
   derived from exactly these records:

\`\`\`bash
overcast finding create "copycat: <original> re-uploaded by @<author> (<views> views) — image frames 3x (best 94 inliers), face 87/100" --ref <image-match-record-id> --confidence high --json
overcast note "checked x + youtube (<n> hits); <m> candidates escalated; <k> confirmed: @<author> ..." --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./copycats.html --json
overcast monitor --every 1d --json
\`\`\`

Point the finding's \`--ref\` at the \`image match\` record (not the raw scan
hit) so its match-draw overlay rides into the finding card as visual proof.

## Output

For each confirmed copycat return: post URL, \`author\`, \`views\`, \`published\`,
which layers matched (image frames / face / transcript), the strongest
\`record.id\` + \`media.at\` citations, and the exported brief path. The exported
brief opens with the TL;DR narrative (from the \`tldr\`-tagged note), the
sources-checked rollup, and the matches & findings verdicts; a clean sweep
must still say so explicitly ("checked, found none").

## Caveats

Copycats retitle and re-caption, so search topic keywords and confirm with the
visual/transcript layers: burned-in subtitles and translated dubs defeat text
matching but not \`image\` frame matching or \`face --match\`. Face similarity is
0–100 (percent), not 0–1; \`image match\` reports a RANSAC inlier count (unbounded
integer) plus an inlier ratio (0–1) — there is no 0–100 image similarity. A
repost/quote is a share, not a rip —
confirm the account re-uploaded the media natively (check \`x:video:from:<handle>\`).
Apify-backed sources bill per result — prefer few, broad queries over many
narrow ones.

Keyword overlap is NOT a match: accounts pump many videos that share your topic
words, so text triage only shortlists — the frame/face/transcript layers decide.
Do not trust an \`image match\` inlier count alone; a high count on a degenerate
homography is the main false positive. \`image match\` gates on planar-projection
validity by default (\`--draw\` writes the overlay so you can eyeball coherent
correspondences vs lines collapsing to a point). Call a video a confirmed rip
only when the gated match survives AND the transcript/face agree.
`;
}

/** Crime-lab skill: build a local face lineup DB and identify probes against it. */
export function generateLineupSkill(): string {
  return `---
name: overcast-lineup
description: >-
  Build a persistent local face database out of case media — the mugshot book —
  then run a suspect photo through it to identify who they are and where else
  they appear, with cited similarity scores.
---

# overcast-lineup

Use this skill when the task is "run this person through the database": accumulate
every face across the case's clips and images into a local, browsable lineup, then
identify a probe photo against it. Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact flags. The whole DB is local — no media
leaves the case.

## Prerequisites

The lineup is deepface-only (clustering needs face embeddings the tinycloud face
path doesn't expose). Prepare the local visual-DB Python once, bind DeepFace, and
stand up a \`face-cluster\` index:

\`\`\`bash
overcast doctor --json                 # confirm uv + visual-db are ready
scripts/visual-db-uv.sh --face         # install OpenCV/DeepFace (once per machine)
overcast provider setup apply --verb face --choice deepface-local --profile default --yes --json
overcast case init --json
overcast index create people --type face-cluster --local --json
\`\`\`

## Workflow

1. Book every case video/image into the lineup — \`cluster add\` detects, embeds,
   and assign-or-creates each face into a person (nearest existing person above
   \`--min-similarity\`, else a new one):

\`\`\`bash
overcast cluster add ./interview.mp4 --index <index-id> --json
overcast cluster add ./cctv-lobby.mp4 --index <index-id> --json
overcast cluster add ./mugshot.jpg --index <index-id> --json
\`\`\`

2. Open the lineup — a self-contained HTML contact sheet, one row per person:

\`\`\`bash
overcast cluster view --index <index-id> --json     # add --no-open to only write the gallery
overcast cluster list --index <index-id> --json      # people + member counts
\`\`\`

3. Run a suspect photo through the database. \`cluster identify\` reports the most
   similar person (similarity 0–100) or flags the probe as a likely NEW person,
   and never writes to the DB:

\`\`\`bash
overcast cluster identify ./suspect.jpg --index <index-id> --json
overcast cluster show <person-id> --index <index-id> --json   # inspect that person's member faces
\`\`\`

4. Name known people and record the identification. Labels survive a
   \`recluster\`; point the finding's \`--ref\` at the \`cluster identify\` record so
   its match rides into the brief, and ALWAYS leave a \`tldr\` note — even a
   no-match sweep — so the brief can say so:

\`\`\`bash
overcast cluster label <person-id> "Jane Doe" --index <index-id> --json
overcast finding create "identified suspect.jpg as person <person-id> (Jane Doe) — 91/100, appears in 3 clips" --ref <identify-record-id> --confidence high --json
overcast note "booked <n> clips into the lineup; <p> distinct people; suspect.jpg matched <person-id> at 91/100" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./lineup.html --json
\`\`\`

After a large batch of \`cluster add\`s, run \`overcast cluster recluster --index
<index-id> --json\` to re-group every stored face; human labels carry forward.

## Output

For each identification return: the probe photo, the matched \`person-id\` (and
label if named), the similarity score (0–100), the member clips/images the person
appears in with their \`record.id\` + \`media.at\`, and the exported lineup path. A
probe with no confident match is reported as a likely new person, not forced onto
the nearest face.

## Caveats

Similarity is 0–100 (percent), not 0–1 — set \`--min-similarity\` on that scale.
The assign-or-create threshold controls how eagerly faces merge: too low over-merges
distinct people, too high splits one person across rows — tune it, then
\`recluster\`. Detection is per sampled frame, so one person yields many member
faces; that is expected, not duplicate people. Poor lighting, small faces, and
heavy angles lower embedding quality — treat a single borderline match as a lead
and corroborate with \`face --match\` or a second clip before calling it.
`;
}

/** Surveillance skill: standing watch on sources + a live control-room wall. */
export function generateStakeoutSkill(): string {
  return `---
name: overcast-stakeout
description: >-
  Run a standing surveillance watch on public sources for a target — auto-sense
  new media, auto-flag matches for review, and keep a live control-room wall — so
  new evidence surfaces itself over time.
---

# overcast-stakeout

Use this skill when the task is to sit on a target and catch new media as it is
published (a "stakeout"), rather than a one-shot recon pass. Use the broad
\`overcast\` skill and \`overcast/reference/verbs.md\` for exact flags. Only start a
continuous loop when the user asks for ongoing monitoring.

## Workflow

1. Set the standing scope. A **text** target (a name, handle, plate, phrase)
   drives auto-findings — new media whose \`watch\`/\`listen\` text mentions it is
   flagged for review; pair it with \`--auto-sense watch\` and \`--findings review\`:

\`\`\`bash
overcast doctor --sources --json
overcast case init --json
overcast case setup --name stakeout --target "<name / plate / phrase>" --source "x:@handle,youtube:@channel" --auto-sense watch --findings review --yes --json
\`\`\`

2. Sanity pass — one diff cycle, scheduler-friendly, to confirm sources resolve
   before you leave a loop running:

\`\`\`bash
overcast monitor --once --pipe watch --json
\`\`\`

3. Stand the watch up. Run the continuous loop under tmux; \`--alert\` mirrors new
   records to a sink and \`--brief\` summarizes each batch:

\`\`\`bash
overcast monitor --every 15m --limit 5 --pipe watch --alert ./stakeout.jsonl --brief --json
\`\`\`

4. Work the review queue as findings accrue — accept real matches, dismiss noise
   (dismissed findings drop out of memory and the brief but stay auditable):

\`\`\`bash
overcast finding list --json
overcast finding accept <finding-id> --json
overcast finding dismiss <finding-id> --json
\`\`\`

5. Keep the control-room wall up as the visual surface — every case video muted
   and looping at its best evidence moment, freshest first, auto-restarting:

\`\`\`bash
overcast wall --refresh 60 --theme csi --json
overcast wall --source x --since 24h --theme csi --json    # scope to one feed / window
overcast brief --export ./stakeout.html --json             # periodic cited report
\`\`\`

**Face-forward stakeout.** A face/image suspect is an image target, which is
excluded from text auto-findings. Pipe detection instead (\`monitor --pipe face\`)
to surface faces in new media, then escalate the flagged clips manually with
\`overcast face <clip> --match ./suspect.jpg --json\`, or keep a face-analysis index
and search it (\`face --match ./suspect.jpg --index <id>\`).

## Output

A standing case that accrues cited findings over time: accepted matches with their
source URL, \`record.id\`, and \`media.at\`; the alert-sink JSONL of new records; the
freshness-overlaid wall; and periodic \`brief\` exports. State the cadence and which
sources are live.

## Caveats

Hard processing failures are marked seen (no infinite retry); credential/pending
gaps stay retryable — run \`doctor --sources\` when a feed goes quiet. Apify-backed
sources (\`x\`, \`tiktok\`, \`lens\`) bill per result, so keep \`--limit\` low on a
frequent loop. The wall decodes real video — ~25 tiles is a practical ceiling
(\`--limit\`); use \`--source\`/\`--since\` to scope it. Auto-findings are keyword
matches on sensed text, so they shortlist — confirm before acting.
`;
}

/** Geolocation skill: extract location clues and reverse-search them to a place. */
export function generateSceneLocateSkill(): string {
  return `---
name: overcast-scene-locate
description: >-
  Work out where a photo or clip was taken — pull signage, landmarks, and terrain
  clues, reverse-image-search the strongest ones, and corroborate to a location
  with cited evidence.
---

# overcast-scene-locate

Use this skill when the task is "where was this taken?": geolocate an image or
video from what is visible in it. Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact flags. Escalate cheap-before-billed —
description and OCR are free; reverse image search bills per result, so run it only
on the strongest clues.

## Workflow

1. Ingest and read the scene for clues (free tier). For a video, \`watch\` it and
   pull the clearest frames; for a photo, \`see\` it directly:

\`\`\`bash
overcast doctor --json
overcast case init --json
# A still PHOTO — read it directly with see (watch requires video, so don't watch a photo):
overcast see ./photo.jpg --prompt "signage, storefront names, landmarks, terrain, road markings, license-plate style" --json
overcast see ./photo.jpg --ocr --json                             # street signs, storefronts, plates, notices
# A VIDEO — watch it, then read the clearest frames via frame://:
overcast watch ./clip.mp4 --json
overcast see frame://<watch-record-id>@<seconds> --prompt "signage, storefront names, landmarks, terrain, vegetation, road markings, side of road traffic drives on" --json
overcast see frame://<watch-record-id>@<seconds> --ocr --json     # street signs, storefronts, plates, notices
\`\`\`

2. Materialize the strongest clue regions as crops. \`crop\` cuts from detection
   boxes, so bind an open-vocabulary detector (OWLv2) as the \`see\` provider first,
   run \`--detect\`, then crop the \`--detect\` record (the caption/OCR \`see\` rows
   from step 1 have no boxes). Crops become the reverse-search queries:

\`\`\`bash
overcast setup provider see "exec:python3 examples/providers/detect/detect.py" --json  # bind OWLv2 for --detect
# detect on the SAME still from step 1 (a photo, or frame://<watch-record-id>@<seconds> for video):
overcast see ./photo.jpg --detect "sign, storefront, logo, landmark" --json   # -> <detect-record-id>
overcast crop <detect-record-id> --all --class sign --pad 0.2 --json          # crop the --detect record (it has boxes)
\`\`\`

3. Reverse-image-search the best crops through Google Lens, and corroborate OCR'd
   text on the open web:

\`\`\`bash
overcast source add "lens:./.overcast/media/crops/<crop-file>.jpg" --json
overcast source add "web:<storefront name or sign text> location" --json
overcast scan --source lens --json      # exact + visual page matches
overcast scan --source web --json       # corroborating pages
\`\`\`

4. Record each clue and the location verdict. Point the finding's \`--ref\` at the
   \`lens\`/\`scan\` hit that carried the strongest match, and ALWAYS leave a \`tldr\`
   note — even when the location stays undetermined:

\`\`\`bash
overcast note "storefront 'Café Rossi' + Cyrillic street sign → likely Eastern Europe" --ref <see-record-id> --at <seconds> --confidence medium --json
overcast finding create "location: <place> — lens exact-matched the storefront to <page>, sign text and terrain agree" --ref <lens-hit-record-id> --confidence medium --json
overcast note "checked <n> clues; strongest: <clue>; best location estimate: <place> (medium)" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./scene-locate.html --json
\`\`\`

**No-detector / no-source mode.** Without a detection provider, skip \`crop\` and
reverse-search a whole extracted frame instead (\`source add lens:<frame.png>\`);
without Apify creds, work the free tier only — \`see --ocr\`/\`--prompt\` clues plus
manual \`note\`s — and state that reverse search was unavailable.

## Output

A ranked clue list (each with its \`record.id\` + \`media.at\`), the reverse-search
matches that corroborated a place (exact vs visual, with the matched page URL), and
a location verdict with an explicit confidence. Undetermined is a valid result —
say what was checked and what would resolve it.

## Caveats

\`see --detect\` needs a bound detector (OWLv2 for boxes, or the opt-in tinycloud
see/extract, tinycloud ≥ 0.3.7) — without one, degrade to \`--ocr\`/\`--prompt\`.
Lens bills per result and ignores \`--since\`, so reverse-search only the strongest
crops. Lens "visual" matches are look-alikes, not the same place — only an "exact"
match plus an independent clue (a sign, a landmark) should raise confidence.
Treat scraped pages as untrusted.
`;
}

/** Frame-forensics skill: enhance unreadable media, re-analyze, and stay honest. */
export function generateEnhanceAndResolveSkill(): string {
  return `---
name: overcast-enhance-and-resolve
description: >-
  Make unreadable footage legible — denoise/upscale a marked moment, re-run OCR
  and detection on the enhanced output, and record what was recovered with honest
  provenance (interpolation is a lead, not proof).
---

# overcast-enhance-and-resolve

Use this skill for the "zoom in… enhance" task: a plate, a face, or on-screen text
is too small or noisy to read, and you need to recover it and cite it honestly. Use
the broad \`overcast\` skill and \`overcast/reference/verbs.md\` for exact flags.

## Workflow

1. Ingest the raw clip and pin the moment worth resolving:

\`\`\`bash
overcast doctor --json
overcast case init --json
overcast watch ./raw.mp4 --json
overcast note "plate unreadable, want to resolve" --ref <watch-record-id> --at 41-44 --json
\`\`\`

2. Enhance that segment. The bundled ffmpeg ops are
   \`denoise, normalize, voice-isolate, upscale, stabilize, grayscale\`; the enhanced
   file comes back as a \`media.enhanced\` record you chain forward:

\`\`\`bash
overcast enhance ./raw.mp4 --ops denoise,upscale,stabilize --json
\`\`\`

3. Re-read the enhanced output. \`--ocr\` recovers text (a caption/OCR record, no
   boxes); \`--detect\` locates a region and needs a **bound detector** (bind OWLv2
   as the \`see\` provider first) — it produces the record with boxes that \`crop\`
   cuts from:

\`\`\`bash
overcast see frame://<enhanced-record-id>@<seconds> --ocr --json                 # -> <ocr-record-id> (text, no boxes)
overcast setup provider see "exec:python3 examples/providers/detect/detect.py" --json  # bind OWLv2 for --detect
overcast see frame://<enhanced-record-id>@<seconds> --detect "license plate, text" --json  # -> <detect-record-id> (boxes)
\`\`\`

4. Materialize the resolved region as durable cropped evidence — crop the
   \`--detect\` record (the \`--ocr\` record has no boxes to crop):

\`\`\`bash
overcast crop <detect-record-id> --all --class "license plate" --pad 0.15 --square --json
\`\`\`

5. Record what was recovered with its provenance. State the ops applied and the
   source record in the finding, keep a before/after note pair, and cite both the
   raw and enhanced \`record.id\`:

\`\`\`bash
overcast note "before: plate illegible at 41-44 on <watch-record-id>" --ref <watch-record-id> --at 41-44 --json
overcast note "after denoise+upscale+stabilize: reads '7ABC123' (2 chars uncertain)" --ref <enhanced-record-id> --json
overcast finding create "plate resolved to '7ABC123' via enhance denoise,upscale,stabilize on <watch-record-id> — 2 chars low-confidence" --ref <detect-record-id> --confidence low --json
overcast brief --export ./enhance-resolve.html --json
\`\`\`

## Output

The recovered text/object with an explicit confidence, the exact enhancement ops
applied, the before/after \`record.id\` pair, and the cropped evidence path. Frame
whatever you recover as a lead to corroborate, not a settled fact.

## Caveats

**ffmpeg upscale is interpolation — it cannot invent detail that was never
captured.** Recovered characters are a lead, not proof; mark them low-confidence and
corroborate (a second angle, a second frame, context). For genuine AI restoration
bind a model provider (\`overcast provider setup apply --preset fal --yes\`, ESRGAN /
DeepFilterNet) and re-run \`see\` on the restored output — then still corroborate.
\`stabilize\` and \`upscale\` change geometry, so re-derive any box/measurement on the
enhanced record, not the raw one.
`;
}

/** Audio-forensics skill: diarize, describe the scene, isolate voices, correlate. */
export function generateWiretapSkill(): string {
  return `---
name: overcast-wiretap
description: >-
  Work a recorded call or audio clip already in the case — separate the speakers,
  read the background scene for location clues, isolate and re-transcribe voices,
  and correlate content across recordings.
---

# overcast-wiretap

Use this skill to analyze audio recordings you already hold (a call, a voicemail, a
field recording): how many people speak, what the background reveals about where it
was recorded, and whether two clips share a voice or a phrase. Use the broad
\`overcast\` skill and \`overcast/reference/verbs.md\` for exact flags.

## Workflow

1. Transcribe the recording and read its background scene on the **default
   backend**. \`--describe\` surfaces the whole audio scene (traffic, trains, a PA
   announcement, church bells) — the "enhance the background noise" move that
   places a recording — and is a tinycloud/Cloudglue multimodal feature, so do all
   the transcript/describe work FIRST, before binding any speech-only provider:

\`\`\`bash
overcast doctor --json
overcast case init --json
overcast listen ./call.wav --json                 # speech transcript + time-anchored segments
overcast listen ./call.wav --describe --json       # background audio scene (tinycloud describe)
overcast view ./call.wav --spectrogram --json      # visual inspection artifact (tones, hums, edits)
\`\`\`

2. Isolate voices from noise and re-transcribe the cleaned track — a second pass
   often recovers words the first missed:

\`\`\`bash
overcast enhance ./call.wav --ops voice-isolate,denoise --json
overcast listen <enhanced-record-id> --json
\`\`\`

3. Separate the speakers. \`--diarize\` needs a **diarize-capable listen provider**
   (the default tinycloud/Cloudglue \`listen\` is speech-transcript only and rejects
   \`--diarize\`). Bind ElevenLabs for this — but do it LAST, after the describe /
   multimodal steps above, because ElevenLabs Scribe is speech-only and drops the
   audio-scene describe:

\`\`\`bash
overcast provider setup apply --verb listen --choice elevenlabs --yes --json
overcast listen ./call.wav --diarize --json        # -> <diarize-record-id> (speaker-labeled)
\`\`\`

4. Record per-speaker and per-clue observations, then correlate across recordings.
   Cite the speaker-labeled \`<diarize-record-id>\` for who-said-what claims (not the
   step-1 transcript record):

\`\`\`bash
overcast note "Speaker 2: PA announces 'platform 4' at 00:38 → rail station" --ref <diarize-record-id> --at 38 --confidence medium --json
overcast ask "which recordings share a speaker, phrase, or background cue? cite record.id + time" --verb listen --json
\`\`\`

5. Turn confirmed clues into findings and export; always leave a \`tldr\` note:

\`\`\`bash
overcast finding create "call.wav and voicemail.m4a share Speaker 2's phrasing + station PA — likely same caller/location" --ref <diarize-record-id> --confidence medium --json
overcast note "3 recordings; 2 speakers on call.wav; background = rail station; cross-clip voice overlap on 2 of 3" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./wiretap.html --json
\`\`\`

## Output

A per-recording speaker breakdown with timestamps, the background-scene clues that
locate or date it, any cross-clip voice/phrase overlaps, and the spectrogram
artifacts — each cited by \`record.id\` + \`media.at\`.

## Caveats

\`--diarize\` needs a diarize-capable listen provider: the default tinycloud/Cloudglue
\`listen\` transcribes speech only and errors on \`--diarize\` — bind ElevenLabs
(\`provider setup apply --verb listen --choice elevenlabs --yes\`) for speaker
separation. Bind it LAST: ElevenLabs Scribe is speech-only and drops the audio-scene
\`--describe\`, so run all transcript/describe/multimodal work on the default backend
first, then rebind for the diarize pass. Diarization LABELS speakers ("Speaker
1/2"), it does not IDENTIFY them —
a name is a corroborated inference, never a diarizer output. \`voice-isolate\` on the
bundled ffmpeg is a filter, not source separation; bind ElevenLabs
(\`--verb enhance --choice elevenlabs\`) for stronger isolation, and re-listen to
confirm the cleaned transcript rather than trusting it blind. Background-cue
geolocation is suggestive, not definitive.
`;
}

/** Provenance skill: trace a suspect clip back to its earliest appearance. */
export function generateProvenanceSkill(): string {
  return `---
name: overcast-provenance
description: >-
  Trace a suspicious or viral clip back to its earliest appearance and originator —
  reverse-image-search distinctive frames, sweep sources with no recency floor, and
  return a cited origin verdict.
---

# overcast-provenance

Use this skill to answer "is this clip real / where did it come from?": given a
suspect video, find the oldest copy and who posted it first. It is the inverse of
\`overcast-copycat-sweep\` — searching backward toward the origin rather than forward
for rips — and reuses its geometry-gating and verdict conventions. Use the broad
\`overcast\` skill and \`overcast/reference/verbs.md\` for exact flags.

## Workflow

1. Fingerprint the suspect clip — distinctive frames survive re-encodes, crops, and
   watermarks that defeat exact hashes:

\`\`\`bash
overcast doctor --sources --json
overcast case init --json
overcast watch ./suspect.mp4 --json          # content + transcript into memory
overcast index create origin --type image-ransac --local --json
overcast image add ./distinctive-frame.png --index <index-id> --json
\`\`\`

2. Reverse-image-search the frames and sweep sources with topic keywords — crucially
   with NO \`--since\` floor, since older results sit closer to the origin:

\`\`\`bash
overcast source add "lens:./distinctive-frame.png" --json
overcast source add "x:video:<topic keywords>" --json
overcast source add "youtube:search:<topic keywords>" --json
overcast source add "web:<topic keywords>" --json
overcast scan --limit 20 --json
\`\`\`

3. Triage on metadata alone: sort candidate hits by \`published\` ASC — the earliest
   dates are your origin candidates; carry \`author\` + URL forward.

4. Capture the oldest few and confirm they are the SAME content (not a look-alike) —
   frame match plus transcript:

\`\`\`bash
overcast capture <earliest-scan-hit-id> --json
overcast image match <captured-file> --index <index-id> --draw --json   # --draw writes the RANSAC overlay proof
overcast listen <captured-file> --json
\`\`\`

5. Record the origin verdict. \`--ref\` the \`image match\` record so its overlay rides
   into the brief; ALWAYS leave a \`tldr\` note with the date chain — even
   "undetermined":

\`\`\`bash
overcast finding create "origin: earliest confirmed copy is @<author> <date> (frame match 88 inliers, transcript identical); the viral <date2> post is a re-upload" --ref <image-match-record-id> --confidence high --json
overcast note "swept lens + x + youtube + web (no recency floor); <n> candidates; earliest confirmed <date> by @<author>; verdict: re-upload" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./provenance.html --json
\`\`\`

## Output

An origin verdict — original / re-upload-of-<earliest> / undetermined — with the
date chain, the earliest confirmed poster and URL, which layers agreed (frame +
transcript), and the strongest \`record.id\` + \`media.at\` citations. "Undetermined"
is honest when the earliest copy can't be confirmed as the same content.

## Caveats

The earliest date you FIND is a floor, not proof of origin — deleted posts and
platforms you didn't search may predate it; say so. Confirm same-content with the
gated \`image match\` (a high inlier count on a degenerate homography is the main
false positive — eyeball the \`--draw\` overlay) plus transcript; a shared topic or a
look-alike frame is not the same clip. Face similarity is 0–100; \`image match\` is
an inlier count + a 0–1 ratio, never a 0–100 score. Apify sources bill per result.
\`lens\` ignores \`--since\`.
`;
}

/** Reconstruction skill: stitch multiple clips into one cited chronology. */
export function generateTimelineSkill(): string {
  return `---
name: overcast-timeline
description: >-
  Reconstruct a single event from multiple clips — sense each one, cross-anchor
  shared moments, surface corroborations and contradictions, and produce one cited
  chronological brief.
---

# overcast-timeline

Use this skill to "walk through what happened" across several recordings of one
event (bystander videos, multiple cameras, a sequence of clips): build one ordered,
cited timeline and flag where accounts disagree. Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact flags.

## Workflow

1. Sense every clip — \`watch\` for the visual timeline, \`listen\` where audio carries
   the account:

\`\`\`bash
overcast doctor --json
overcast case init --json
overcast watch ./cam1.mp4 --json
overcast watch ./phone-clip.mp4 --json
overcast listen ./phone-clip.mp4 --json
\`\`\`

2. Cross-anchor shared moments with span notes — a visible clock, a shared sound, a
   lighting change lets you line clips up on one timeline:

\`\`\`bash
overcast note "wall clock reads 21:14 as the door opens" --ref <cam1-record-id> --at 12-15 --tag anchor --json
overcast note "same doorbell chime as cam1@13 — clips overlap here" --ref <phone-record-id> --at 3-6 --tag anchor --json
\`\`\`

3. Corroborate and contradict across clips. File a conflict finding ONLY when the
   answer actually reports a disagreement — don't invent one every run; if the
   accounts agree, record that and skip the finding:

\`\`\`bash
overcast ask "order the events across all clips with timestamps; where do accounts agree or conflict? cite record.id + media.at" --json
# only if the answer reports a real conflict:
overcast finding create "conflict: cam1 shows the car arriving BEFORE the shout; phone-clip audio has the shout first" --ref <cam1-record-id> --at 12-15 --confidence low --json
\`\`\`

4. Produce the chronological deliverable, and always leave a \`tldr\` note first:

\`\`\`bash
overcast note "reconstructed <n> clips into one timeline; <k> firm anchors; <c> unresolved conflicts" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./timeline.html --json
\`\`\`

## Output

One ordered chronology of the event, each entry cited to a \`record.id\` + \`media.at\`,
the anchor moments that let clips be aligned, and an explicit list of unresolved
contradictions. Where clips can't be ordered relative to each other, say so rather
than guessing.

## Caveats

Device clocks and upload times drift — prefer content anchors (a shared sound, a
visible clock, a synchronized event) over file timestamps when aligning clips.
Absence of a moment in one clip is not evidence it didn't happen — it may be
off-frame. Keep observed facts (in \`note\`) separate from inferred ordering; a
contradiction is a finding to review, not a settled conclusion.
`;
}

/** Evidence-board skill: materialize crops, link people/themes, render the board. */
export function generateCrimeBoardSkill(): string {
  return `---
name: overcast-crime-board
description: >-
  Turn a case into a visual evidence board — materialize face and object crops,
  link the same person across clips, connect themes, and render the corkboard as a
  CSI brief plus a live monitor wall.
---

# overcast-crime-board

Use this skill when the case has accumulated media and you want the "red-string
corkboard": the people, objects, and connections laid out visually. It composes
existing evidence into two shareable surfaces. Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact flags.

## Workflow

1. Materialize the evidence cards — faces and objects as durable crops (run
   \`face --thumbnails\` first so \`crop\` has frame images to cut from). Object cards
   need a bound open-vocabulary detector (OWLv2): \`crop\` cuts from detection boxes,
   so bind a detector as the \`see\` provider before \`--detect\`, then crop the
   \`--detect\` record (a caption/OCR \`see\` record has no boxes to crop):

\`\`\`bash
overcast doctor --json
overcast face ./clip.mp4 --thumbnails --json
overcast crop <face-record-id> --all --class face --square --pad 0.1 --json
overcast setup provider see "exec:python3 examples/providers/detect/detect.py" --json  # bind OWLv2 for --detect
overcast see ./clip.mp4 --detect "car, bag, weapon, phone" --json
overcast crop <detect-record-id> --all --kind object --json   # crop the --detect record (it has boxes)
\`\`\`

2. Draw the strings — link the same person across clips with the local face DB, and
   connect visual themes with CLIP semantic search:

\`\`\`bash
overcast index create people --type face-cluster --local --json
overcast cluster add ./clip.mp4 --index <cluster-index-id> --json
overcast cluster identify ./person-of-interest.jpg --index <cluster-index-id> --json
overcast index create scenes --type basic-clip --local --json
overcast similar add ./clip.mp4 --index <clip-index-id> --json
overcast similar search "red backpack on a bicycle" --index <clip-index-id> --json
\`\`\`

3. Record the connections as notes so they land on the board:

\`\`\`bash
overcast note "same man (cluster <person-id>) appears in clip.mp4 and cctv.mp4 carrying the red backpack" --ref <identify-record-id> --tag connection --confidence medium --json
\`\`\`

4. Render the two visual surfaces — the CSI brief is the corkboard, the wall is the
   live monitor bank:

\`\`\`bash
overcast brief --theme csi --export ./crime-board.html --json
overcast wall --theme csi --json                # add --infinite for an endless bank
\`\`\`

## Output

Two artifacts: a CSI-themed brief that lays out the crops, cited findings, and
connection notes as an evidence board; and a control-room wall of the case videos
looping at their evidence moments. Each connection is cited to the \`record.id\` it
was drawn from.

## Caveats

Crops need detections first — run \`face --thumbnails\` before cropping faces, and a
bound detector for \`see --detect\` object crops. \`cluster\`/\`similar\` are local,
deepface/CLIP-backed indexes (\`scripts/visual-db-uv.sh\`); \`doctor\` flags missing
deps. A CLIP or cluster link is a suggestion to verify, not a proven connection —
label its confidence and corroborate before drawing the string. Face similarity and
CLIP scores are both 0–100; keep them distinct from an \`image match\` inlier count.
`;
}
