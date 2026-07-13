# crime-board — the CSI lineup / crime board (multi-person)

**What this proves.** overcast can stand up a *persistent, fully local* face
database out of raw footage — no faces ever leave the machine — and have it
discover **several distinct people on its own**: one 160-second press-conference
clip goes in, and the DB separates the four Artemis II crew members into four
clean person clusters, re-identifies one of them across separated segments,
survives a held-out official-portrait probe, and renders the whole book as a
self-contained HTML contact sheet (every face crop embedded as a base64
data-URI). The lineup is the deepface-local `face-cluster` provider
(Facenet512 / retinaface via the uv-managed `OC_VISUAL_DB_PY` Python).

The story: book each speaking segment of one short NASA presser clip →
**4 distinct people** (Reid Wiseman, Victor Glover, Christina Koch, Jeremy
Hansen — the Artemis II crew, all public figures). Glover speaks in two
separated segments and the DB **matches his second appearance to his existing
person (0 new people)** — cross-segment re-identification, the CCTV-handoff
move. Then hand the book Christina Koch's official NASA portrait (never
ingested): it points at her cluster at **65.5/100** with the runner-up at
**3.4/100**.

## Media provenance (staged under `showcase/_media/faces/`)

- `artemis2-crew-presser-nasa-20250924.mp4` — trimmed from **NASA's official
  YouTube channel**: "Artemis II Crew News Conference (Sept. 24, 2025)",
  video id `9mq_lb_SmKE` (fetched with yt-dlp, the same engine behind the `dl:`
  source). A NASA production = **US-government work, public domain**. Four 40 s
  windows concatenated (ffmpeg) so each crew member gets a close-up segment in
  one 160 s clip: source 228–268 s (Wiseman), 498–538 s (Glover), 782–822 s
  (Koch), 1000–1040 s (Hansen); a wide panel shot sits inside the Glover
  window at clip time 56–68 s.
- `koch-portrait-nasa.jpg` — the held-out probe: Wikimedia Commons
  "Christina Koch Artemis 2 Crew Portrait.jpg" (NASA / Josh Valcarcel, JSC),
  **public domain**. Never ingested into the DB.

All four people are clearly identifiable public figures (the Artemis II crew);
identities were visually verified against the footage before labeling.

## Reproduce

All commands run from the repo root so `.env` auto-loads (`OC_VISUAL_DB_PY` for
the deepface stack). Every command is isolated with `--case showcase/crime-board`.
No `face` provider binding is needed — the shared profile is untouched.

```bash
# 0. fresh start (the old single-person build was cleared)
overcast case clear --yes --case showcase/crime-board --json

# 1. stand up a persistent LOCAL face-cluster index (the mugshot book)
overcast index create people --type face-cluster --local --case showcase/crime-board --json
IDX=local_face_cluster_29587d28
V=showcase/_media/faces/artemis2-crew-presser-nasa-20250924.mp4

# 2. book each speaking segment — detect + embed + assign-or-create at 0.5 fps.
#    --min-similarity 52 was tuned on a scout pass (see Notes): >48 so Hansen
#    doesn't glue onto Wiseman, ≤55 so profile poses still join their person.
#    The wide-shot window 56–68s is deliberately skipped (junk signatures, Notes).
overcast cluster add $V --index $IDX --fps 0.5 --min-similarity 52 --start 0   --end 40  --case showcase/crime-board --json   # rec_00a86601891b5a32: 20 faces -> 1 NEW person (Wiseman)
overcast cluster add $V --index $IDX --fps 0.5 --min-similarity 52 --start 40  --end 56  --case showcase/crime-board --json   # rec_3817611d8ce720cc:  8 faces -> 1 NEW person (Glover)
overcast cluster add $V --index $IDX --fps 0.5 --min-similarity 52 --start 68  --end 80  --case showcase/crime-board --json   # rec_3d8c840976eb1f34:  6 faces -> 0 new, ALL matched Glover (re-identified at 87-96)
overcast cluster add $V --index $IDX --fps 0.5 --min-similarity 52 --start 80  --end 120 --case showcase/crime-board --json   # rec_9438364cc2a98de6: 20 faces -> 1 NEW person (Koch)
overcast cluster add $V --index $IDX --fps 0.5 --min-similarity 52 --start 120 --end 160 --case showcase/crime-board --json   # rec_c5f30fb8ec9f010e: 20 faces -> 1 NEW person (Hansen)
#   -> 74 faces, 4 people, zero junk detections; no recluster needed

# 3. verify identities against the footage crops, then name the people
overcast cluster label p_1 "Reid Wiseman (NASA astronaut, Artemis II commander)" --index $IDX --case showcase/crime-board --json
overcast cluster label p_2 "Victor Glover (NASA astronaut, Artemis II pilot)"    --index $IDX --case showcase/crime-board --json
overcast cluster label p_3 "Christina Koch (NASA astronaut, Artemis II)"         --index $IDX --case showcase/crime-board --json
overcast cluster label p_4 "Jeremy Hansen (CSA astronaut, Artemis II)"           --index $IDX --case showcase/crime-board --json

# 4. the lineup probe — run the held-out official portrait through the book
overcast cluster identify showcase/_media/faces/koch-portrait-nasa.jpg \
  --index $IDX --case showcase/crime-board --json
#   -> rec_5e62a6f8a7799765: closest person p_3 "Christina Koch" at 65.5/100,
#      confident, NOT a new person; runner-up (Wiseman) 3.4/100

# 5. promote to evidence + narrate the verdict
overcast finding create "Held-out official NASA portrait ... identified as p_3 'Christina Koch' at 65.5/100 ..." \
  --ref rec_5e62a6f8a7799765 --confidence high --case showcase/crime-board --json   # rec_872aaaf40a072dba
overcast note "Booked the four speaking segments ... 74 faces -> 4 distinct people ..." \
  --tag tldr --case showcase/crime-board --json                                     # rec_47892ee6f05ed4a7

# 6. HERO artifact — the multi-person contact-sheet gallery (one card per person,
#    24 face crops embedded as data-URIs; fully self-contained)
overcast cluster view --index $IDX --out showcase/crime-board/gallery.html --no-open \
  --case showcase/crime-board --json

# 7. second artifact — the relational crime board ("connect the dots"):
#    the media hub fanning out to 5 booking records -> exactly 4 person nodes,
#    plus the identify record, finding, and tldr note
overcast graph --theme csi --export showcase/crime-board/graph.html --no-open \
  --case showcase/crime-board --json          # 14 nodes / 13 edges
```

