# paris-sources — one topic, every source

One subject — "Paris" — swept across six overcast source providers in a single
pass: Tavily web search, TikTok, X, live ADS-B flights over CDG/Orly, Windy
webcams around the city center, and OpenStreetMap attractions via Overpass.
79 hits in one sweep, 30 of them GPS-bearing (5 aircraft positions — including a
three-point RJA268 track crossing Paris eastbound — plus 25 OSM features) that
plot straight onto one case map. The brief's coverage table is the point: every
source, its ref, last-scan freshness, and hit count in one table. This is the
breadth demo — the same `source add` / `scan` machinery, six very different
backends, one record contract.

All commands run from the repo root (creds auto-load from `.env`), isolated with
`--case showcase/paris-sources`.

```bash
# 1. Case
overcast case init --case showcase/paris-sources --json

# 2. Register the sources (one topic, six providers)
overcast source add "web:Paris"                       --name "Web search: Paris"                     --case showcase/paris-sources --json
overcast source add "tiktok:#paris"                   --name "TikTok #paris"                         --case showcase/paris-sources --json
overcast source add "x:Paris"                         --name "X search: Paris"                       --case showcase/paris-sources --json
overcast source add "flights:2.10,48.75,2.55,48.95"   --name "ADS-B over Paris (CDG/Orly)"           --case showcase/paris-sources --json
overcast source add "webcam:48.8566,2.3522,50"        --name "Windy webcams near Paris center"       --case showcase/paris-sources --json
overcast source add "overpass:tourism=attraction@around:2500,48.8566,2.3522" \
                                                      --name "OSM attractions around Paris center"   --case showcase/paris-sources --json

# 3. Sweep — one scan per source (limits kept modest)
overcast scan --source web      --limit 10 --case showcase/paris-sources --json   # 10 hits
overcast scan --source tiktok   --limit 12 --case showcase/paris-sources --json   # 12 hits
overcast scan --source x        --limit 12 --case showcase/paris-sources --json   # 12 hits
overcast scan --source webcam   --limit 15 --case showcase/paris-sources --json   # 15 hits
overcast scan --source flights  --limit 25 --case showcase/paris-sources --json   # polled 3x (~3 AM Paris,
                                                                                  # quiet airspace) -> 5 positions,
                                                                                  # 2 aircraft, one 3-point track
overcast scan --source overpass --limit 25 --case showcase/paris-sources --json   # 25 hits (the public
                                                                                  # overpass-api.de instance throttles
                                                                                  # intermittently with HTTP 406 —
                                                                                  # wait ~40s and rescan)

# 4. Analyst verdict for the brief
overcast note "One subject, every source: a single 'Paris' sweep across six providers — Tavily web search (10), TikTok #paris (12), X keyword search (12), live ADS-B flights over CDG/Orly (5, incl. a 3-point RJA268 track), Windy webcams (15), and OSM attractions via Overpass (25) — returned 79 hits in one pass, 30 of them GPS-bearing and plotted straight onto the case map. Webcam hits carry coordinates in-payload but not payload.gps, so they list in the coverage table rather than pin on the map." \
  --tag tldr --title "Paris source sweep — final tally" --case showcase/paris-sources

# 5. Artifacts (map + brief)
overcast map   --theme csi --no-open --export showcase/paris-sources/map.html   --case showcase/paris-sources --json
overcast brief --theme csi           --export showcase/paris-sources/brief.html --case showcase/paris-sources --json

# 6. Video/feed hero — pull the social-VIDEO results into the case, then snapshot
#    the live `situation` page (video wall + reverse-chron source feed).
# 6a. Capture ~8 of the TikTok video hits already in the case (any of the tiktok:
#     scan.hit URLs; each downloads via the tiktok source provider).
overcast capture "https://www.tiktok.com/@paris.in.mood/video/7619057607319325974"        --case showcase/paris-sources --json
overcast capture "https://www.tiktok.com/@lolatraveltheworldwithme/video/7661352162294811934" --case showcase/paris-sources --json
overcast capture "https://www.tiktok.com/@katemaries/video/7618154564432268575"           --case showcase/paris-sources --json
overcast capture "https://www.tiktok.com/@juliasingerr/video/7603548609266732301"         --case showcase/paris-sources --json
overcast capture "https://www.tiktok.com/@paris.in.mood/video/7648916793830018337"        --case showcase/paris-sources --json
overcast capture "https://www.tiktok.com/@achileneinspire/video/7660234504564428063"      --case showcase/paris-sources --json
overcast capture "https://www.tiktok.com/@maniknish/video/7654952501086604566"            --case showcase/paris-sources --json
overcast capture "https://www.tiktok.com/@paris.in.mood/video/7629354267760938262"        --case showcase/paris-sources --json
# (clips were then trimmed to a short ~6s window each — brightest moment, no audio —
#  to keep them SHORT and rights-light, and so every wall tile shows content.)

# 6b. Serve the live situation page over the case, wall + feed panels (operator/CLI
#     only — blocks; prints a token pairing URL). Screenshot it, then stop.
overcast situation serve --case showcase/paris-sources --panels wall,feed --no-open --theme csi
#   -> screenshot the printed http://127.0.0.1:PORT/#t=... URL (scripts/shoot.mjs, --wait 9000)
overcast situation stop  --case showcase/paris-sources --force
```

## Result

| source | ref | hits | gps |
| --- | --- | ---: | ---: |
| web (Tavily) | `web:Paris` | 10 | — |
| tiktok (Apify) | `tiktok:#paris` | 12 | — |
| x (Apify) | `x:Paris` | 12 | — |
| flights (OpenSky, keyless) | `flights:2.10,48.75,2.55,48.95` | 5 | 5 |
| webcam (Windy) | `webcam:48.8566,2.3522,50` | 15 | — |
| overpass (OSM, keyless) | `overpass:tourism=attraction@around:2500,48.8566,2.3522` | 25 | 25 |
| **total** | | **79** | **30** |

- `map.html` — 30 pins over Paris: the RJA268/SRR6646 aircraft positions ringing
  the city plus 25 OSM attractions dense in the center. Self-contained HTML
  (inlined JS; OSM raster tiles fetched by the browser at view time).
- `brief.html` — verdict (tldr note) + the six-row coverage table + the full
  newest-first record trail.
- `wall.png` / `wall.html` — the hero: a snapshot of the live `situation` page over
  this case (panels `wall,feed`). The top is a control-room **video wall** of the
  eight captured TikTok clips looping at their moments; the bottom is a
  reverse-chronological **feed** of the whole mixed sweep with per-source badges
  (OSM · Flights · X · TikTok · Webcam). Video + feed — deliberately *not* a map.

## Caveats

- Webcam hits carry `lat`/`lng` as flat payload fields, not `payload.gps{lat,lng}`,
  so they don't pin on `map` (in overcast 0.0.8 the scan layer does not lift them);
  they still count in coverage. The overpass source was added to give the hero map
  real Paris-center pins.
- Flights were scanned at ~3 AM Paris time — quiet airspace; three polls
  accumulated 5 positions. A daytime sweep of the same bbox returns dozens.
- overpass-api.de intermittently returns HTTP 406 under rapid requests; one retry
  after a cooldown succeeded with a full 25 hits.
