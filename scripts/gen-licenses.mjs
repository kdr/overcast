#!/usr/bin/env node
// Regenerate THIRD_PARTY_NOTICES.md from the bundled deps. Run `npm run licenses`
// after bumping any vendored dependency (esp. ffmpeg-static / ffprobe-static /
// @ffprobe-installer/ffprobe).
import { readFileSync, writeFileSync } from "node:fs";

// Read directly from node_modules/<pkg> — some deps' "exports" maps block
// require()/require.resolve() of package.json + license subpaths. Run from the
// repo root (npm run sets CWD there).
const ver = (p) => JSON.parse(readFileSync(`node_modules/${p}/package.json`, "utf8")).version;
const read = (p) => readFileSync(`node_modules/${p}`, "utf8").trimEnd();

const ffmpegStatic = ver("ffmpeg-static");
const ffprobeStatic = ver("ffprobe-static");
const ffprobeInstaller = ver("@ffprobe-installer/ffprobe");
const zod = ver("zod");
const pi = ver("@earendil-works/pi-ai");
const ffmpegBinaryVersion = "6.0"; // bundled by ffmpeg-static (best-effort; `ffmpeg -version`)

const out = `# Third-Party Notices

overcast bundles the third-party software listed below in its distributions — the
npm package and the standalone bun binary. Each component's license is noted, with
full texts (or references) for the copyleft and bundled-binary components at the end.

The bundled **FFmpeg** binaries are GPL-licensed; see the FFmpeg + GPL sections.

## FFmpeg
- Version: ${ffmpegBinaryVersion} (bundled binary, via ffmpeg-static ${ffmpegStatic})
- License: GPL-3.0-or-later (the static builds enable GPL components)
- Project / source: https://ffmpeg.org · https://ffmpeg.org/download.html
- Used internally for \`enhance\`, frame extraction (\`see\`), and the \`view\` player.

## ffprobe (FFmpeg analysis tool)
- Version: bundled binary, via @ffprobe-installer/ffprobe ${ffprobeInstaller} (preferred) or ffprobe-static ${ffprobeStatic} (fallback)
- License: LGPL-2.1-or-later (the @ffprobe-installer builds); the ffprobe-static npm wrapper is MIT
- Project / source: https://ffmpeg.org · https://ffmpeg.org/download.html

## Bun (standalone binary only)
- The \`overcast\` standalone executable is compiled with \`bun build --compile\`, which embeds the Bun runtime.
- License: MIT
- https://bun.sh

## @earendil-works/pi-ai, pi-agent-core, pi-tui, pi-coding-agent
- Version: ${pi}
- License: MIT
- https://github.com/earendil-works/pi

## zod
- Version: ${zod}
- License: MIT
- https://github.com/colinhacks/zod

## npm wrappers for the bundled binaries
- ffmpeg-static ${ffmpegStatic} — GPL-3.0-or-later
- ffprobe-static ${ffprobeStatic} — MIT
- @ffprobe-installer/ffprobe ${ffprobeInstaller} — LGPL-2.1

================================================================================
License texts
================================================================================

--------------------------------------------------------------------------------
FFmpeg — LICENSE notice (from ffmpeg-static: ffmpeg.LICENSE)
--------------------------------------------------------------------------------

${read("ffmpeg-static/ffmpeg.LICENSE")}

--------------------------------------------------------------------------------
GNU GENERAL PUBLIC LICENSE, Version 3 — applies to the bundled FFmpeg binary and
the ffmpeg-static wrapper. Corresponding source: https://ffmpeg.org/download.html
--------------------------------------------------------------------------------

${read("ffmpeg-static/LICENSE")}

--------------------------------------------------------------------------------
GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1 — applies to the bundled ffprobe
binary (@ffprobe-installer/ffprobe). Full text: https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt
Corresponding source: https://ffmpeg.org/download.html
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
MIT License — applies to ffprobe-static, the @earendil-works/pi-* packages, zod,
and the Bun runtime (reproduced from ffprobe-static; the others carry the same
permissive terms under their own copyright holders).
--------------------------------------------------------------------------------

${read("ffprobe-static/LICENSE")}
`;

writeFileSync("THIRD_PARTY_NOTICES.md", out);
console.error(
  `[licenses] wrote THIRD_PARTY_NOTICES.md ` +
    `(ffmpeg-static@${ffmpegStatic}, ffprobe-static@${ffprobeStatic}, @ffprobe-installer/ffprobe@${ffprobeInstaller})`,
);
