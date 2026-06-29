---
name: overcast-init
description: >-
  Install and configure overcast for this harness: install the CLI, verify the
  system ffmpeg, and configure reusable provider profiles. Use once per
  machine/profile before driving the `overcast` skill.
---

# overcast-init

One-time setup for overcast.

1. **Install the CLI** — `pi install npm:@kdrrr/overcast` (inside pi) or
   `npm i -g @kdrrr/overcast` for the standalone binary.
2. **Install/update tinycloud** — the default perception backend. Get the latest
   (`npm i -g @cloudglue/tinycloud@0.3.6` then `tinycloud install --latest`, or
   `tinycloud update`). The `face` + `index` verbs need **tinycloud ≥ 0.3.4**,
   and overcast currently recommends **0.3.6**;
   override the invocation with `OVERCAST_TINYCLOUD_CMD` if it isn't on `PATH`.
3. **Verify** — `overcast doctor --json` (pi pinned, ffmpeg/ffprobe runnable,
   Cloudglue key, tinycloud CLI + version).
4. **Cloudglue key** — the default `watch`/`listen`/`face`/`index` providers
   reach Cloudglue via the tinycloud CLI; configure it (`tinycloud setup cloudglue`)
   or export `CLOUDGLUE_API_KEY`.
5. **Provider profile setup** — choose reusable providers once per profile, not
   once per case. Always preview before applying:
   ```bash
   overcast provider setup show --profile default --json
   overcast provider setup plan --preset cloudglue --profile default --json
   overcast provider setup apply --preset cloudglue --profile default --yes --json
   overcast doctor --profile default --json
   ```
   Optional presets/choices:
   - `cloudglue` for tinycloud watch/listen/face plus built-in ffmpeg enhance.
   - `fal` for `see`/`enhance` with `FAL_KEY`.
   - `hf` for `see`/`enhance` with `HF_TOKEN`.
   - `elevenlabs` for `listen`/`enhance` with `ELEVENLABS_API_KEY`.
   - `local-detect` for local open-vocabulary object detection.
6. **Case setup later** — use the main `overcast` skill per investigation to run
   `case setup`, select targets/sources/indexes, and optionally set case-level
   automation such as `--auto-sense`, `--auto-index-new`, and `--findings review`.

Then use the `overcast` skill to drive the verbs.
