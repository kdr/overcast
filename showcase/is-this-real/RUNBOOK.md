# Case: Is This Real? — media authenticity funnel (real media)

**What it proves:** overcast runs the whole "is this photo real?" funnel locally
on a REAL, real-world-edited photograph — and stays honest about what each
signal can and cannot say. `verify` reads C2PA / Content Credentials (system
`c2patool`) and teaches the most important lesson in provenance: **most media
carries no cryptographic manifest at all**, and overcast reports that as a
clean `ready` record (`has_manifest: false`), never as a fake-flag. `exif`
lifts the capture metadata (ExifTool): device fingerprint, capture time, and
the editing-software field — here a *genuine* `Snapseed 2.14` tag, left behind
when the photographer re-saved the frame through Google's mobile editor —
which auto-fires a "possibly edited" suggested finding. `enhance --ops ela`
derives three forensic overlays (ELA recompression error, sensor-noise
residual, luminance gradient) that make spliced regions light up. **ELA is a
heuristic LEAD, not proof**, and the flow treats it that way: you look at the
overlays, weigh the accumulated signals, and say exactly how far the evidence
goes.

**Subject media (real, CC0):** `showcase/_media/exif/gg-1.jpg` — an aerial
photo of the Golden Gate Bridge (4623x2942), CC0 Unsplash-via-Wikimedia
Commons, original file with its real EXIF intact: Canon EOS REBEL T5, body
serial `222074031107`, lens EF-S18-55mm f/3.5-5.6 IS II, captured
`2016:12:16 17:24:14`, no GPS, **Software: Snapseed 2.14.141428617** — a real
mobile-edit re-save, not a planted fixture. (Its sibling `gg-2.jpg` — same
camera body — belongs to the scene-locate and camera-ballistics cases.)

