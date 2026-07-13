# Case: The Geotag Lies — scene-locate

**What it proves:** a geotag is a claim, not a fact — and overcast can catch it
lying. The subject is a REAL photo (`showcase/_media/exif/gg-2.jpg`, CC0 —
Unsplash via Wikimedia Commons, original EXIF intact): a fog-shrouded
International Orange suspension tower that is unmistakably the **Golden Gate
Bridge**. Its EXIF, though, pins it to **37.2423, -121.7604 — the hills SE of
San Jose, ~40 miles away** — with an `Instagram` software tag betraying a
re-save. The funnel runs metadata → VLM scene read → OSM ground truth at BOTH
coordinates → reverse image search → sun/shadow math, and lands on a two-part
verdict: the WHERE is wrong, the WHEN checks out. The map is the punchline —
one pin in the San Jose hills surrounded by freeway undercrossings, and 40 mi
NW the bridge itself (OSM: `bridge:structure=suspension`, `colour=#f04a00`)
ringed by 15 tourist viewpoints, with the chronolocate point on top.

**Media provenance:** `gg-2.jpg` is CC0 (Unsplash-era upload re-hosted on
Wikimedia Commons), Canon EOS REBEL T5 serial `222074031107`, captured
2016:08:12 18:06:43, GPS + software tags as shipped in the original file —
nothing was synthesized or edited for this case.

## Run

```bash
# 0. rebuild from scratch
overcast case clear --case showcase/scene-locate --yes
overcast case init --case showcase/scene-locate --name "Where Was This Shot? (and When)"

# 1. metadata first — ExifTool GPS, capture time, device, editing software
overcast exif showcase/_media/exif/gg-2.jpg --case showcase/scene-locate
# → GPS 37.2423,-121.7604 (San Jose!) · Canon EOS REBEL T5 · 2016:08:12 18:06:43
#   · sw:Instagram · serial 222074031107 · lens EF-S18-55mm

# 2. open the line of investigation
overcast target add "Where was gg-2.jpg actually taken — and does its geotag + timestamp hold up?" \
  --question "The EXIF pin (37.2423,-121.7604, San Jose) matches what the pixels show — or the geotag is wrong and the true location can be corroborated" \
  --case showcase/scene-locate                                # → tgt_5a77b2

# 3. read the scene with the brain VLM (cloudglue)
overcast see showcase/_media/exif/gg-2.jpg \
  --prompt "Where could this be? Identify any landmark precisely. Describe the structure, its color and architecture, weather/light conditions, terrain, and any location clues." \
  --case showcase/scene-locate
# → "highly consistent with the Golden Gate Bridge": International Orange,
#   Art Deco tower legs + portal bracing, marine-layer fog. No OCR-able text.

# 4. OSM ground truth at BOTH coordinates (keyless Overpass API)
overcast source add 'overpass:man_made=bridge@around:2000,37.2423,-121.7604' --case showcase/scene-locate  # the claimed pin
overcast source add 'overpass:man_made=bridge@around:1500,37.8199,-122.4783' --case showcase/scene-locate  # the candidate
overcast source add 'overpass:tourism=viewpoint@around:2000,37.8199,-122.4783' --case showcase/scene-locate
overcast scan --source overpass --limit 25 --case showcase/scene-locate
# → at the geotag: Bernal Road Undercrossing, a creek, a 101/85 HOV separation — freeway concrete only
# → at the candidate: way 370672707 "Golden Gate Bridge", bridge:structure=suspension,
#   colour=#f04a00 (International Orange), + 15 named viewpoints (Fort Point, Battery East…)
# (overpass-api.de intermittently 406s on one mirror — retry the scan; it round-robins clean)

# 5. reverse image search (Apify) — where does this image actually live?
overcast source add "lens:showcase/_media/exif/gg-2.jpg" --case showcase/scene-locate
overcast scan --source lens --limit 12 --case showcase/scene-locate
# → Google Lens: ZERO matches on the fog shot (first run timed out at 240 s, retries returned [])
overcast source add "yandeximg:showcase/_media/exif/gg-2.jpg" --case showcase/scene-locate
overcast scan --source yandeximg --limit 12 --case showcase/scene-locate
# → Yandex: "File:Above Golden Gate Bridge (Unsplash).jpg — Wikimedia Commons" (the source
#   family of this photo) + a Golden Gate tour page; zero San Jose hits

# 6. CHRONOLOCATION — is the claimed WHEN consistent? (offline solar math, no key)
overcast chronolocate <exif-record-id> --lat 37.8199 --lng -122.4783 \
  --at-time "2016-08-12T18:06:43-07:00" --case showcase/scene-locate
# → daylight:true · sun 22.4° up, bearing 271.5° (due west) · expected shadows 91.5° at 2.5:1
#   · solar time 16:51. A bright, fog-diffused frame fits a summer evening; fog hides
#   shadows, so the bearing check is inconclusive — NOT contradicted. WHERE lied; WHEN holds.

# 7. analyst layer — findings on the line, thread notes, verdict, close
overcast finding create "Geotag contradicts the pixels: … only freeway undercrossings near the pin" --ref <see-rec> --confidence high --target tgt_5a77b2 --case showcase/scene-locate
overcast finding create "True location corroborated: Golden Gate Bridge (37.8199,-122.4783) …" --ref <osm-bridge-rec> --confidence high --target tgt_5a77b2 --case showcase/scene-locate
overcast finding create "Timestamp is sun-consistent: sun 22.4° up bearing 271.5° at 18:06 PDT …" --ref <chronolocate-rec> --confidence medium --target tgt_5a77b2 --case showcase/scene-locate
overcast target close tgt_5a77b2 --as answered --note "Photo = Golden Gate Bridge; geotag (San Jose) wrong; timestamp sun-consistent." --case showcase/scene-locate
overcast note "Verdict: geotag says San Jose, pixels say Golden Gate. …" --tag tldr --case showcase/scene-locate

# 8. artifacts — the map is the punchline (both pins, 44 points)
overcast map --theme csi --no-open --export showcase/scene-locate/map.html --case showcase/scene-locate
overcast brief --theme csi --export showcase/scene-locate/brief.html --case showcase/scene-locate
```

