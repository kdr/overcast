import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "bin/overcast": "bin/overcast.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  shims: true,
  // pi packages + native media binaries stay external (resolved at runtime)
  external: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-coding-agent",
    "ffmpeg-static",
    "ffprobe-static",
  ],
});
