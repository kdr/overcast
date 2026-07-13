# Showcase: enhance — "Enhance & Resolve"

A CityJet Avro RJ85 sits in a ramp photo, its registration painted on the rear
fuselage. Crop that registration and knock it down to surveillance quality — 64
pixels wide, heavy sensor noise — and it becomes an unreadable smudge. Baseline
OCR on the smudge misreads the tail number as **E-RUC**, a garbled and wrong
identifier. One pass of overcast's `enhance` — a deterministic clean-up (ffmpeg
denoise + 2× upscale, no generative model) — recovers it: re-OCR reads
**EI-RJC**, which the full-resolution source crop confirms exactly. A generative
super-resolution tier (fal `aura-sr`, clearly reconstructive) produces the
crispest-looking result and also reads EI-RJC — but its pixels are synthesized:
on repeat runs it slips the final letter (EI-RJ**O** / EI-RJ**Q**), the case's
honesty beat. The recovered registration identifies the airframe: **CityJet Avro
RJ85, EI-RJC**.

## Source media (provenance / license)

- `showcase/_media/enhance/cityjet-eirjc.jpg` — "EI-RJC Avro Regional Jet RJ85
  CityJet taxiing at Schiphol (AMS - EHAM), The Netherlands, 18may2014, pic-3" by
  **Alf van Beem**, Wikimedia Commons, **CC0** (public-domain dedication):
  https://commons.wikimedia.org/wiki/File:EI-RJC_Avro_Regional_Jet_RJ85_CityJet_taxiing_at_Schiphol_(AMS_-_EHAM),_The_Netherlands,_18may2014,_pic-3.JPG
  The registration EI-RJC is a public aircraft identifier, not personal data.
- `reg-eirjc-full.png` — ffmpeg crop of the registration on the rear fuselage
  (the ground-truth control):
  `ffmpeg -i cityjet-eirjc.jpg -vf "crop=360:240:2660:1275" reg-eirjc-full.png`
- `reg-eirjc-degraded.jpg` — the "surveillance-quality" input (64px wide + heavy
  noise + JPEG recompression):
  `ffmpeg -i reg-eirjc-full.png -vf "scale=60:-2,noise=alls=45:allf=t+u" -q:v 6 reg-eirjc-degraded.jpg`
  (final crop is 64×42; noise is seeded randomly, so this exact file is kept for
  reproducibility)

## Command sequence

```bash
cd /path/to/case-studies
overcast case init --case showcase/enhance --name "Enhance & Resolve" --json

# make sure enhance uses the builtin deterministic ffmpeg ops (clears any binding)
overcast provider setup apply --verb enhance --choice ffmpeg --yes --json --case showcase/enhance

# line of investigation
overcast target add "CityJet Avro RJ85 in the ramp photo" \
  --question "Recover the aircraft registration from the surveillance-quality crop and identify the airframe" \
  --case showcase/enhance --json                                   # -> tgt_6aca61

# establish the scene
overcast see showcase/_media/enhance/cityjet-eirjc.jpg \
  --prompt "Establish the scene: what kind of aircraft is this and where is the registration marked?" \
  --case showcase/enhance --json                                   # -> rec_dc59298f4b14844b

# BASELINE: OCR the degraded crop — misreads the registration as E-RUC (wrong)
overcast see showcase/_media/enhance/reg-eirjc-degraded.jpg --ocr \
  --case showcase/enhance --json                                   # -> rec_abc87b3d222775db (OCR: "E-RUC")
overcast note "BEFORE: 64px surveillance-quality crop ... baseline OCR misreads as 'E-RUC' ..." \
  --ref rec_abc87b3d222775db --tag enhance,before,ocr --confidence low --case showcase/enhance

# ENHANCE (deterministic, builtin ffmpeg: hqdn3d denoise + 2x upscale)
overcast enhance showcase/_media/enhance/reg-eirjc-degraded.jpg --ops denoise,upscale \
  --case showcase/enhance --json                                   # -> .overcast/media/reg-eirjc-degraded_enhanced_4b29594531.png (provider: ffmpeg)

# AFTER: re-OCR the enhanced output — reads EI-RJC (the true registration)
overcast see showcase/enhance/.overcast/media/reg-eirjc-degraded_enhanced_4b29594531.png --ocr \
  --case showcase/enhance --json                                   # -> rec_8cff224fc268734c (OCR: "EI-RJC")
overcast note "AFTER (deterministic): denoise + 2x upscale ... reads 'EI-RJC' ..." \
  --ref rec_8cff224fc268734c --tag enhance,after,ocr,recovered --confidence medium --case showcase/enhance

# GENERATIVE TIER (clearly reconstructive): bind fal, aura-sr restore, re-OCR, unbind
overcast provider setup apply --verb enhance --choice fal --yes --json --case showcase/enhance
FAL_ENHANCE_IMAGE_MODEL=fal-ai/aura-sr overcast enhance showcase/_media/enhance/reg-eirjc-degraded.jpg \
  --case showcase/enhance --json                                   # -> .overcast/media/reg-eirjc-degraded_fal.png (model: fal:fal-ai/aura-sr)
overcast see showcase/enhance/.overcast/media/reg-eirjc-degraded_fal.png --ocr \
  --case showcase/enhance --json                                   # -> rec_67ad88235e1a7e52 (OCR: "EI-RJC"; repeat runs slip to EI-RJO / EI-RJQ)
overcast provider setup apply --verb enhance --choice ffmpeg --yes --json --case showcase/enhance   # restore profile

# CONTROL: full-resolution source crop confirms EI-RJC
overcast see showcase/_media/enhance/reg-eirjc-full.png --ocr \
  --case showcase/enhance --json                                   # -> rec_a60d758c191b839b (OCR: "EI-RJC")

# finding + verdict
overcast finding create "Registration recovered from the degraded crop: CityJet Avro RJ85 EI-RJC ..." \
  --ref rec_8cff224fc268734c --target tgt_6aca61 --confidence medium --case showcase/enhance
overcast note "ENHANCE & RESOLVE — verdict: ... EI-RJC ..." --tag tldr --confidence medium --case showcase/enhance

# export
overcast brief --export showcase/enhance/brief.html --theme csi --case showcase/enhance
```

## OCR before / after (verbatim)

| stage | registration read | notes |
|---|---|---|
| degraded (baseline, rec_abc87b3d222775db) | `E-RUC` | WRONG — a dropped character and garbled letters |
| enhance denoise+upscale (rec_8cff224fc268734c) | `EI-RJC` | correct; deterministic, invents no detail |
| fal aura-sr, reconstructive (rec_67ad88235e1a7e52) | `EI-RJC` | crispest to the eye; synthesized pixels, slips to EI-RJO / EI-RJQ on repeat runs |
| full-res control (rec_a60d758c191b839b) | `EI-RJC` | ground truth, confirms the recovery |

## Honesty caveats

- Upscaling is interpolation and generative restores are reconstructive — both
  can hallucinate. The recovered registration was treated as a LEAD until the
  full-resolution control confirmed it; the finding says so explicitly.
- The deterministic clean-up (denoise + 2× upscale) invents no detail and read
  EI-RJC correctly and stably. The generative super-resolution looks crisper but
  is non-deterministic: across repeat runs its final character came back as C, O,
  or Q — "AI enhance" is a lead to corroborate, not sole proof.
- The `enhance` provider binding was temporarily set to fal for the aura-sr tier
  and restored to the builtin ffmpeg choice immediately after.
