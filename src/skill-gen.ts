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

/** Skill: pinpoint WHEN something happens — coarse→fine temporal search. */
export function generatePinpointSkill(): string {
  return `---
name: overcast-pinpoint
description: >-
  Pinpoint WHEN a specific thing happens in a video — funnel from cheap
  coarse candidates (shots / CLIP / grid) to a frame-verified time window.
---

# overcast-pinpoint

Use this skill to answer "exactly when does X happen?" in a clip and back it
with evidence the model actually looked at. It mirrors the temporal-search
pattern from the VLM video literature (T\\* / VideoAgent): score cheaply over the
whole clip, then spend expensive VLM calls only on a few candidate frames and
zoom in. Use the broad \`overcast\` skill and \`overcast/reference/verbs.md\` for
exact flags.

Two rules that make the answer trustworthy:

- **Report a window, not a frame.** Frame-exact localization is unreliable; emit
  \`[t1-t2]\` plus one verified keyframe.
- **Every timestamp must trace to a frame you \`see\`-verified.** Never emit a
  time the model merely guessed — models answer correctly while grounding on the
  wrong moment, so confirm by looking at the frame.

## Workflow

1. Make the clip local and get a record id (\`see frame://\` needs media on disk —
   capture a remote clip first). \`watch\` also gives per-shot timestamped content
   to search:

\\\`\\\`\\\`bash
overcast doctor --json
overcast case init --json
overcast watch ./clip.mp4 --json         # -> video.analysis record id (REC)
\\\`\\\`\\\`

2. Get COARSE candidates cheaply (pick what's available):

\\\`\\\`\\\`bash
overcast ask "moments where <X> happens, with timestamps" --json      # over watch shots/notes
overcast grid ./clip.mp4 --count 16 --json                            # one contact sheet ...
overcast see <montage-path> --prompt "which numbered cells show <X>? give cell numbers" --json
overcast similar search "<X>" --index <basic-clip-id> --json          # if a local CLIP index exists
overcast ask "moments <X> happens" --index <media-descriptions-id> --probe --json  # remote index
\\\`\\\`\\\`

   For \`grid\`, translate the chosen cell number to a time via the grid record's
   \`payload.cells[n].at\` (don't trust a model-guessed time). CLIP/shots only
   SHORTLIST — CLIP is weak on actions/order — so verify next.

3. VERIFY + zoom on each candidate time T (expensive, precise):

\\\`\\\`\\\`bash
overcast see frame://REC@T --prompt "Is <X> happening here? answer yes/no and what you see" --json
# refine: sample T-d and T+d, halve d each round until adjacent frames flip yes<->no
overcast see frame://REC@<T-2> --prompt "Is <X> happening?" --json
overcast see frame://REC@<T+2> --prompt "Is <X> happening?" --json
\\\`\\\`\\\`

4. Record the verified window and eyeball it:

\\\`\\\`\\\`bash
overcast note "<X> occurs" --ref REC --at <t1-t2> --confidence medium --json
overcast view REC --at <t1-t2> --json
overcast brief --export ./pinpoint.md --json
\\\`\\\`\\\`

## Output

The tightest \`[t1-t2]\` window, the single \`see\` keyframe that confirms it (its
\`record.id\`), and how it was found (shots / grid / CLIP / probe). Cite
\`record.id\` + \`media.at\` for every claim; state the window, not a false-precise
single frame.

## Caveats

Needs the video local (a URL-only \`watch\` record can't extract frames). CLIP and
shot text shortlist but don't decide — the \`see\` frame check does. If \`X\` recurs,
pinpoint each occurrence separately; don't collapse them into one window.
`;
}

