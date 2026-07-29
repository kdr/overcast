// Tiny OS-open helpers for `view`. Kept separate so the verb logic stays
// testable without launching anything (the verb only calls these when not
// in --no-open mode).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * Open a URL that carries a SECRET in its fragment (the situation/chair pairing
 * token) without ever putting that secret on a command line.
 *
 * `osOpen` passes its target as argv to `open`/`xdg-open` and then to the
 * browser, and a process table is readable by any other local user on Linux
 * (`/proc/<pid>/cmdline`) and by any same-uid process on macOS — so
 * `osOpen(pairingUrl)` published a bearer token that authorizes reading the
 * whole case (records, feed, media) off the loopback server. Instead: write a
 * one-shot redirect document to a 0700 temp dir as a 0600 file, open THAT path,
 * and delete it moments later. Only the file's owner can read the token, and the
 * argv the browser is launched with contains a path, not a credential.
 */
export function osOpenPrivateUrl(url: string): void {
  let dir: string | undefined;
  try {
    // mkdtemp is 0700 by default; be explicit about the file mode regardless.
    dir = mkdtempSync(join(tmpdir(), "overcast-pair-"));
    const file = join(dir, "open.html");
    const escaped = url.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
    );
    writeFileSync(
      file,
      `<!doctype html><meta charset="utf-8">` +
        `<meta http-equiv="refresh" content="0;url=${escaped}">` +
        `<title>opening overcast…</title>` +
        `<p>Opening <a href="${escaped}">the overcast console</a>…</p>` +
        `<script>location.replace(${JSON.stringify(url)})</script>`,
      { mode: 0o600 },
    );
    osOpen(file);
    // Give the browser time to read it, then remove the token from disk. Unref'd
    // so a short-lived CLI process is never held open by this timer.
    const t = setTimeout(() => {
      try {
        rmSync(dir as string, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }, 20_000);
    if (typeof t.unref === "function") t.unref();
  } catch {
    // Never fall back to osOpen(url) — that is exactly the argv leak this avoids.
    // The caller always also prints the pairing URL + QR for manual opening.
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
