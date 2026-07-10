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
  /** Graceful stop — the recognizer may still flush a final result. */
  stop(): void;
  /** Hard stop — mutes any late flush (used when the composer submits). */
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

  let rec: SpeechRec | undefined;
  let live = false;

  const start = (): void => {
    if (!Ctor || support !== "ok" || live) return;
    // fresh recognizer per session — reuse after stop() is flaky across engines
    rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e) => {
      if (!live) return; // cancelled — drop the late flush
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
    rec.onerror = (e) => {
      const message = ERROR_TEXT[e.error];
      if (live && message !== null) handlers.onError(message ?? `dictation failed: ${e.error}`);
    };
    rec.onend = () => {
      // fires after stop(), abort(), errors, AND engine silence timeouts
      if (!live) return;
      live = false;
      handlers.onState(false);
    };
    live = true;
    handlers.onState(true);
    try {
      rec.start();
    } catch {
      // some engines throw synchronously (e.g. InvalidStateError) with no
      // onend to follow — roll the optimistic listening state back so the mic
      // "on" UI can't stick until an unrelated cancel() (matches end()'s guard)
      live = false;
      handlers.onState(false);
      handlers.onError("could not start dictation — try again");
    }
  };

  const end = (hard: boolean): void => {
    if (!live) return;
    if (hard) live = false; // mute onresult/onerror before the engine reacts
    try {
      if (hard) rec?.abort();
      else rec?.stop();
    } catch {
      /* already stopped */
    }
    if (hard) handlers.onState(false);
  };

  return {
    support,
    listening: () => live,
    start,
    stop: () => end(false),
    cancel: () => end(true),
  };
}
