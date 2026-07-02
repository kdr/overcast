#!/usr/bin/env node
// Regenerates the committed icon set + social card from the design sources in og/.
// Prereqs: Google Chrome + ffmpeg on this machine (see site/README.md).
//   node scripts/gen-assets.mjs
// Everything is rendered into a temp dir first and only copied into public/
// once every step has succeeded, so a failed run never leaves public/ with a
// mix of new and stale assets.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const site = dirname(dirname(fileURLToPath(import.meta.url)))
const chrome =
  process.env.CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function shot(html, out, width, height) {
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--screenshot=${out}`,
      `--window-size=${width},${height}`,
      pathToFileURL(html).href,
    ],
    { stdio: 'ignore' },
  )
}

function scaleTo(src, dst, size) {
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', src, '-vf', `scale=${size}:${size}:flags=lanczos`, dst],
    { stdio: 'inherit' },
  )
}

// .ico with PNG-encoded entries (fine for every current browser)
function packIco(pngPaths, out) {
  const blobs = pngPaths.map(({ size, path }) => ({ size, data: readFileSync(path) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(blobs.length, 4)
  const entries = []
  let offset = 6 + 16 * blobs.length
  for (const { size, data } of blobs) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size, 0)
    entry.writeUInt8(size, 1)
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bpp
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += data.length
  }
  writeFileSync(out, Buffer.concat([header, ...entries, ...blobs.map((b) => b.data)]))
}

const PUBLISHED = ['icon-512.png', 'icon-192.png', 'apple-touch-icon.png', 'favicon.ico', 'og.png']

const tmp = mkdtempSync(join(tmpdir(), 'overcast-site-assets-'))
try {
  const staged = (name) => join(tmp, name)

  shot(join(site, 'og/icon.html'), staged('icon-512.png'), 512, 512)
  scaleTo(staged('icon-512.png'), staged('icon-192.png'), 192)
  scaleTo(staged('icon-512.png'), staged('apple-touch-icon.png'), 180)

  shot(join(site, 'og/icon-small.html'), staged('small-512.png'), 512, 512)
  const favs = [16, 32, 48].map((size) => {
    const path = staged(`fav-${size}.png`)
    scaleTo(staged('small-512.png'), path, size)
    return { size, path }
  })
  packIco(favs, staged('favicon.ico'))

  shot(join(site, 'og/og.html'), staged('og.png'), 1200, 630)

  // every step succeeded — publish atomically-ish into public/
  for (const name of PUBLISHED) copyFileSync(staged(name), join(site, 'public', name))
  console.log(`regenerated: ${PUBLISHED.join(', ')}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
