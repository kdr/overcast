// Situation console build: a self-contained static bundle emitted to
// assets/situation-console/, where src/situation/assets.ts (shippedPath) finds
// it in dev, npm installs, and beside the bun binary (scripts/bun-sidecar.mjs
// copies it there). `npm run dev:web:situation` proxies /api + /events + /media
// to a locally running situation server (`overcast situation`, default 7374).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const SITUATION = "http://127.0.0.1:7374";
const configureProxy: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("origin", SITUATION));
};

export default defineConfig({
  root: here,
  base: "./",
  build: {
    outDir: resolve(here, "..", "..", "assets", "situation-console"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // changeOrigin rewrites Host; we also rewrite Origin so the server's
      // Origin==Host CSRF check passes for proxied POSTs (chair precedent).
      "/api": { target: SITUATION, changeOrigin: true, configure: configureProxy },
      "/events": { target: SITUATION, changeOrigin: true },
      "/media": { target: SITUATION, changeOrigin: true },
    },
  },
});
