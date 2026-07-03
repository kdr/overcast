import { useEffect, useState } from 'react'
import { captureEvent } from './analytics'

const TAGLINE = 'video · recon · osint'
const GLYPHS = '█▓▒░/\\<>|_'
const NPM_URL = 'https://www.npmjs.com/package/@kdrrr/overcast'
const SOURCE_URL = 'https://github.com/kdr/overcast'
const INSTALL_COMMANDS = [
  {
    id: 'cli',
    label: 'CLI',
    command: 'npm install -g @kdrrr/overcast',
  },
  {
    id: 'claude-plugin',
    label: 'Claude plugin',
    command: '/plugin marketplace add kdr/overcast\n/plugin install overcast@overcast',
  },
  {
    id: 'agent-skills',
    label: 'Agent skills',
    command: 'npx skills add kdr/overcast',
  },
]
const FEATURE_POINTS = [
  'video, audio, image, face, and similarity senses',
  'OSINT scan, capture, monitor, and case memory',
  'one verb registry across CLI, plugin, and skills',
]
type InstallCommand = (typeof INSTALL_COMMANDS)[number]
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

function InstallTabs() {
  const [selected, setSelected] = useState<InstallCommand>(INSTALL_COMMANDS[0])
  const [copied, setCopied] = useState(false)

  async function copyCommand() {
    if ('clipboard' in navigator) {
      await navigator.clipboard.writeText(selected.command)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = selected.command
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.append(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
    setCopied(true)
    captureEvent('install_command_copied', {
      command: selected.command,
      method: selected.id,
    })
    window.setTimeout(() => setCopied(false), 1800)
  }

  function selectMethod(item: InstallCommand) {
    setSelected(item)
    setCopied(false)
    captureEvent('install_method_selected', { method: item.id })
  }

  return (
    <section className="border-2 border-ink bg-cream shadow-[6px_6px_0_0_var(--color-ink)]">
      <div
        role="tablist"
        aria-label="Ways to use overcast"
        className="grid grid-cols-3 border-b-2 border-ink"
      >
        {INSTALL_COMMANDS.map((item) => {
          const isSelected = item.id === selected.id
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls="install-panel"
              id={`install-tab-${item.id}`}
              onClick={() => selectMethod(item)}
              className={`min-h-12 border-r-2 border-ink px-2 py-2 text-center text-[0.65rem] font-bold tracking-[0.16em] uppercase last:border-r-0 focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-ink sm:text-xs ${
                isSelected ? 'bg-butter text-ink' : 'bg-white/55 text-ink/60 hover:bg-white'
              }`}
            >
              {item.label}
            </button>
          )
        })}
      </div>

      <button
        type="button"
        id="install-panel"
        role="tabpanel"
        aria-labelledby={`install-tab-${selected.id}`}
        onClick={() => void copyCommand()}
        className="group flex min-h-24 w-full items-center justify-between gap-4 px-4 py-4 text-left transition hover:bg-white/55 focus-visible:outline-3 focus-visible:outline-offset-[-6px] focus-visible:outline-ink sm:px-5"
        aria-label={`${selected.label}: copy ${selected.command}`}
      >
        <code className="min-w-0 whitespace-pre-wrap break-all text-sm text-ink sm:text-base">
          {selected.command}
        </code>
        <span className="shrink-0 bg-ink px-3 py-1.5 text-[0.65rem] font-bold tracking-[0.16em] text-cream uppercase">
          {copied ? 'copied' : 'copy'}
        </span>
      </button>
    </section>
  )
}

export default function App() {
  const tagline = useGlitchedTagline()

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-cream px-5 py-10 text-center font-mono text-ink sm:px-6 sm:py-16">
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

      <div className="relative flex w-full flex-col items-center gap-5 sm:gap-7">
        <img
          src="/logo.svg"
          alt="overcast — a suited figure with a CRT-TV head showing a watching eye, and a mounted CCTV camera"
          width={1254}
          height={1254}
          className="glitch-logo w-[clamp(210px,34vw,360px)]"
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

        <ul className="grid max-w-2xl gap-2 text-left text-xs font-semibold text-ink/70 sm:grid-cols-3 sm:text-sm">
          {FEATURE_POINTS.map((point) => (
            <li key={point} className="flex gap-2">
              <span aria-hidden className="text-ink">
                &gt;
              </span>
              <span>{point}</span>
            </li>
          ))}
        </ul>

        <div className="mt-1 flex w-full max-w-2xl flex-col items-stretch gap-5 text-left">
          <InstallTabs />
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
            <a
              href={NPM_URL}
              onClick={() => captureEvent('cta_clicked', { target: 'npm' })}
              className="-rotate-1 border-2 border-ink bg-[#cb3837] px-5 py-3 text-center text-sm font-bold text-white shadow-[5px_5px_0_0_var(--color-ink)] transition hover:-translate-y-0.5 hover:shadow-[7px_7px_0_0_var(--color-ink)] focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-ink"
              target="_blank"
              rel="noreferrer"
            >
              {'<npm>'}
            </a>
            <a
              href={SOURCE_URL}
              onClick={() => captureEvent('cta_clicked', { target: 'source' })}
              className="rotate-1 border-2 border-ink bg-ink px-5 py-3 text-center text-sm font-bold text-white shadow-[5px_5px_0_0_var(--color-ink)] transition hover:-translate-y-0.5 hover:shadow-[7px_7px_0_0_var(--color-ink)] focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-ink"
              target="_blank"
              rel="noreferrer"
            >
              {'<github>'}
            </a>
          </div>

          <p className="sr-only" aria-live="polite">
            Copy buttons copy installation commands to the clipboard.
          </p>
        </div>
      </div>
    </main>
  )
}
