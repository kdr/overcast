# Showcase case-generation — operating manual (for agents)

You are producing one **showcase case**: run a real overcast flow on real data,
export its visual artifacts, publish them to the marketing site, and hand back a
registry entry. Follow this exactly.

## Golden rules

1. **Always run from the repo root** so creds auto-load:
   `cd ~/.supacode/repos/overcast/case-studies`
   The `overcast` binary is on PATH (global 0.0.8). `bin/overcast.ts` auto-loads
   `.env` from cwd, so every API key + fixture path is already in the environment
   of the overcast process when you run from here.
2. **Get fixture paths as shell vars** at the top of a bash block when you need
   them as CLI args: `set -a; source .env; set +a` (double-loading is harmless).
   Concrete fixture paths are tabled below — you may also just use `$OC_...`.
3. **Isolate your case**: pass `--case showcase/<slug>` to *every* overcast
   command. Start with `overcast case init --case showcase/<slug> --json`.
4. **Discover exact flags** — do NOT guess. Use:
   `overcast <verb> --help`, `overcast commands --json`,
   `docs/flows.md`, and the matching `skills/<skill>/SKILL.md`.
5. **Export artifacts into `showcase/<slug>/`** as HTML, CSI theme, no auto-open:
   e.g. `--export showcase/<slug>/map.html --theme csi --no-open` (flag names vary
   per verb — check `--help`). Prefer the self-contained surfaces (graph, map,
   cluster gallery, reconstruct viewers, image-only brief).
6. **Publish** (this scrubs `/Users/` + `file://` leaks, copies any local media,
   patches CSP, and renders a Chrome thumbnail; it FAILS LOUDLY on any leak):
   ```
   node ~/dev/github/overcast.video/scripts/publish-case.mjs \
     --slug <slug> \
     --src ~/.supacode/repos/overcast/case-studies/showcase/<slug> \
     --scrub ~/.supacode/repos/overcast/case-studies \
     --thumb <the-most-visual-artifact>.html
   ```
   If it fails on a leak, fix the *export* (re-run the verb / choose a different
   surface). Do not hand-edit the HTML. Verify after:
   `grep -rEc "file://|/Users/" ~/dev/github/overcast.video/public/cases/<slug>/*.html` → all 0.
7. **Write `showcase/<slug>/RUNBOOK.md`** — the exact command sequence you ran,
   with a one-paragraph story intro (this is the reproducible transcript).
8. **Never** use identity/PII sources (person/phone/username/facesearch/plate).
   Faces: only the public-figure fixtures below.
9. Leave the shared overcast **profile** alone unless your case needs a binding
   (only `reconstruct` does — see its note). If you bind, say so in your report.

## Fixture media (all verified present)

| env var | path | notes |
|---|---|---|
| OC_EXIF_IMAGE | ~/Downloads/test-videos/exif-geotagged-sf.jpg | GPS-tagged SF photo |
| OC_EXIF_IMAGE_2 | ~/Downloads/test-videos/exif-geotagged-la.jpg | GPS-tagged LA photo |
| OC_IMAGE | ~/Downloads/test-videos/sample-image.jpg | generic still |
| OC_VIDEO_VISUAL | ~/Downloads/test-videos/browse-hackernews.mp4 | screen recording ~30s |
| OC_VIDEO_OBJECTS | ~/Downloads/test-videos/worker_without_helmet.mp4 | people+objects, for --detect |
| OC_VIDEO_SMALL | ~/Downloads/test-videos/bbq.mp4 | short clip |
| OC_VIDEO_SPEECH | ~/Downloads/test-videos/bobbyleetheoasian.mp4 | clear speech (Bobby Lee, public figure) |
| OC_AUDIO | ~/Downloads/test-videos/sample-audio.m4a | audio clip |
| OC_CLUSTER_FIXTURE_DIR | ~/Downloads/test-videos/face-crops | folder of face crops |
| OC_LOCAL_FACE_VIDEO | ~/Downloads/test-videos/video-willsmith-…mp4 | Will Smith (public figure) |
| OC_LOCAL_FACE_IMAGE | ~/Downloads/will.jpg | Will Smith reference face |
| OC_LOCAL_IMAGE_REF | ~/Downloads/Starbucks_Corporation_Logo_2011.jpg | logo for RANSAC match |
| OC_LOCAL_IMAGE_VIDEO_A | ~/Downloads/video-therealdri-…mp4 | clip containing the logo |
| OC_LOCAL_IMAGE_VIDEO_B | ~/Downloads/video-iheartdest-…mp4 | second clip |
| OC_VOICE_SPEAKER_VIDEO | ~/Downloads/test-videos/bobbyleetheoasian.mp4 | reference speaker |
| OC_VOICE_OTHER_VIDEO | ~/Downloads/test-videos/tinycloud-launch.mov | other speaker (314MB) |

