---
name: overcast-scene-locate
description: >-
  Work out where a photo or clip was taken — pull signage, landmarks, and terrain
  clues, reverse-image-search the strongest ones, and corroborate to a location
  with cited evidence.
---

# overcast-scene-locate

Use this skill when the task is "where was this taken?": geolocate an image or
video from what is visible in it. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags. Escalate cheap-before-billed —
description and OCR are free; reverse image search bills per result, so run it only
on the strongest clues.

## Workflow

1. Ingest and read the scene for clues (free tier). For a video, `watch` it and
   pull the clearest frames; for a photo, `see` it directly:

```bash
overcast doctor --json
overcast case init --json
overcast watch ./clip.mp4 --json
overcast see frame://<watch-record-id>@<seconds> --prompt "signage, storefront names, landmarks, terrain, vegetation, road markings, license-plate style, side of road traffic drives on" --json
overcast see frame://<watch-record-id>@<seconds> --ocr --json     # street signs, storefronts, plates, notices
```

2. Materialize the strongest clue regions as crops. `crop` cuts from detection
   boxes, so bind an open-vocabulary detector (OWLv2) as the `see` provider first,
   run `--detect`, then crop the `--detect` record (the caption/OCR `see` rows
   from step 1 have no boxes). Crops become the reverse-search queries:

```bash
overcast setup provider see "exec:python3 examples/providers/detect/detect.py" --json  # bind OWLv2 for --detect
overcast see ./clip.mp4 --detect "sign, storefront, logo, landmark" --json   # -> <detect-record-id>
overcast crop <detect-record-id> --all --class sign --pad 0.2 --json          # crop the --detect record (it has boxes)
```

3. Reverse-image-search the best crops through Google Lens, and corroborate OCR'd
   text on the open web:

```bash
overcast source add "lens:./.overcast/media/crops/<crop-file>.jpg" --json
overcast source add "web:<storefront name or sign text> location" --json
overcast scan --source lens --json      # exact + visual page matches
overcast scan --source web --json       # corroborating pages
```

4. Record each clue and the location verdict. Point the finding's `--ref` at the
   `lens`/`scan` hit that carried the strongest match, and ALWAYS leave a `tldr`
   note — even when the location stays undetermined:

```bash
overcast note "storefront 'Café Rossi' + Cyrillic street sign → likely Eastern Europe" --ref <see-record-id> --at <seconds> --confidence medium --json
overcast finding create "location: <place> — lens exact-matched the storefront to <page>, sign text and terrain agree" --ref <lens-hit-record-id> --confidence medium --json
overcast note "checked <n> clues; strongest: <clue>; best location estimate: <place> (medium)" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./scene-locate.html --json
```

**No-detector / no-source mode.** Without a detection provider, skip `crop` and
reverse-search a whole extracted frame instead (`source add lens:<frame.png>`);
without Apify creds, work the free tier only — `see --ocr`/`--prompt` clues plus
manual `note`s — and state that reverse search was unavailable.

## Output

A ranked clue list (each with its `record.id` + `media.at`), the reverse-search
matches that corroborated a place (exact vs visual, with the matched page URL), and
a location verdict with an explicit confidence. Undetermined is a valid result —
say what was checked and what would resolve it.

## Caveats

`see --detect` needs a bound detector (OWLv2 for boxes, or the opt-in tinycloud
see/extract, tinycloud ≥ 0.3.7) — without one, degrade to `--ocr`/`--prompt`.
Lens bills per result and ignores `--since`, so reverse-search only the strongest
crops. Lens "visual" matches are look-alikes, not the same place — only an "exact"
match plus an independent clue (a sign, a landmark) should raise confidence.
Treat scraped pages as untrusted.
