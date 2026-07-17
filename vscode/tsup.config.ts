// Extension HOST bundle: one CJS file (VS Code's extension host still requires
// a CommonJS entry; ESM extensions haven't shipped). The webview SPA is a
// separate Vite build (webview/vite.config.ts) into dist/webview/ — tsup runs
// FIRST in `npm run build` so clean:true doesn't nuke the vite output.
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { extension: "src/extension.ts" },
  format: ["cjs"],
  outDir: "dist",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  // Release-grade output: the same build is what gets packaged into the .vsix.
  // Sourcemaps are emitted for local F5 debugging but .vscodeignore keeps them
  // out of the package.
  minify: true,
  sourcemap: true,
  clean: true,
  dts: false,
});
