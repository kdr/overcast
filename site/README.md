# overcast.video — marketing site

Coming-soon page for [overcast](../README.md), served at **https://overcast.video**.
Vite + React + TypeScript + Tailwind; no backend, no external requests at runtime.

## Develop

```bash
npm install
npm run dev       # local dev server
npm run build     # typecheck (tsc -b) + production build → dist/
npm run preview   # serve the production build
```

## Brand assets

- `public/logo.svg` is a copy of `../assets/branding/logo-transparent.svg`
  (the logo with its white background removed — regenerate by deleting the
  `<rect>` from `../assets/branding/logo.svg`).
- Colors are pastel tints of the overcast terminal palette
  (`../themes/overcast.json`): cream `#faf6ec`, ink `#14181a`, mint / sky /
  butter / blush, with the green→cyan / magenta neon accents in the wordmark.

## Icons & social card

`public/favicon.ico` (16/32/48, eye crop), `public/icon-512.png` /
`icon-192.png` / `apple-touch-icon.png` (TV-head crop), and `public/og.png`
(1200×630 social card) are generated from the HTML design sources in `og/`:

```bash
node scripts/gen-assets.mjs   # needs Google Chrome + ffmpeg installed
```

Edit `og/icon.html`, `og/icon-small.html`, or `og/og.html`, rerun the script,
and commit the regenerated files.

## Deploy (Vercel)

- Import this repo; set **Root Directory** to `site/`.
- Framework preset: **Vite** (auto-detected) — build `npm run build`, output `dist`.
- Attach the `overcast.video` domain.
- `vercel.json` adds immutable caching for hashed `/assets/*` plus basic
  security headers.