## Publish

```bash
node ~/dev/github/overcast.video/scripts/publish-case.mjs \
  --slug crime-board \
  --src  ~/.supacode/repos/overcast/case-studies/showcase/crime-board \
  --scrub ~/.supacode/repos/overcast/case-studies \
  --thumb gallery.html
# -> public/cases/crime-board/{gallery.html, graph.html, runbook.html, thumb.png}
# scrub grep file://|/Users/ : all 0
```

## Results

- **Lineup:** 74 booked faces → **4 distinct people**, one card each, zero junk:
  - `p_1` Reid Wiseman (NASA astronaut, Artemis II commander) — 20 faces, 1–39 s
  - `p_2` Victor Glover (NASA astronaut, Artemis II pilot) — 14 faces, 41–79 s
    (two separated segments; the second matched his existing person at 87–96)
  - `p_3` Christina Koch (NASA astronaut, Artemis II) — 20 faces, 81–119 s
  - `p_4` Jeremy Hansen (CSA astronaut, Artemis II) — 20 faces, 121–159 s
- **Identification:** held-out `koch-portrait-nasa.jpg` → `p_3` at **65.5/100**
  (confident, not flagged new); runner-up 3.4/100, then 2.2, 0.7.
- **Hero artifact:** `gallery.html` — 4 named person cards, 24 face crops
  embedded as base64 data-URIs, 0 external refs. Fully hostable.
- **Second artifact:** `graph.html` — CSI force-graph, 14 nodes / 13 edges:
  the presser-clip media hub fanning out to the 5 booking records → exactly the
  4 cluster-person nodes, plus the probe image → identify record → finding.
- **Published footprint:** ~1.1 MB (gallery + graph + runbook + thumb). Scrub
  grep `file://|/Users/`: all 0.

## Notes / caveats

- **Junk exclusion (the false-positive prune, moved up front):** a full-clip
  scout pass first produced 89 faces → 8 raw clusters, including two junk
  "people" with the classic detector-false-positive signatures — retinaface
  fallback boxes with `left_eye == null` (no landmarks → no alignment → noisy
  embeddings) and sub-40 px motion-blur slivers, all inside the wide-shot
  window at clip 56–68 s. Rather than booking them and pruning `faces.jsonl`
  afterwards (the previous build's approach — it leaves dead cluster ids in the
  booking records), the final booking skips that window with `--start/--end`,
  so no junk ever enters the DB and every gallery card is a real face. The
  signature test to find such clusters in any build:
  `box.left_eye == null || box.w < 40` over the index's `faces.jsonl`.
- **Threshold tuning (scout pass, scratch case):** at `--min-similarity 40`
  Hansen's first face glued onto Wiseman's person at 48 similarity; Wiseman's
  own profile-pose faces join as low as 55. 52 sits in the gap — all four stay
  separate, poses still merge. Similarities are **0–100 (percent)**, not 0–1.
- **Faces policy:** only clearly identifiable public figures (the Artemis II
  crew) were booked, from public-domain US-government footage; identities were
  visually verified before labeling/publishing. The audience/moderator portions
  of the presser were deliberately not used.
- **No profile changes.** `cluster` runs deepface directly via `OC_VISUAL_DB_PY`;
  no provider binding was touched.
