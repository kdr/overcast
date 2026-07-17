// Webview SPA build: a self-contained static bundle emitted to dist/webview/,
// loaded into VS Code webview panels by src/panels/webviewHost.ts (which
// rewrites the relative asset URLs to webview URIs and injects the CSP).
// Mirrors the web/chair + web/situation Vite convention in the repo root.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: "./",
  build: {
    outDir: resolve(here, "..", "dist", "webview"),
    emptyOutDir: true,
  },
});