/** Skill: one-call contact-sheet triage over a clip (the grid trick). */
export function generateFrameGridSkill(): string {
  return `---
name: overcast-frame-grid
description: >-
  Triage a whole clip in one VLM call — tile sampled frames into a labeled
  contact sheet, ask which cells show the target, then zoom in.
---

# overcast-frame-grid

Use this skill to find roughly WHERE in a clip something appears with a single
vision call, before spending per-frame calls. It's the "grid trick" from
temporal-search research (frames tiled into one image; Set-of-Mark numbering over
time). Pairs with \`overcast-pinpoint\` for the frame-precise follow-up. Use the
broad \`overcast\` skill and \`overcast/reference/verbs.md\` for exact flags.

## Workflow

\\\`\\\`\\\`bash
overcast doctor --json
overcast case init --json
overcast grid ./clip.mp4 --count 16 --json     # -> media.grid: payload.montage + payload.cells + payload.cols
overcast see <montage-path> --prompt "Which numbered cells show <X>? Reply with cell numbers and why." --json
\\\`\\\`\\\`

- If the grid record's \`payload.labeled\` is \`false\` (this ffmpeg build has no
  \`drawtext\`), tell \`see\` it's a \`<cols>\`-column grid numbered left-to-right,
  top-to-bottom (\`cols\` is in the record), so it can reference cells by position.
- Always map the chosen cell number back through \`payload.cells[n].at\` to get the
  real timestamp — never use a time the model typed out.

Zoom in on the winning region (narrow the window, or hand the timestamp to
\`overcast-pinpoint\`):

\\\`\\\`\\\`bash
overcast grid ./clip.mp4 --start <a> --end <b> --count 16 --json   # finer sheet around the hit
overcast see frame://<watch-record>@<t> --prompt "Is <X> here? yes/no + detail" --json
overcast note "<X> first visible" --ref <record> --at <t1-t2> --json
overcast brief --export ./grid-triage.md --json
\\\`\\\`\\\`

Use \`--at "s1,s2,s3"\` instead of \`--count\` when you already have candidate
timestamps to compare side by side; \`--start/--end\` to focus a window; \`--cols\`
/ \`--width\` to shape the sheet.

## Output

The cell(s) that matched, the timestamp each maps to (via \`payload.cells\`), and
the grid \`record.id\`. Treat grid hits as coarse (one frame per cell) — confirm
the exact moment by \`see\`-ing that frame before citing it as evidence.

## Caveats

One contact sheet samples sparsely, so a brief event between cells can be missed —
raise \`--count\` or re-grid a tighter \`--start/--end\`. The montage is a still, so
motion/audio cues are gone; use \`watch\`/\`listen\` when those matter. Video can be
local or a URL, but the \`see frame://\` zoom-in step needs it local.
`;
}

/** Skill: bisect the exact instant of a monotone state change. */
export function generateEventBisectSkill(): string {
  return `---
name: overcast-event-bisect
description: >-
  Localize the exact instant of a one-way state change (light on, door opens,
  poster removed) by binary-searching frames — ~log2(N) VLM calls.
---

# overcast-event-bisect

Use this skill when a video contains a single MONOTONE transition — a condition
that is false before some instant and true after it (or vice versa), and does not
flip back. Binary search finds it in about log2(window/precision) vision calls
(~12 calls localizes to ~1s inside an hour). Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact flags.

## Workflow

1. Local clip + record id (\`see frame://\` needs media on disk):

\\\`\\\`\\\`bash
overcast doctor --json
overcast case init --json
overcast watch ./clip.mp4 --json        # -> record id REC (also gives shot context)
\\\`\\\`\\\`

2. Confirm the transition is bracketed AND monotone — the two endpoints must
   disagree on the predicate:

\\\`\\\`\\\`bash
overcast see frame://REC@<lo> --prompt "Is <predicate> true? answer only yes or no" --json
overcast see frame://REC@<hi> --prompt "Is <predicate> true? answer only yes or no" --json
\\\`\\\`\\\`

   If both give the same answer, the flip isn't in \`[lo,hi]\`. If the predicate
   toggles more than once, it isn't monotone — use \`overcast-pinpoint\` instead.

3. Bisect: test the midpoint, keep the half that still straddles the flip, repeat
   until \`hi - lo\` is within your precision:

\\\`\\\`\\\`bash
overcast see frame://REC@<mid> --prompt "Is <predicate> true? answer only yes or no" --json
# yes at mid  -> the flip is in [lo, mid]; no at mid -> it's in [mid, hi]
\\\`\\\`\\\`

4. Report the transition window and show it:

\\\`\\\`\\\`bash
overcast note "<predicate> becomes true" --ref REC --at <lastFalse-firstTrue> --confidence high --json
overcast view REC --at <lastFalse-firstTrue> --json
overcast brief --export ./transition.md --json
\\\`\\\`\\\`

## Output

The bracket \`[last-false, first-true]\`, the two \`see\` frames that straddle it
(their \`record.id\`s + \`media.at\`), and the call count. That bracket IS the
answer window — don't over-claim a single frame.

## Caveats

Bisection is only valid for a one-way change; a light that blinks or a person who
comes and goes will mislead it — verify monotonicity at step 2, and fall back to
\`overcast-pinpoint\` (peak search) or \`overcast-presence-window\` for recurring or
interval events. Needs the video local.
`;
}

