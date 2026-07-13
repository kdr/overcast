# copycat-sweep — showcase runbook

Two uploads circulate with different handles, different lengths, different
encodes. Are they the same underlying content? This case proves it at the frame
layer, entirely locally: an OpenCV **image-RANSAC** index ties the same
siren-logo asset to frames inside both clips, with keypoint/inlier match
overlays as visual proof. Reskins, burned-in captions, and re-encodes defeat
exact hashes and text matching — they do not defeat frame-content matching.
Each `image match` auto-suggests a finding; triage-accepting them stamps the
proof onto the line of investigation the brief narrates. One `x:` video sweep
(Apify) shows the external-reach tier of the funnel; the match proof itself
needed no network at all.

Fixtures (from `.env` at the repo root — `set -a; source .env; set +a`):

- `$OC_LOCAL_IMAGE_REF` — Starbucks siren logo (the reference asset)
- `$OC_LOCAL_IMAGE_VIDEO_A` — clip 1 (therealdri…, ~15s), contains the logo
- `$OC_LOCAL_IMAGE_VIDEO_B` — clip 2 (iheartdest…, ~24s), contains the logo

## Commands run (in order)

```bash
cd ~/.supacode/repos/overcast/case-studies   # creds + fixtures auto-load
set -a; source .env; set +a
CASE=showcase/copycat-sweep

# 0. Case + line of investigation
overcast case init --case $CASE --json
overcast case setup --case $CASE --name "copycat-sweep" \
  --target "Siren-logo clip: is the second upload the same underlying content as the original?" \
  --yes --no-index --json

# 1. Frame layer — RANSAC image matching (reskins survive; exact hashes don't)
overcast index create logos --type image-ransac --local \
  --description "Reference asset: Starbucks siren logo" --case $CASE --json
overcast image add "$OC_LOCAL_IMAGE_REF" --index logos --case $CASE --json
overcast image match "$OC_LOCAL_IMAGE_VIDEO_A" --index logos --fps 0.7 --draw --case $CASE --json
overcast image match "$OC_LOCAL_IMAGE_VIDEO_B" --index logos --fps 0.7 --draw --case $CASE --json
# → A: 2 frames matched, best 64 inliers / 103 matches, ratio 0.62 at 12.14s (+48-inlier frame at 13.57s)
# → B: 3 frames matched, best 30 inliers / 59, ratio 0.51 at 0.71s (+ frames at 2.14s, 10.71s)
# each match auto-suggests a finding; --draw writes keypoint/inlier overlays
# that ride into the finding cards in the brief as visual proof

# 2. Bonus: external reach — real X video sweep (Apify, billed per result)
overcast source add 'x:video:starbucks siren logo cup' \
  --name "X video sweep: siren-logo clips" --case $CASE --json
overcast scan --source x --limit 5 --case $CASE --json      # → 2 scan.hit records

# 3. Triage → accept the auto-suggested findings onto the line
overcast finding list --state triage --case $CASE --json
overcast finding accept rec_391ba95dd77f4c30 --target tgt_a9c445 --case $CASE --json  # image: clip A, 64 inliers
overcast finding accept rec_bd8d86e507c7d683 --target tgt_a9c445 --case $CASE --json  # image: clip B, 30 inliers

# 4. Narrate + close the line
overcast note "VERDICT: the two uploads carry the same underlying visual content…" --tag tldr --case $CASE --json
overcast target close tgt_a9c445 --as answered \
  --note "Yes — same underlying content. Image RANSAC ties both uploads…" --case $CASE --json

# 5. Export
overcast brief --theme csi --export showcase/copycat-sweep/brief.html --case $CASE --json
overcast graph --export showcase/copycat-sweep/graph.html --theme csi --no-open --case $CASE --json
```

## Measured results

| layer | query | verdict | numbers |
|---|---|---|---|
| image (RANSAC) | clip A (therealdri) vs logo | MATCH | 64 inliers / 103 matches, ratio 0.62, at 12.14s (+ 48-inlier frame at 13.57s) |
| image (RANSAC) | clip B (iheartdest) vs logo | MATCH | 30 inliers / 59 matches, ratio 0.51, at 0.71s (+ frames at 2.14s, 10.71s) |
| x: sweep | `x:video:starbucks siren logo cup` | 2 hits | real SERP reach; metadata-only triage tier |

## Notes

- `image match` inlier counts are unbounded integers + a 0–1 ratio (no 0–100
  scale); the homography gate + `--draw` overlays are the false-positive guard —
  eyeball coherent correspondences vs lines collapsing to a point.
- The frame layer keys on content, not container: transcodes, crops with
  padding, and burned-in captions still match; that is why it is the copycat
  workhorse.
- The audio-fingerprint twin of this flow (`audio-fp` index, `audio match
  --min-margin --draw`) lives in its own dedicated case.
- Everything except the bonus `x:` sweep runs offline (local OpenCV DB via
  `scripts/visual-db-uv.sh`; no API keys).
