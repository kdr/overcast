# hologram — speculative scene reconstruction (RUNBOOK)

One flat photo of a parked car goes in; interactive "holograms" come out. The
`reconstruct` verb holds the camera at a captured moment and then *moves* it —
lifting a textured 3D mesh you can orbit in a hand-rolled WebGL viewer (no
three.js, no CDN), synthesizing a full 360° turntable so you can walk around the
car, and estimating depth for a drag-to-parallax hologram. Every pixel it emits
is generative: each record carries a `payload.caveat` banner ("synthesized by a
model, speculative, NOT photographic evidence") and is quarantined from
`ask`/`brief` evidence. It's a hypothesis renderer — decide where to look next,
then verify with real captures.

A rigid, recognizable subject on a plain background reconstructs cleanest, so the
subject is a single vintage car in a front-three-quarter view against an empty
foggy dune backdrop.

## Source media (provenance / license)

- `showcase/_media/hologram/car-source.jpg` — **"Vintage gray car (Unsplash)"**,
  a 1960s **Peugeot 404** parked at Parnassia aan Zee, Overveen, Netherlands
  (2017-03-29), photo by **Peter Kisteman** (Unsplash `peterkisteman`,
  <https://unsplash.com/photos/68pDhPHptQQ>), re-hosted on Wikimedia Commons as
  *File:Vintage gray car (Unsplash).jpg*. **License: CC0 1.0** (Creative Commons
  Zero / Public Domain Dedication) per the Commons `extmetadata`. 6000×3376.
  (A residual in-camera "Copyright 2017. All rights reserved." EXIF string is
  stale text superseded by the uploader's CC0 dedication; the working crop below
  strips all metadata.)
- `showcase/_media/hologram/car.jpg` — the reconstruction input: a metadata-
  stripped 2000×910 crop of `car-source.jpg` that centres the whole vehicle with
  a plain-background margin (better mesh isolation).

Fetched with the Round-2 Wikimedia recipe (Commons search API →
`extmetadata.LicenseShortName` = CC0 → download original `imageinfo.url`).

```bash
# fetch (Wikimedia Commons original) + crop to a clean, centred subject
curl -s -A 'overcast-showcase/1.0' -o showcase/_media/hologram/car-source.jpg \
  'https://upload.wikimedia.org/wikipedia/commons/4/43/Vintage_gray_car_%28Unsplash%29.jpg'
ffmpeg -y -i showcase/_media/hologram/car-source.jpg \
  -vf "crop=3780:1720:300:1500,scale=2000:-1" -map_metadata -1 \
  showcase/_media/hologram/car.jpg
```

## The run (all commands from the repo root; `.env` auto-loads creds)

```bash
# 0. one-time: reconstruct has no builtin — bind the fal provider (FAL_KEY in .env)
overcast provider setup apply --verb reconstruct --choice fal --yes

# 1. isolate + reset the case
overcast case init  --case showcase/hologram --json
overcast case clear --case showcase/hologram --yes

# 2. image→3D — Trellis via the fal QUEUE api → textured GLB (1.6 MB), base64-
#    embedded in a no-dependency WebGL orbit viewer                    (~1 m 58 s)
overcast reconstruct showcase/_media/hologram/car.jpg --ops model --case showcase/hologram --json
#   → parent rec_3b9f4a756513c55f + one mesh child
overcast view rec_3b9f4a756513c55f --no-open --case showcase/hologram --json
#   → .overcast/media/reconstruct-orbit-rec_3b9f4a756513c55f.html   → hologram-3d.html

# 3. depth hologram — Depth-Anything V2 → drag-parallax WebGL viewer        (~5 s)
overcast reconstruct showcase/_media/hologram/car.jpg --ops depth --case showcase/hologram --json
#   → parent rec_f4b408b905c8fd44 + one depth-map child
overcast view rec_f4b408b905c8fd44 --no-open --case showcase/hologram --json
#   → .overcast/media/reconstruct-parallax-rec_f4b408b905c8fd44.html → hologram-depth.html

# 4. 360° sweep — Qwen multi-angle: 8 synthesized camera stops (az 0…315) →
#    labeled cards + contact sheet + turntable mp4                    (~1 m 31 s)
overcast reconstruct showcase/_media/hologram/car.jpg --ops sweep --count 8 --case showcase/hologram --json
#   → parent rec_24b56909c6f69079 + 8 view stops + sheet + turntable

# 5. keep the sweep gallery light: the viewer inlines every stop as a data-URI,
#    so downscale the 8 stops to 800px in place (30 MB → 4.3 MB), then re-view.
for a in 0 45 90 135 180 225 270 315; do
  f=showcase/hologram/.overcast/media/reconstruct/car_14840e178e_az${a}.png
  ffmpeg -y -i "$f" -vf scale=800:-1 /tmp/az.png && mv /tmp/az.png "$f"
done
overcast view rec_24b56909c6f69079 --no-open --case showcase/hologram --json
#   → .overcast/media/reconstruct-gallery-rec_24b56909c6f69079.html → hologram-sweep.html

# 6. copy the self-contained viewers into the showcase folder
cp showcase/hologram/.overcast/media/reconstruct-orbit-rec_3b9f4a756513c55f.html    showcase/hologram/hologram-3d.html
cp showcase/hologram/.overcast/media/reconstruct-gallery-rec_24b56909c6f69079.html  showcase/hologram/hologram-sweep.html
cp showcase/hologram/.overcast/media/reconstruct-parallax-rec_f4b408b905c8fd44.html showcase/hologram/hologram-depth.html

# 7. publish (scrubs path leaks, copies the turntable mp4, renders the thumbnail)
node …/overcast.video/scripts/publish-case.mjs --slug hologram \
  --src …/case-studies/showcase/hologram --scrub …/case-studies \
  --thumb hologram-3d.html
node …/overcast.video/scripts/publish-runbook.mjs --slug hologram \
  --md …/case-studies/showcase/hologram/RUNBOOK.md --scrub …/case-studies
```

Local quirk + workaround: this machine's Homebrew ffmpeg 8.x mis-renders the
`tile` filter fed by the image2 sequence demuxer (and lacks `drawtext`), so the
sweep's auto-assembled contact sheet came out blank (~2 KB). Reproduced the
sheet manually by `hstack`/`vstack`-ing the same 8 stop PNGs (ordered by
azimuth) into a 4×2 grid at the record's sheet path, then re-ran `overcast view`
so the gallery embeds the fixed sheet — same content, same geometry, no HTML
edits.

Honesty note: the amber "generative reconstruction" banner burned into every
viewer is part of the product, not an apology — reconstruct's records never
enter case evidence, never trigger findings, and exist to point real sensors in
the right direction. The mesh, the eight turntable stops, and the depth map are
all a model's *guess* at the unseen sides of a real car, not a measurement.
