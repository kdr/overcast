// Voice dictation via the Web Speech API (SpeechRecognition /
// webkitSpeechRecognition) — the browser owns mic permission + transcription,
// so the bridge/wire stay text-only and untouched. Support tiers:
//   "ok"          — API present in a secure context (localhost counts)
//   "insecure"    — API present but the page is plain-HTTP on a non-localhost
//                   origin (e.g. the tailnet bind); the mic prompt would be
//                   auto-denied, so the caller should explain the HTTPS fix
//   "unsupported" — no SpeechRecognition at all (e.g. Firefox default)

// TS lib.dom still doesn't ship Web Speech types (and the chair tsconfig has
// `types: []`), so declare the minimal surface we use.
interface SpeechResultEvent {
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
  };
}
interface SpeechErrorEvent {
  error: string;
}
interface SpeechRec {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecCtor = new () => SpeechRec;

export type DictationSupport = "ok" | "insecure" | "unsupported";

export interface Dictation {
  support: DictationSupport;
  listening(): boolean;
  start(): void;
  /** Stop dictation, keeping the transcript captured so far; listening() flips
   *  off synchronously so the mic toggle can restart immediately. */
  stop(): void;
  /** Stop and discard the engine buffer (used when the composer submits). */
  cancel(): void;
}

const ERROR_TEXT: Record<string, string | null> = {
  "not-allowed": "mic permission denied — allow the microphone for this site",
  "service-not-allowed": "speech service unavailable on this browser",
  "audio-capture": "no microphone found",
  network: "speech service unreachable",
  "no-speech": null, // silence timeout — just ends the session, not an error
  aborted: null, // our own cancel()
};

export function createDictation(handlers: {
  /** Live transcript for the current session: finalized text + in-flight interim. */
  onText: (finalText: string, interim: string) => void;
  onState: (listening: boolean) => void;
  onError: (message: string) => void;
}): Dictation {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecCtor;
    webkitSpeechRecognition?: SpeechRecCtor;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  const support: DictationSupport = !Ctor ? "unsupported" : window.isSecureContext ? "ok" : "insecure";

  // `rec` is the CURRENT recognizer (undefined ⇒ not listening). The engine
  // keeps emitting onresult/onend after stop()/abort() and across a restart, so
  // every callback is scoped to the instance that registered it (`rec === self`):
  // a prior session's late event can't mutate the new session's state.
  let rec: SpeechRec | undefined;

  const start = (): void => {
    if (!Ctor || support !== "ok" || rec) return;
    // fresh recognizer per session — reuse after stop() is flaky across engines
    const self = new Ctor();
    const current = (): boolean => rec === self;
    self.continuous = true;
    self.interimResults = true;
    self.lang = navigator.language || "en-US";
    self.onresult = (e) => {
      if (!current()) return; // stale flush from a stopped/replaced session
      // rebuild from the full result list every event: idempotent, and iOS
      // Safari replaces earlier entries rather than only appending
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      handlers.onText(finalText, interim);
    };
    self.onerror = (e) => {
      if (!current()) return;
      const message = ERROR_TEXT[e.error];
      if (message !== null) handlers.onError(message ?? `dictation failed: ${e.error}`);
    };
    self.onend = () => {
      // fires after stop(), abort(), errors, AND engine silence timeouts; only
      // the current session cleans up (a superseded instance already handed off,
      // so its late onend must not turn off the mic for the new session)
      if (!current()) return;
      rec = undefined;
      handlers.onState(false);
    };
    rec = self;
    handlers.onState(true);
    try {
      self.start();
    } catch {
      // some engines throw synchronously (e.g. InvalidStateError) with no onend
      // to follow — roll the optimistic state back so the mic "on" UI can't
      // stick (guarded so a racing newer session is left untouched)
      if (current()) {
        rec = undefined;
        handlers.onState(false);
      }
      handlers.onError("could not start dictation — try again");
    }
  };

  // Stop the current session and flip listening OFF *synchronously* (clear
  // `rec`) so the mic UI + the composer's start/stop toggle react at once —
  // waiting for the engine's async onend left listening() stale, so a second
  // tap re-stopped instead of starting. The just-ended instance's late events
  // are then dropped by the identity guard above. hard=true (submit) aborts +
  // discards the engine buffer; graceful (mic tap) stop()s so nothing is pending.
  const end = (hard: boolean): void => {
    const self = rec;
    if (!self) return;
    rec = undefined;
    handlers.onState(false);
    try {
      if (hard) self.abort();
      else self.stop();
    } catch {
      /* already stopped */
    }
  };

  return {
    support,
    listening: () => rec !== undefined,
    start,
    stop: () => end(false),
    cancel: () => end(true),
  };
}
