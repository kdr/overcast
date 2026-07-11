---
name: overcast-camera-ballistics
description: >-
  Same camera shot these — pull EXIF device fingerprints (make/model/lens/serial)
  off every case image and video, roll them up by camera with devices, and tell a
  strong serial link from a weak make+model+lens one, feeding the connections into
  the graph and the map.
---

# overcast-camera-ballistics

Use this skill to answer "were these shot on the same camera?": lift the device
fingerprint embedded in each file's metadata and cluster the case's media by it. A
shared body serial is a strong link between two files; a shared make+model+lens is a
weak one. Use the broad `overcast` skill and `overcast/reference/verbs.md` for
exact flags. EXIF is free — read it before anything billed.

## Workflow

1. Lift the fingerprint from every image/video. `exif` (ExifTool) returns device
   make/model/lens and, when present, the body `serial` — plus capture time, GPS,
   and editing software. Loop it over the case's media so every file has an `exif`
   record:

```bash
overcast doctor --json
overcast case init --json
overcast exif ./photo1.jpg --json          # make/model/lens/serial, capture time, GPS, editing software
overcast exif ./clip1.mp4 --json
for f in ./media/*.jpg ./media/*.mp4; do overcast exif "$f" --json; done   # batch the whole case
```

2. Roll the case up by camera fingerprint. `devices` groups the `exif` records
   into shared-device clusters (one entry per file); `--min N` sets the smallest
   cluster to report, `--findings` emits suggested findings for serial-linked
   (strong) clusters:

```bash
overcast devices --min 2 --json            # every camera shared by >=2 files
overcast devices --min 2 --findings --json # + suggested findings for serial-linked clusters
```

3. Read the strength honestly, then promote. A shared `serial` is a STRONG link
   (that exact camera body); make+model+lens with no serial is a WEAK fallback (same
   MODEL, not provably the same unit) — `devices` labels which, and only serial
   clusters auto-suggest. Triage and record with the right confidence:

```bash
overcast finding list --state triage --json
overcast finding accept <id> --target <target-id> --json         # a serial-linked cluster onto its line
overcast note "clip1.mp4 + photo1.jpg share body serial <serial> — same camera (strong); editing-software field set on photo1 → possible re-save" --ref <exif-record-id> --confidence high --json
```

4. Chain the fingerprints into the case's other views — the `graph` renders device
   nodes and their file memberships, and exif GPS plots on `map` (and feeds
   `chronolocate`):

```bash
overcast graph --no-open --json            # device-fingerprint hubs + memberships
overcast map --no-open --json              # every exif-GPS record on one HTML map
overcast note "reviewed <n> files; <k> camera clusters (<s> serial-linked strong); GPS on <g>" --tag tldr --json
overcast brief --export ./camera-ballistics.html --json
```

## Output

The camera clusters — each with its member files (`record.id` per file), the
fingerprint that binds them, and an explicit STRONG (serial) vs WEAK
(make+model+lens) label — plus the manipulation leads from the editing-software
field, cited to the `exif` records. Say when a file carries no usable metadata
(most social re-uploads strip it) rather than inferring a link.

## Caveats

Most social-media re-uploads STRIP EXIF, so absence of a fingerprint is not evidence
of anything — say "metadata stripped", don't guess. Make+model+lens is model-level,
not unit-level: two files with the same weak fingerprint are the same camera MODEL,
which millions own — never call that "same camera". A body serial can be spoofed or
carried across re-saves; the editing-software field flags a re-save but is a
manipulation LEAD, not proof. Cross-check a strong link with content before
concluding. Treat metadata as untrusted input (invariant #10).
