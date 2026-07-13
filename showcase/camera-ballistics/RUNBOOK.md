# Case: Camera Ballistics — "Same Camera Shot These"

**What it proves:** overcast does media forensics with zero billed calls. Every
photo a camera writes carries a device fingerprint in its EXIF — make, model,
lens, and (on many bodies) a durable serial number. `exif` lifts that fingerprint
from each file (ExifTool, free, local), `devices` rolls the case up by camera and
labels each cluster STRONG (shared body serial = same physical unit) or WEAK
(same make+model+lens = same model, which millions own), and the knowledge
`graph` renders the device node physically linking the photos.

The verdict here is real forensics on **real media**: three CC0 Golden Gate
Bridge photographs from Wikimedia Commons (Unsplash-sourced, public-domain
dedication) with their genuine, untouched EXIF. Two of the three came out of the
**same physical Canon EOS REBEL T5 body — serial `222074031107`, same
EF-S18-55mm f/3.5-5.6 IS II lens — four months apart** (2016-08-12 and
2016-12-16). The third is a different body entirely (Nikon D800, serial
`6114213`). Both Canon frames had been passed through consumer editing apps
(Snapseed 2.14 and Instagram) — and the body serial survived both, which is the
whole point of camera ballistics.

## Media provenance (staged under `showcase/_media/exif/`)

All three photos are **CC0 (public-domain dedication), Unsplash-via-Wikimedia
Commons originals** downloaded at full resolution so the EXIF is intact and real
— nothing synthetic, no injected tags:

| file | camera | serial | capture time | GPS | software |
|---|---|---|---|---|---|
| `gg-1.jpg` | Canon EOS REBEL T5 | **222074031107** | 2016:12:16 17:24:14 | — | Snapseed 2.14 |
| `gg-2.jpg` | Canon EOS REBEL T5 | **222074031107** (same body) | 2016:08:12 18:06:43 | 37.2423,-121.7604 (San Jose) | Instagram |
| `gg-3.jpg` | Nikon D800 | 6114213 | 2016:09:20 19:05:22 | — | Capture One 9 |

(Side plot the map surfaces: `gg-2` unmistakably shows the Golden Gate Bridge,
but its geotag points to San Jose ~40 mi away — a genuine geotag-vs-content
contradiction, explored further in the `scene-locate` case.)

## Run

```bash
# 0. run from the repo root; overcast auto-loads .env
cd <repo-root>
MEDIA=$PWD/showcase/_media/exif

# 1. a case is just a folder + its .overcast/ store
overcast case init --case showcase/camera-ballistics --name "Camera Ballistics"

# 2. open the line of investigation
overcast target add "same-camera link" \
  --question "Were these shot on the same camera?" \
  --case showcase/camera-ballistics
# -> tgt_e35678

# 3. lift the device fingerprint from every file (ExifTool — free, local)
overcast exif "$MEDIA/gg-1.jpg" --case showcase/camera-ballistics
overcast exif "$MEDIA/gg-2.jpg" --case showcase/camera-ballistics
overcast exif "$MEDIA/gg-3.jpg" --case showcase/camera-ballistics
# -> gg-1: Canon EOS REBEL T5 · serial 222074031107 · EF-S18-55mm · 2016:12:16
#          · sw: Snapseed 2.14 (auto-suggested editing-software lead)
# -> gg-2: Canon EOS REBEL T5 · serial 222074031107 · EF-S18-55mm · 2016:08:12
#          · GPS 37.2423,-121.7604 · sw: Instagram
# -> gg-3: NIKON D800 · serial 6114213 · 50mm f/1.4 · 2016:09:20
#          · sw: Capture One 9 (auto-suggested editing-software lead)

# 4. roll the case up by camera fingerprint; --findings emits a suggested
#    finding for the serial-linked (STRONG) cluster
overcast devices --findings --case showcase/camera-ballistics
# -> 1 cluster: serial:222074031107 · strength "serial" · 2 members (gg-1 + gg-2)
#    total_exif: 3 · linked_media: 2 (the Nikon frame stands alone)

# 5. triage: promote the serial-link lead to evidence, stamped onto the line
overcast finding accept rec_a17e62ec68b2f3ba --target tgt_e35678 \
  --case showcase/camera-ballistics
# (the two editing-software leads stay in the triage queue — visible in the brief)

# 6. narrate the thread + verdict, close the answered line
overcast note "Camera ballistics confirmed: gg-1.jpg ... and gg-2.jpg ... SAME \
physical Canon EOS REBEL T5 body — serial 222074031107 ... four months apart. \
gg-3.jpg is a different camera (Nikon D800, serial 6114213). Serial numbers \
survive editing apps." --tag tldr --confidence high --case showcase/camera-ballistics
overcast note "Serial 222074031107 appears in two frames captured 2016:08:12 and \
2016:12:16 — a durable device link across a four-month gap." \
  --ref rec_a17e62ec68b2f3ba --tag thread:tgt_e35678 --confidence high \
  --case showcase/camera-ballistics
overcast target close tgt_e35678 --as answered \
  --note "Yes — gg-1 and gg-2 share Canon T5 body serial 222074031107 (strong \
device link); gg-3 is a different body (Nikon D800)." \
  --case showcase/camera-ballistics

# 7. export the visual artifacts (all self-contained HTML)
overcast graph --theme csi --no-open --export showcase/camera-ballistics/graph.html --case showcase/camera-ballistics
overcast map   --theme csi --no-open --export showcase/camera-ballistics/map.html   --case showcase/camera-ballistics
overcast brief --theme csi           --export showcase/camera-ballistics/brief.html --case showcase/camera-ballistics
```

## What each artifact shows

- **graph.html** (hero) — the case knowledge graph: one `device` node
  (`Canon EOS REBEL T5 · serial 222074031107`) hub-linking the two Canon photo
  records, plus the accepted serial-link finding, the answered line of
  investigation, the San Jose place node, and the lifted serial entity. The
  Nikon record sits apart — no device edge. The device edge IS the forensic
  conclusion. (13 nodes, 11 edges.)
- **map.html** — the one geotagged frame (gg-2) pinned at its EXIF coordinates
  (37.2423, -121.7604 — San Jose, despite the Golden Gate in-frame), the marker
  linking back to its `exif` record with thumbnail and capture time.
- **brief.html** — the mission brief: analyst verdict up top, the answered
  same-camera line with its accepted finding, the two editing-software leads
  still in the triage queue, and the newest-first record trail. The CC0 photo
  thumbnails render inline.

## Honesty notes

- Shared **serial** = STRONG (that exact camera body). Shared make+model+lens
  without a serial would only be WEAK (same model) — `devices` labels which, and
  only serial clusters auto-suggest findings.
- The editing-software fields (Snapseed, Instagram, Capture One) are re-save
  **leads**, not proof of manipulation.
- EXIF is untrusted input: serials can be spoofed or carried across re-saves;
  cross-check a strong link with content before concluding.

No API keys used: ExifTool is local, and `devices`/`graph`/`map`/`brief` are
pure reads over the case store. Zero network egress (no `--geocode` this run).