## Signals scoreboard

| signal | verb | says |
|---|---|---|
| EXIF metadata | `exif` | GPS = San Jose hills; **Instagram** software tag; Canon T5 serial `222074031107` |
| Scene read | `see` (brain VLM, cloudglue) | "highly consistent with the **Golden Gate Bridge**" — Int'l Orange, Art Deco, marine fog |
| OSM at the geotag | `scan` overpass (keyless) | only freeway undercrossings + a creek — no suspension bridge within 2 km |
| OSM at the bridge | `scan` overpass (keyless) | way 370672707 = suspension bridge, `colour=#f04a00`, + 15 viewpoints |
| Reverse image | `scan` yandeximg (Apify) | Wikimedia Commons "Golden Gate Bridge (Unsplash)" page; **zero San Jose hits** (Lens: no matches) |
| Sun/shadow | `chronolocate` (offline) | 18:06 PDT → sun 22.4° up, due west — daylight fog scene fits; WHEN holds |

**Verdict:** the photo is the Golden Gate Bridge; the geotag (San Jose,
~40 mi away) is wrong — an artifact of the file's Instagram-era handling, not
the scene. The 2016-08-12 18:06 PDT timestamp is sun-consistent.

## Artifacts

- `map.html` — the false San Jose pin (exif + its freeway-undercrossing
  surroundings) AND the true Golden Gate cluster (the OSM bridge way, 15
  viewpoints, the chronolocate point) on live OSM tiles — 44 markers, each
  linking back to its record. The 40-mile contradiction is visible at a glance.
- `brief.html` — the CSI-themed case brief: verdict, the closed line of
  investigation with its 3 findings + thread, coverage table, record trail.

Both are exported verbatim by the CLI. The only post-processing for hosting is
the path scrub in the site's `scripts/publish-case.mjs`.
