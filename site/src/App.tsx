export default function App() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-cream px-6 py-16 text-center font-mono text-ink">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="blob blob-mint blob-drift-a -top-[25%] -left-[20%] h-[75vmax] w-[75vmax]" />
        <div className="blob blob-sky blob-drift-b top-[-10%] right-[-25%] h-[65vmax] w-[65vmax]" />
        <div className="blob blob-butter blob-drift-c bottom-[-30%] left-[-10%] h-[70vmax] w-[70vmax]" />
        <div className="blob blob-blush blob-drift-d right-[-15%] bottom-[-20%] h-[55vmax] w-[55vmax]" />
        <div className="halftone absolute inset-0" />
      </div>

      <div className="relative flex w-full flex-col items-center gap-6 sm:gap-8">
        <img
          src="/logo.svg"
          alt="overcast — a suited figure with a CRT-TV head showing a watching eye, and a mounted CCTV camera"
          width={1254}
          height={1254}
          className="w-[clamp(240px,38vw,420px)] drop-shadow-[0_18px_40px_rgba(20,24,26,0.18)]"
        />

        <h1 className="wordmark text-[clamp(3rem,11vw,6.5rem)] leading-none font-bold tracking-tight lowercase">
          overcast
        </h1>

        <p className="text-[clamp(0.75rem,2.4vw,1.15rem)] tracking-[0.28em] text-ink/75 sm:tracking-[0.45em]">
          video · recon · osint
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
