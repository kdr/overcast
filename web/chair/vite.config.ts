// Chair console build: a self-contained static bundle emitted to
// assets/chair-console/, where src/chair/assets.ts (shippedPath) finds it in
// dev, npm installs, and beside the bun binary (scripts/bun-sidecar.mjs copies
// it there). `npm run dev:web` proxies /api + /events to a locally running
// chair (`overcast --chair`, default port 7373) for console development.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const CHAIR = "http://127.0.0.1:7373";

export default defineConfig({
  root: here,
  base: "./",
  build: {
    outDir: resolve(here, "..", "..", "assets", "chair-console"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": CHAIR,
      "/events": CHAIR,
    },
  },
});
