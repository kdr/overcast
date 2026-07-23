#!/bin/bash
# claude-cloud-system-setup.sh — paste this into the Claude Code cloud
# environment's "Setup script" field (Settings → Environment → Setup script).
#
# WHY THIS IS SEPARATE FROM scripts/claude-setup.sh
# -------------------------------------------------
# There are TWO setup surfaces for a Claude Code on-the-web environment, and they
# run in different contexts:
#
#   • The "Setup script" field (THIS file) runs BEFORE Claude Code launches, as
#     root, with cwd=/ (the repo is NOT the working directory yet). Its output is
#     baked into the environment SNAPSHOT, so it's the place for SYSTEM tools
#     (apt / pip / npm -g) — things that live outside the repo and are expensive
#     to reinstall every session. A bare `npm install`/`npm run …` here fails with
#     "ENOENT … open '/package.json'" and its non-zero exit blocks the session, so
#     do NOT put repo build steps here.
#
#   • REPO setup (npm ci + build + e2e-media wiring) runs AFTER launch, inside the
#     clone, via the SessionStart hook wired in .claude/settings.json →
#     scripts/claude-setup.sh. That's automatic; you don't paste it anywhere.
#
# So: this file = system tools (paste into the Setup script field). claude-setup.sh
# = repo build (runs itself). See CLAUDE.md § "Claude Code on the web".
#
# Every line is `|| true` on purpose: a transient apt/pip/npm hiccup must never
# make the Setup script exit non-zero and brick the whole environment. Each tool
# is optional — its verbs/e2e cases degrade or SKIP cleanly when it's absent
# (overcast doctor reports what's missing).
#
# ENV VARS / SECRETS are configured separately (Settings → Environment →
# Variables/Secrets), NOT here — they're read at runtime, not installed:
#   CLOUDGLUE_API_KEY            default watch/listen/face/index senses
#   ANTHROPIC_API_KEY (or other) the agent brain + default `see`
#   OVERCAST_TINYCLOUD_DIRECT_EGRESS=1   REQUIRED for the Cloudglue senses when
#                               egress goes through a TLS-re-terminating (MITM)
#                               proxy — tinycloud is a bun binary that can't do
#                               tunneled TLS through such a proxy, so its calls
#                               fail with "socket connection closed unexpectedly".
#                               This makes it connect directly (opt-in; bypasses
#                               the egress proxy for tinycloud only).
#   OVERCAST_USE_NODE=1         run the CLI / live-suite under node (no bun needed)
#   APIFY_TOKEN, SERPER_API_KEY, SHODAN_API_KEY, WINDY_API_KEY, FIRMS_MAP_KEY,
#   HF_TOKEN, …                 OSINT sources / HF captioner (see .env.example)
#   OC_E2E_MEDIA_URL (+ OC_E2E_MEDIA_SHA256)   live-e2e media bundle (the hook's
#                               fetch-e2e-media.sh wires the paths into .env)

# ffmpeg/ffprobe — the internal media toolkit (crop/enhance/frame-extraction);
# exiftool — the `exif` forensic sense (apt package name: libimage-exiftool-perl).
apt-get update && apt-get install -y ffmpeg libimage-exiftool-perl || true

# yt-dlp powers the youtube/dl sources. The apt build lags badly and current
# YouTube breaks it, so install the latest from PyPI — WITH the curl-cffi extra:
# TLS-fingerprinting hosts (e.g. domain-restricted Vimeo embeds) 401 without
# impersonation. If the extra can't resolve/build on this image, pip rolls back
# the WHOLE transaction, so fall back to plain yt-dlp — impersonation-less
# beats absent (`overcast doctor` flags the degraded build). (If `pip` isn't on
# PATH, `python3 -m pip …` or an `apt-get install -y python3-pip` first does
# the same.)
pip install -U --break-system-packages "yt-dlp[default,curl-cffi]" \
  || pip install -U --break-system-packages yt-dlp || true

# tinycloud CLI — the default Cloudglue backend for watch/listen/face/index. A
# global npm install as root lands it on PATH for the session. (If this image's
# npm global prefix is read-only, set NPM_CONFIG_PREFIX to a writable dir first —
# see CLAUDE.md § "Cursor Cloud specific instructions".)
npm i -g @cloudglue/tinycloud || true

# --- Optional extras (uncomment if you want these senses live) ---------------
# c2patool — the `verify` C2PA/Content-Credentials sense (not apt-packaged; grab a
#   release binary from https://github.com/contentauth/c2patool and put it on PATH).
# The uv-managed Python venv for the LOCAL visual/audio DBs (deepface/CLIP/CLAP/
#   audio-fp/voice-print) is multi-GB (torch/tensorflow) and is a REPO step, not a
#   system one: run `bash scripts/setup-dev.sh --venv all` from inside a session.

exit 0
