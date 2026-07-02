import { useEffect, useState } from 'react'

const TAGLINE = 'video · recon · osint'
const GLYPHS = '█▓▒░/\\<>|_'
// keep in step with the 6s cycle + 88–95% burst window in index.css
const CYCLE_MS = 6000
const BURST_AT_MS = 5280

function scramble(text: string) {
  return text
    .split('')
    .map((c) =>
      /[a-z]/.test(c) && Math.random() < 0.25
        ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
        : c,
    )
    .join('')
}

function useGlitchedTagline() {
  const [text, setText] = useState(TAGLINE)
  useEffect(() => {
    // track the media query live so the scramble stops/starts with the same
    // preference changes the CSS animations react to
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timeouts: number[] = []
    let interval: number | undefined
    let lead: number | undefined
    const burst = () => {
      timeouts.forEach(clearTimeout)
      setText(scramble(TAGLINE))
      timeouts = [80, 160].map((ms) =>
        window.setTimeout(() => setText(scramble(TAGLINE)), ms),
      )
      timeouts.push(window.setTimeout(() => setText(TAGLINE), 260))
    }
    const stop = () => {
      clearTimeout(lead)
      clearInterval(interval)
      timeouts.forEach(clearTimeout)
      lead = interval = undefined
      timeouts = []
      setText(TAGLINE)
    }
    const start = () => {
      lead = window.setTimeout(() => {
        burst()
        interval = window.setInterval(burst, CYCLE_MS)
      }, BURST_AT_MS)
    }
    const apply = () => {
      stop()
      if (!mql.matches) start()
    }
    apply()
    mql.addEventListener('change', apply)
    return () => {
      mql.removeEventListener('change', apply)
      stop()
    }
  }, [])
  return text
}

export default function App() {
  const tagline = useGlitchedTagline()

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-cream px-6 py-16 text-center font-mono text-ink">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="blob blob-mint blob-drift-a -top-[25%] -left-[20%] h-[75vmax] w-[75vmax]" />
        <div className="blob blob-sky blob-drift-b top-[-10%] right-[-25%] h-[65vmax] w-[65vmax]" />
        <div className="blob blob-butter blob-drift-c bottom-[-30%] left-[-10%] h-[70vmax] w-[70vmax]" />
        <div className="blob blob-blush blob-drift-d right-[-15%] bottom-[-20%] h-[55vmax] w-[55vmax]" />
        <div className="halftone absolute inset-0" />
        <div className="scanlines absolute inset-0" />
        <div className="refresh-bar">
          <div className="refresh-carriage" />
        </div>
      </div>

      <div className="relative flex w-full flex-col items-center gap-6 sm:gap-8">
        <img
          src="/logo.svg"
          alt="overcast — a suited figure with a CRT-TV head showing a watching eye, and a mounted CCTV camera"
          width={1254}
          height={1254}
          className="glitch-logo w-[clamp(240px,38vw,420px)]"
        />

        <h1
          aria-label="overcast"
          className="text-[clamp(3rem,11vw,6.5rem)] leading-none font-bold tracking-tight lowercase"
        >
          <span aria-hidden className="wordmark" data-text="overcast">
            overcast
          </span>
        </h1>

        <p
          aria-label={TAGLINE}
          className="text-[clamp(0.75rem,2.4vw,1.15rem)] tracking-[0.28em] text-ink/75 sm:tracking-[0.45em]"
        >
          <span aria-hidden>{tagline}</span>
        </p>

        <p className="max-w-md text-sm text-ink/60 sm:text-base">
          Senses + OSINT reach for any agent.
        </p>

        <div className="mt-2 flex -rotate-2 items-center gap-2 rounded-full border-2 border-ink bg-butter px-6 py-2.5 shadow-[5px_5px_0_0_var(--color-ink)]">
          <span className="text-sm font-semibold sm:text-base">&gt; coming soon</span>
          <span aria-hidden className="animate-blink font-bold">
            ▮
          </span>
        </div>
      </div>
    </main>
  )
}
