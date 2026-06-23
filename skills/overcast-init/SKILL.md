---
name: overcast-init
description: >-
  Install and configure overcast for this harness: install the CLI, verify the
  vendored ffmpeg, and configure the Cloudglue key for the default perception
  backend. Use once before driving the `overcast` skill.
---

# overcast-init

One-time setup for overcast.

1. **Install the CLI** — `pi install npm:@overcast/cli` (inside pi) or
   `npm i -g @overcast/cli` for the standalone binary.
2. **Verify** — `overcast doctor --json` (pi pinned, ffmpeg/ffprobe runnable,
   Cloudglue key, tinycloud CLI).
3. **Cloudglue key** — the default `watch`/`listen` providers reach Cloudglue
   via the tinycloud CLI; configure it (`tinycloud setup cloudglue`) or export
   `CLOUDGLUE_API_KEY`.

Then use the `overcast` skill to drive the verbs.