**The verdict this run reached:** gg-1.jpg is **edited but not fabricated, as
far as checked** (medium confidence). Positive edit signal: the genuine
Snapseed EXIF tag (global tone/color re-save). No C2PA manifest — the common
case, proves nothing either way. All three forensic overlays are consistent
with a *global* edit, not a splice: ELA response follows scene detail only
(bridge cables, skyline, boat wakes — classic edge response), the noise floor
is homogeneous across sky/water/city, and the luminance-gradient edges run
unbroken with no feathered seam or localized recompression patch. A
calibration exhibit (a copy test-signed with c2patool's dev cert) shows what
*positive* provenance looks like: `has_manifest:true · C2PA Test Signing
Cert · Valid`, whose declared ingredient auto-fires its own suggested finding.

## Run

```bash
# 0. run from the repo root; overcast auto-loads .env
cd <repo-root>

# 1. a case is just a folder + its .overcast/ store (rebuild: clear first)
overcast case clear --case showcase/is-this-real --yes

# 2. open the line of investigation
overcast target add "Is gg-1.jpg (aerial Golden Gate Bridge photo) an authentic, unedited capture?" \
  --case showcase/is-this-real            # -> tgt_91234e

# 3. C2PA / Content Credentials provenance (system c2patool; brew install c2patool)
overcast verify showcase/_media/exif/gg-1.jpg --case showcase/is-this-real
# -> has_manifest:false — "no content credentials (no C2PA manifest)" — a clean
#    ready record: NO manifest is the common case, not proof of fakery

# 3b. positive control: sign a copy with c2patool's built-in dev test cert
cat > /tmp/manifest.json <<'EOF'
{
  "claim_generator": "overcast-showcase-demo/0.1",
  "assertions": [
    { "label": "c2pa.actions",
      "data": { "actions": [ { "action": "c2pa.edited",
        "softwareAgent": "overcast showcase (test-signed demo copy)" } ] } }
  ]
}
EOF
mkdir -p showcase/is-this-real/exhibits
c2patool showcase/_media/exif/gg-1.jpg -m /tmp/manifest.json \
  -o showcase/is-this-real/exhibits/gg-1-signed.jpg
overcast verify "$PWD/showcase/is-this-real/exhibits/gg-1-signed.jpg" \
  --case showcase/is-this-real
# -> has_manifest:true · signer "C2PA Test Signing Cert" · Valid — and the
#    manifest's declared ingredient auto-fires a SUGGESTED finding (triage queue)

# 4. capture metadata (system exiftool) — the REAL editing-software signal
overcast exif showcase/_media/exif/gg-1.jpg --case showcase/is-this-real
# -> 104 tags: Canon EOS REBEL T5 · serial 222074031107 · lens EF-S18-55mm ·
#    2016:12:16 17:24:14 · no GPS · sw:Snapseed 2.14.141428617 — the genuine
#    mobile re-save tag auto-fires a "possibly edited" suggested finding

# 5. ELA / noise / luminance forensic overlays — a provider-only enhance op;
#    bind the shipped local script (pillow + numpy, no API key) in a throwaway
#    profile so the shared default profile stays untouched
overcast setup provider enhance \
  "exec:<python-with-pillow-numpy> $PWD/examples/providers/enhance/ela.py" \
  --profile showcase-ela
overcast enhance showcase/_media/exif/gg-1.jpg --ops ela \
  --profile showcase-ela --case showcase/is-this-real
# -> 1 parent (rec_7586c22ca77a3b8d) + 3 fanned-out children: *_ela.png,
#    *_noise.png, *_luminance.png. LOOK at them (heuristic leads, not verdicts):
#    ELA lights up only on scene edges (cables/skyline/wakes), noise floor is
#    one homogeneous texture everywhere, luminance edges unbroken — a GLOBAL
#    re-save signature (matches the Snapseed tag), no splice patch, no seam

# 6. triage the auto-suggested leads, then record the analyst verdict
overcast finding list --state triage --case showcase/is-this-real
overcast finding accept <exif-snapseed-finding-id> --target tgt_91234e \
  --case showcase/is-this-real            # the real Snapseed lead → the line
overcast finding accept <verify-declared-edits-id> \
  --case showcase/is-this-real            # calibration exhibit, unattached
overcast finding create "gg-1.jpg verdict: EDITED but NOT fabricated as far as \
checked. Positive edit signal: EXIF Software=Snapseed 2.14 (mobile re-save; \
Canon EOS REBEL T5 serial 222074031107, capture 2016:12:16 17:24:14, no GPS). \
No C2PA manifest (the common case). ELA/noise/luminance: response follows \
scene detail only; noise floor homogeneous; no localized recompression patch, \
no feathered seam — consistent with a GLOBAL Snapseed tone edit + re-save, \
not a splice/composite." \
  --ref rec_7586c22ca77a3b8d --target tgt_91234e --confidence medium \
  --case showcase/is-this-real
overcast note "VERDICT — gg-1.jpg is EDITED (real Snapseed 2.14 re-save in \
EXIF) but shows NO splice/composite lead: ELA + noise + luminance uniform. No \
C2PA manifest = the common case, not fakery. Edited-but-not-fabricated as far \
as checked (medium confidence). ELA is a heuristic LEAD, never proof." \
  --tag tldr --case showcase/is-this-real
overcast target close tgt_91234e --as answered \
  --note "Edited (genuine Snapseed EXIF re-save flag) but no compositing lead \
across C2PA, EXIF, and ELA/noise/luminance forensics." \
  --case showcase/is-this-real

# 7. export the artifacts (CSI theme)
#    display-size the overlay PNGs first (analysis ran at full 4623x2942; the
#    gallery embeds them as data URIs — full-res would be a ~48MB page)
for f in ela noise luminance; do
  p=showcase/is-this-real/.overcast/media/ela/gg-1_$f.png
  ffmpeg -y -i "$p" -vf scale=1600:-1 "$p.tmp.png" && mv "$p.tmp.png" "$p"
done
overcast view rec_7586c22ca77a3b8d --no-open --case showcase/is-this-real
cp showcase/is-this-real/.overcast/media/enhance-gallery-rec_7586c22ca77a3b8d.html \
   showcase/is-this-real/gallery.html      # 7.7MB, fully self-contained
overcast brief --theme csi --export showcase/is-this-real/brief.html \
  --case showcase/is-this-real             # ~49MB: re-embeds the 4.1MB subject
                                           # per record card — NOT published
```

## Notes

- **Real media, real edit**: the subject is CC0 (Unsplash-via-Wikimedia), and
  the `Snapseed 2.14` editing-software tag is genuinely in the file — the
  "possibly edited" suggested finding fires on real-world metadata, not a
  planted fixture. Provenance + license noted here per the showcase recipe.
- **Honesty framing** is the point of this case: a missing C2PA manifest is
  NOT proof of fakery (most media has none), an editing-software tag proves a
  re-save but not a fabrication, and ELA overlays are heuristic leads you must
  eyeball. The verdict is the *accumulation*: here, honestly, "edited but not
  fabricated as far as checked".
- The signed exhibit uses c2patool's **built-in dev test certificate**
  (`C2PA Test Signing Cert`) — valid signature, development trust chain
  (`signingCredential.untrusted` code); it exists purely to show what a signed
  manifest looks like in a `verify` record.
- The three overlay PNGs were downscaled to 1600px wide **after** the analysis
  (which ran at the full 4623x2942) so the self-contained gallery stays
  publishable; the forensic read was done on the full-resolution maps.
- `brief.html` (~49MB) embeds the 4.1MB subject JPEG once per referencing
  record card, so it blows the publish budget; only `gallery.html` (the hero)
  was published.
- Everything here is keyless and local: c2patool + exiftool (system binaries)
  and a pillow/numpy python for the ELA script. No billed API calls.
