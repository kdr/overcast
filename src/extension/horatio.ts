// Unlisted TUI easter egg. A message that is exactly "/yeah" — or a lone
// sunglasses emoji — plays the case-opening sting (assets/branding/sting.m4a)
// and drops the signature one-liner. Hooked on the raw `input` event instead of
// registerCommand so it never shows up in the slash-command autocomplete, and
// `{ action: "handled" }` keeps the trigger out of the LLM context entirely.
// Audio is fire-and-forget best-effort: afplay on macOS, ffplay elsewhere
// (resolved beside OVERCAST_FFMPEG when that override is set); a missing player
// or asset degrades to just the text.

import { spawn } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shippedPath } from "../pkg.js";
import { FFMPEG_PATH } from "../media/ffmpeg.js";
import { emitResult } from "./slash.js";

const STING_SEGMENTS = ["assets", "branding", "sting.m4a"];

const ONE_LINER = [
  "( •_•)",
  "( •_•)>⌐■-■",
  "(⌐■_■)   YEEEEAAAAAAAAHH!",
].join("\n");

/** Exactly "/yeah" or a lone sunglasses emoji (😎 / 🕶, variation selectors ignored). */
export function isYeahTrigger(text: string): boolean {
  const t = text.trim().replace(/\uFE0F/g, "");
  return t === "/yeah" || t === "\u{1F60E}" || t === "\u{1F576}";
}

/** ffplay ships beside ffmpeg — follow an absolute OVERCAST_FFMPEG override. */
function ffplayPath(): string {
  return isAbsolute(FFMPEG_PATH) ? join(dirname(FFMPEG_PATH), "ffplay") : "ffplay";
}

/** Player candidates in preference order for this platform. */
export function playerCandidates(file: string): Array<{ cmd: string; args: string[] }> {
  const ffplay = { cmd: ffplayPath(), args: ["-nodisp", "-autoexit", "-loglevel", "quiet", file] };
  if (process.platform === "darwin") return [{ cmd: "afplay", args: [file] }, ffplay];
  return [ffplay];
}

/** Fire-and-forget playback: try each candidate until one starts and exits clean. */
function playSting(file: string, candidates = playerCandidates(file)): void {
  const [first, ...rest] = candidates;
  if (!first) return;
  try {
    const child = spawn(first.cmd, first.args, { stdio: "ignore", detached: true });
    let advanced = false;
    const next = (): void => {
      if (advanced) return;
      advanced = true;
      playSting(file, rest);
    };
    child.once("error", next);
    child.once("exit", (code) => {
      if (code !== 0) next();
    });
    child.unref();
  } catch {
    playSting(file, rest);
  }
}

/** Hook the easter egg onto the raw input stream (before template expansion). */
export function registerYeahEasterEgg(pi: ExtensionAPI, play: (file: string) => void = playSting): void {
  pi.on("input", (event) => {
    if (!isYeahTrigger(event.text)) return;
    const sting = shippedPath(...STING_SEGMENTS);
    if (sting) play(sting);
    emitResult(pi, ONE_LINER);
    return { action: "handled" };
  });
}
