// Tiny OS-open helpers for `view`. Kept separate so the verb logic stays
// testable without launching anything (the verb only calls these when not
// in --no-open mode).

import { spawn } from "node:child_process";

/** The platform "open this path" command. */
function openCommand(): { cmd: string; args: string[] } {
  if (process.platform === "darwin") return { cmd: "open", args: [] };
  if (process.platform === "win32") return { cmd: "cmd", args: ["/c", "start", ""] };
  return { cmd: "xdg-open", args: [] };
}

/** Hand a file/URL off to the OS open command (fire-and-forget). */
export function osOpen(target: string): void {
  const { cmd, args } = openCommand();
  try {
    const child = spawn(cmd, [...args, target], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* best-effort; the view record still records the path */
  }
}

/** Open a generated HTML player in the default browser (via OS open). */
export function openHtmlPlayer(htmlPath: string): void {
  osOpen(htmlPath);
}