/** Skill: locate WHERE in the frame — detector-propose, VLM-verify. */
export function generateWhereSkill(): string {
  return `---
name: overcast-where
description: >-
  Locate WHERE in a frame a target is — open-vocab detect, crop the box, then
  VLM-verify the crop so hallucinated boxes don't survive.
---

# overcast-where

Use this skill to turn a moment into spatial evidence: a bounding box on the
target plus a verified crop. It follows the detector-proposes / VLM-verifies
pattern (open-vocab detection like OWLv2, then confirm the crop) — because chat
VLMs are unreliable at emitting raw coordinates, so a real detector draws the box
and the VLM only judges the crop. Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact flags.

## Setup

\`see --detect\` needs a detection provider bound (boxes come from OWLv2, not the
brain LLM):

\\\`\\\`\\\`bash
overcast setup provider see "exec:python3 examples/providers/detect/detect.py" --json
# or the catalog: overcast provider setup apply --preset owl-local --yes --json
\\\`\\\`\\\`

## Workflow

1. Have the moment (use \`overcast-pinpoint\` / \`overcast-frame-grid\`): timestamp
   T on record REC.

2. Detect the target in that frame, then materialize + verify the box:

\\\`\\\`\\\`bash
overcast see frame://REC@T --detect "<target phrase>" --json      # -> see record with detections[]
overcast crop <see-record-id> --all --class "<target phrase>" --pad 0.15 --json
overcast see <crop-path> --prompt "Does this crop show <target>? yes/no + describe" --json
\\\`\\\`\\\`

   The re-\`see\` of each crop is what kills false positives — open-vocab detectors
   emit confident boxes for almost any phrase at low thresholds.

3. Optionally sharpen the exhibit and record the finding:

\\\`\\\`\\\`bash
overcast enhance <crop-path> --ops upscale,denoise --json
overcast finding create "<target> located at T" --ref <see-record-id> --confidence medium --json
overcast brief --export ./where.md --json
\\\`\\\`\\\`

## Output

Per confirmed target: the timestamp, the box (from the \`see --detect\` record),
the crop path, and the verification verdict. Cite the \`see\` detection
\`record.id\` + \`media.at\`; note the crop is the durable, memory-friendly evidence
artifact.

## Caveats

Never ask the brain LLM for coordinates directly — bind a detector and verify
crops. Detector confidence is not calibrated across free-form phrases: a high
score on a rare phrase can still be wrong, so the crop re-check decides. For a
specific PERSON, use \`face --match\` instead of \`--detect\`. Boxes are per sampled
frame, not tracks.
`;
}

/** Skill: first/last appearance interval by sweeping outward from an anchor. */
export function generatePresenceWindowSkill(): string {
  return `---
name: overcast-presence-window
description: >-
  Find the interval a person or object is present — anchor one appearance, then
  sweep outward with face-match / detect until it drops off both sides.
---

# overcast-presence-window

Use this skill to answer "from when to when is <target> on screen?" — a first/last
appearance interval, not a single instant. It anchors one confirmed appearance and
expands until the target stops appearing, the presence-tracking analog of a
temporal search. Use the broad \`overcast\` skill and
\`overcast/reference/verbs.md\` for exact flags.

## Workflow

1. Local clip + record id:

\\\`\\\`\\\`bash
overcast doctor --json
overcast case init --json
overcast watch ./clip.mp4 --json        # -> record id REC
\\\`\\\`\\\`

2. Anchor one appearance (whichever fits the target):

\\\`\\\`\\\`bash
overcast face ./clip.mp4 --match ./person.jpg --json          # a specific person (similarity 0-100)
overcast grid ./clip.mp4 --count 16 --json                    # then see the montage for an object
\\\`\\\`\\\`

3. Sweep outward from the anchor until K consecutive misses on each side:

\\\`\\\`\\\`bash
# person: widen the window; --fps controls sample density (precision vs cost)
overcast face ./clip.mp4 --match ./person.jpg --start <a> --end <b> --fps 1 --min-similarity 55 --json
# object: step frames outward and check presence
overcast see frame://REC@<t> --prompt "Is <target> present? answer only yes or no" --json
\\\`\\\`\\\`

4. Emit the presence interval(s) and show them:

\\\`\\\`\\\`bash
overcast note "<target> present" --ref REC --at <first-last> --confidence medium --json
overcast view REC --at <first-last> --json
overcast brief --export ./presence.md --json
\\\`\\\`\\\`

## Output

One or more \`[first-last]\` intervals with the per-hit citations (\`record.id\` +
\`media.at\`) that bound them, and the sample density used. If the target leaves
and returns, report each interval separately rather than one span covering the
gap.

## Caveats

Sampled detections are per-frame, not continuous — presence between samples is
inferred; raise \`--fps\` to tighten boundaries at higher cost. Occlusion or an
off-camera moment splits one presence into several intervals — that's a real
result, not noise. Face similarity is 0-100. Needs the video local.
`;
}
