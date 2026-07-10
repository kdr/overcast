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

  // Two decoupled pieces of state:
  //  - `rec` — the recognizer whose onresult we still accept. It briefly
  //    OUTLIVES listening on a graceful stop() so the engine's final result
  //    (the usual last interim → final promotion) still lands before its onend.
  //  - `listening` — the UI / toggle state, flipped OFF synchronously by
  //    stop()/cancel() so the mic button + composer toggle react at once (a
  //    deferred onend must not gate the next start()).
  // Every engine callback is scoped to the instance that registered it
  // (`rec === self`), so a stopped/replaced session's late events are no-ops.
  let rec: SpeechRec | undefined;
  let listening = false;

  const start = (): void => {
    if (!Ctor || support !== "ok" || listening) return;
    // fresh recognizer per session — reuse after stop() is flaky across engines
    const self = new Ctor();
    let sawError = false; // did this session already surface a notice? (dedupe the start catch)
    self.continuous = true;
    self.interimResults = true;
    self.lang = navigator.language || "en-US";
    self.onresult = (e) => {
      if (rec !== self) return; // stale flush from a stopped/replaced session
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
      if (rec !== self) return;
      sawError = true;
      const message = ERROR_TEXT[e.error];
      if (message !== null) handlers.onError(message ?? `dictation failed: ${e.error}`);
    };
    self.onend = () => {
      // fires after stop(), abort(), errors, AND engine silence timeouts; only
      // the accepting session cleans up (a superseded instance already handed off,
      // so its late onend must not turn off the mic for the new session)
      if (rec !== self) return;
      rec = undefined;
      listening = false;
      handlers.onState(false);
    };
    rec = self;
    listening = true;
    handlers.onState(true);
    try {
      self.start();
    } catch {
      // some engines throw synchronously (e.g. InvalidStateError) with no onend
      // to follow — roll the optimistic state back (guarded so a racing newer
      // session is untouched). Skip the generic notice if onerror already fired
      // a specific one for this session, so one failed start = one notice.
      if (rec === self) {
        rec = undefined;
        listening = false;
        handlers.onState(false);
      }
      if (!sawError) handlers.onError("could not start dictation — try again");
    }
  };

  // Flip listening OFF synchronously so the mic UI + composer toggle react at
  // once. Graceful stop() keeps `rec` set so the engine's final result still
  // lands (until its onend clears it); hard cancel() clears `rec` immediately
  // and aborts, discarding the buffer (submit uses it so a late flush can't
  // repopulate the just-cleared box).
  const end = (hard: boolean): void => {
    const self = rec;
    if (!self && !listening) return;
    listening = false;
    handlers.onState(false);
    if (hard) rec = undefined; // drop the flush; graceful keeps accepting until onend
    try {
      if (hard) self?.abort();
      else self?.stop();
    } catch {
      /* already stopped */
    }
  };

  return {
    support,
    listening: () => listening,
    start,
    stop: () => end(false),
    cancel: () => end(true),
  };
}
