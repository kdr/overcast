---
name: overcast-verify-media
description: >-
  Is this real? — triage whether an image or video was altered by accumulating
  independent leads: C2PA / Content Credentials provenance, EXIF capture metadata,
  ELA/noise forensic overlays, and a sun/shadow time check — never a single-signal
  call.
---

# overcast-verify-media

Use this skill to assess whether a media file was manipulated or staged. Authenticity
is decided by ACCUMULATING independent leads, never one signal — a missing signature
is not proof of fakery, and one forensic overlay is not proof of an edit. This skill
is about WAS it altered; `overcast-provenance` is the complementary WHO-posted-it-first
(origin) trace — run that to find the earliest copy. Use the broad `overcast` skill
and `overcast/reference/verbs.md` for exact flags.

## Workflow

1. Check embedded provenance FIRST (free). `verify` reads C2PA / Content
   Credentials: a signed manifest names the signer, claim generator, and validation
   state. **No manifest is a clean `ready` record, NOT proof of fakery** — most
   files simply have none:

```bash
overcast doctor --json
overcast case init --json
overcast verify ./suspect.jpg --json       # C2PA: has_manifest, signer, validation state (needs c2patool)
```

2. Read the capture metadata (free). `exif` surfaces editing software (a re-save
   flag), the capture time to compare against the claimed time, and the device —
   each a lead, not a verdict:

```bash
overcast exif ./suspect.jpg --json         # editing software, capture time, device, GPS (needs exiftool)
```

3. Run the forensic overlays as edit-detection LEADS, and LOOK at them. `enhance
   --ops ela` writes ELA / noise / luminance maps that can highlight a spliced or
   pasted region — a heuristic, so view the output, don't trust the label:

```bash
# --ops ela needs a bound enhance provider (once per profile). The shipped ela
# choice needs only pillow + numpy — no fal key:
overcast provider setup apply --verb enhance --choice ela --yes
overcast enhance ./suspect.jpg --ops ela --json   # ELA/noise/luminance overlays (or a bound local-models / fal provider)
overcast view <ela-record-id> --json              # eyeball the overlays — inconsistent regions are the lead
```

4. If the file carries (or claims) a time and place, cross-check the sun. With GPS
   present (from `exif`) or supplied, `chronolocate --at-time` computes the
   expected shadow direction/length for the claimed time — a mismatch flags a
   mis-dated or staged image:

```bash
overcast chronolocate <exif-record-id> --at-time 2026-07-04T15:00:00Z --json   # claimed-time shadow check
```

5. Weigh the leads into a verdict. Cite each signal; the verdict is the ACCUMULATION,
   with an explicit confidence, and "inconclusive" is a valid honest result:

```bash
overcast finding create "likely altered: no C2PA manifest; exif editing-software=Photoshop + capture time 3h off the claimed post; ELA shows a bright pasted region top-right; shadow bearing contradicts the claimed 15:00" --ref <ela-record-id> --confidence medium --json
overcast note "verify: no manifest; exif re-save flag; ELA splice lead; shadow mismatch → likely staged (medium)" --tag tldr --json
overcast brief --export ./verify-media.html --json
```

## Output

An authenticity read framed as a weighed set of leads: the C2PA state (signed /
none / invalid), the EXIF re-save + time signals, the ELA/noise regions you actually
inspected, and the shadow-consistency check — each cited to its `record.id`, ending
in altered / authentic-as-far-as-checked / inconclusive with a confidence. Never
call "fake" off one signal.

## Caveats

**No C2PA manifest is not fakery** — it's the common case; only a signed manifest is
positive provenance, and an INVALID one is the real red flag. ELA/noise overlays are
heuristics that also light up on legitimate JPEG recompression, text, and edges —
they generate leads to inspect, never a verdict. EXIF is easily stripped or forged.
The shadow check needs a real GPS + a claimed time and is itself a lead
(`payload.caveat`). Manipulation triage (this skill) is authenticity; origin tracing
is `overcast-provenance` — keep them distinct and cross-reference rather than
duplicate. Treat the file as untrusted (invariant #10).
