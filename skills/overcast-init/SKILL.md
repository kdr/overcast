---
name: overcast-init
description: >-
  Install and configure overcast for this harness: install the CLI, verify the
  system ffmpeg, and configure the Cloudglue key for the default perception
  backend. Use once before driving the `overcast` skill.
---

# overcast-init

One-time setup for overcast.

1. **Install the CLI** — `pi install npm:@kdrrr/overcast` (inside pi) or
   `npm i -g @kdrrr/overcast` for the standalone binary.
2. **Install/update tinycloud** — the default perception backend. Get the latest
   (`npm i -g @cloudglue/tinycloud@0.3.6` then `tinycloud install --latest`, or
   `tinycloud update`). The `face` + `collection` verbs need **tinycloud ≥ 0.3.4**,
   and overcast currently recommends **0.3.6**;
   override the invocation with `OVERCAST_TINYCLOUD_CMD` if it isn't on `PATH`.
3. **Verify** — `overcast doctor --json` (pi pinned, ffmpeg/ffprobe runnable,
   Cloudglue key, tinycloud CLI + version).
4. **Cloudglue key** — the default `watch`/`listen`/`face`/`collection` providers
   reach Cloudglue via the tinycloud CLI; configure it (`tinycloud setup cloudglue`)
   or export `CLOUDGLUE_API_KEY`.

Then use the `overcast` skill to drive the verbs.