Keyless sources (no key needed): `dispatch:sf`, `gdelttv:"<q>"`, `wayback:<url>`,
`overpass:...`, `firms:<bbox>`, `flights:<bbox>`. Keyed (already configured):
cloudglue (watch/listen/see/face), fal (reconstruct/enhance), apify (x/lens/
yandeximg/tiktok/instagram), tavily (web), serper (dork), shodan, windy (webcam).

## Round 2 — fresh REAL media (CC0/CC/public-domain)

We're replacing synthetic-serial fixtures with real web media. Rights: **CC0 /
public-domain / CC-BY only**, re-hosting in artifacts is fine.

**Staged & verified EXIF photos** (`showcase/_media/exif/`, all CC0 Unsplash-via-Wikimedia, real EXIF):
| file | camera | serial | capture time | GPS | software | content |
|---|---|---|---|---|---|---|
| `gg-1.jpg` | Canon EOS REBEL T5 | **222074031107** | 2016:12:16 17:24:14 | — | Snapseed 2.14 (edited) | aerial Golden Gate Bridge |
| `gg-2.jpg` | Canon EOS REBEL T5 | **222074031107** (SAME body) | 2016:08:12 18:06:43 | **37.2423,-121.7604 (San Jose!)** | Instagram (edited) | Golden Gate tower in fog |
| `gg-3.jpg` | Nikon D800 | 6114213 | 2016:09:20 19:05:22 | — | Capture One 9 | (different camera, contrast) |

Real narrative hooks (use these, they're genuine):
- **camera-ballistics**: gg-1 + gg-2 share serial `222074031107` (one real Canon T5 body, 4 months apart); gg-3 is a different body (Nikon D800). Both Canon frames carry editing-software tags.
- **scene-locate**: gg-2 unmistakably shows the **Golden Gate Bridge** but its geotag points to **San Jose ~40mi away** — a real geotag-vs-content contradiction. Landmark `see` + reverse-image corroborate the bridge; `chronolocate` checks whether the 2016:08:12 18:06 capture time is sun/shadow-consistent (fold the time-of-day beat in here).
- **is-this-real**: gg-2 = Instagram-re-saved + a GPS that doesn't match the scene + no C2PA manifest → real "provenance can't be trusted" leads.

**Recipe to fetch MORE CC media yourself** (enhance, face-clustering need their own):
- Images: Wikimedia Commons geosearch/search API → filter `extmetadata.LicenseShortName` = CC0/PD/CC-BY → download the **original** `imageinfo.url` (retains EXIF) with curl → verify with `exiftool`. Example that worked:
  `curl -s 'https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggscoord=LAT%7CLNG&ggsradius=900&ggslimit=40&ggsnamespace=6&prop=imageinfo&iiprop=url|extmetadata|metadata&format=json' -A 'overcast-showcase/1.0'`
- Video (multi-person face-clustering): prefer **public-domain US-government footage** (White House / congressional hearing / NASA press conference — PD by default, multiple recognizable public figures) via `dl:<url>` or `youtube:`. Public figures only; verify faces are identifiable public figures before publishing a gallery.
- Stage fetched media under `showcase/_media/<kind>/` and note provenance + license in your RUNBOOK.

## What to return (strict)

End your final message with a fenced block titled `REGISTRY ENTRY` containing a
JS object literal ready to paste into `src/caseStudies.ts`:

```
REGISTRY ENTRY
{
  slug: '<slug>',
  codename: '<Title Case name>',
  tagline: '<one line: what this proves>',
  badge: '<KEYLESS|FORENSICS|LIVE DATA|3D|OSINT|AUDIO|FACES>',
  accent: '<mint|sky|butter|blush>',
  verbs: ['verb1','verb2',...],
  thumb: '/cases/<slug>/thumb.png',
  links: [ { label: 'open <x>', href: '/cases/<slug>/<file>.html' }, ... ],
}
```

Then, below it, note: (a) which artifacts you published and whether each is fully
self-contained, (b) the scrub-grep result, (c) any provider you had to bind, and
(d) anything that failed or is a caveat. Keep it tight.
