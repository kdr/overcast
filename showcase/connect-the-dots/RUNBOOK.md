# connect-the-dots — showcase runbook

Two unrelated clips land in a case: a comedy-podcast excerpt and a ~30s screen
recording of someone browsing a news site. Two lines of investigation are opened
(who is the speaker? what is being browsed?), the media is run through the senses
(`watch`, `listen`, `see`), analyst notes and findings are stamped onto the
targets — and then ONE command strings the whole board: `overcast graph --extract`
builds the case knowledge graph, lifting typed entities (Bobby Lee, Hacker News,
Cursor, usernames, locations) out of the evidence text with the brain LLM and
wiring every edge back to the record that proves it. 60 nodes, 82 edges, one
self-contained HTML force-graph — no CDN, no egress.

## Commands (in order)

```bash
cd ~/.supacode/repos/overcast/case-studies   # creds auto-load from .env

# 1. Case + lines of investigation
overcast case init --case showcase/connect-the-dots --json                 # case_4e17d61b
overcast target add "Who is speaking in the podcast clip and what identities/handles do they reference?" \
  --case showcase/connect-the-dots --json                                  # tgt_f82f60
overcast target add "What sites, stories, and usernames appear in the screen-recording browsing session?" \
  --case showcase/connect-the-dots --json                                  # tgt_d8979b

# 2. Ingest real media (cloudglue sense backend)
overcast watch  "$OC_VIDEO_VISUAL" --case showcase/connect-the-dots --json # rec_a84034dcc28d3c2b (Hacker News session)
overcast listen "$OC_VIDEO_SPEECH" --case showcase/connect-the-dots --json # rec_2177c3fdeca64c68 (Bobby Lee podcast)
overcast see    "$OC_IMAGE"        --case showcase/connect-the-dots --json # rec_b7b2893414526de2 (construction-site still)

# 3. Analyst notes anchored to the evidence
overcast note "Screen recording confirms a Hacker News browsing session: front-page stories on macOS menu bar customization and AI coding tools; commenter usernames visible in threads. Supports the browsing-session line of investigation." \
  --ref rec_a84034dcc28d3c2b --tag "thread:tgt_d8979b" --confidence high --case showcase/connect-the-dots --json
overcast note "Still image shows an urban construction/road-work site near a residential building — context material only, no identity content." \
  --ref rec_b7b2893414526de2 --confidence medium --case showcase/connect-the-dots --json
overcast note "Speech clip is a two-speaker comedy podcast exchange; one speaker self-identifies as Korean (public figure Bobby Lee), correcting repeated Chinese/Mongolian misidentification. Anchors the who-is-speaking line." \
  --ref rec_2177c3fdeca64c68 --tag "thread:tgt_f82f60" --confidence high --case showcase/connect-the-dots --json
overcast note "Two threads, one board: the podcast clip resolves to Bobby Lee (Korean, self-identified on tape); the screen capture resolves to a Hacker News session (macOS menu-bar + AI-coding threads). Both lines answered; graph shows the media hubs and lifted entities tying them to their findings." \
  --tag tldr --confidence high --case showcase/connect-the-dots --json

# 4. Findings stamped onto the lines of investigation (finding→source + finding→target edges)
overcast finding create "Speaker in the podcast clip self-identifies as Korean and is Bobby Lee (public figure); transcript repeatedly corrects Chinese/Mongolian misattribution." \
  --ref rec_2177c3fdeca64c68 --target tgt_f82f60 --confidence high --case showcase/connect-the-dots --json
overcast finding create "Browsing session is on news.ycombinator.com: front-page threads on macOS menu bar spacing and AI coding agents/editors, with commenter usernames visible in the discussions." \
  --ref rec_a84034dcc28d3c2b --target tgt_d8979b --confidence high --case showcase/connect-the-dots --json

# 5. Hero artifact: the knowledge graph with the opt-in LLM entity/relation pass
overcast graph --theme csi --extract --no-open \
  --export showcase/connect-the-dots/graph.html --case showcase/connect-the-dots --json
# → 60 nodes / 82 edges / 2 components
#   by_type: record 7 · media 3 · finding 2 · target 2 · entity 46
#   --extract: 41 entities + 19 relations over 7 evidence records (cached to .overcast/graph/extract.jsonl)
#   entity types: person 5 · username 6 · org 8 · location 3 · domain 2 · url 3 · event 2 · vehicle 1 · other 16

# 6. Companion brief
overcast brief --export showcase/connect-the-dots/brief.html --theme csi \
  --case showcase/connect-the-dots --json
```

## Published artifacts

- `graph.html` — the interactive knowledge graph (hand-rolled canvas force layout,
  all JS inlined, zero remote refs; pan/zoom/drag, per-type toggles, text filter,
  node inspector). Fully self-contained.
- `brief.html` — CSI-theme mission brief: verdict, one story per line of
  investigation, findings, coverage, record trail.
- `thumb.png` — Chrome render of the graph.

## Notes

- `--extract` is the opt-in brain-LLM pass (BYO; cloudglue serves as brain here).
  Every extracted node/edge carries `payload.caveat` — leads, not proof; the viewer
  banner says so.
- `graph` is operational: it stays out of ask/brief evidence. The findings are what
  carry the confirmed links into the brief.
- No profile bindings were changed; only the public-figure speech fixture was used
  (no identity/PII sources).
