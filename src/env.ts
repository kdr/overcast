import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_NAME_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)(?:_|$)/i;
// High-precision provider key prefixes: redact a bare secret VALUE even when it
// appears inline (e.g. embedded in a URL query string in provider stderr), where
// the name-based `KEY=…` line redaction below can't see it. Prefixes only — no
// generic hex/base64 (too many false positives on hashes/ids).
const SECRET_VALUE_RE = /\b(?:apify_api_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b/g;
const BASE_DOTENV_VALUES = new Map<string, string>();
const OVERRIDE_DOTENV_VALUES = new Map<string, string>();

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Env names an UNTRUSTED `.env` may not set.
 *
 * overcast auto-loads a dotenv from the process working directory and from
 * `--case <dir>` — directories that are routinely someone else's content (a
 * cloned repo, a downloaded dataset, a shared case folder). Two families of
 * variable turn that into credential theft or code execution, because overcast
 * pairs them with secrets it reads from the user's OWN home config:
 *   • endpoint redirection — `CLOUDGLUE_BASE_URL`, `HF_ENHANCE_ENDPOINT`,
 *     `*_API`, … send the resolved API key to a host the directory chose;
 *   • command/interpreter selection — `OVERCAST_*_CMD`, `*_PY`, `OVERCAST_FFMPEG`,
 *     … decide which binary gets spawned.
 * A dotenv in a TRUSTED root (the overcast package root, OVERCAST_HOME, or an
 * explicit OVERCAST_TRUST_DOTENV=1) keeps its full power — that is the dev/e2e
 * workflow. Anywhere else these keys are skipped, loudly.
 */
const SENSITIVE_DOTENV_KEY_RE =
  /(?:^|_)(?:CMD|PY|BIN|EXE|EXECUTABLE)$|_(?:BASE_URL|ENDPOINT|API|APIURL|HOST|ACTOR)$|^OVERCAST_(?:FFMPEG|FFPROBE|HOME)$|^PLAYWRIGHT_/;

export function isSensitiveDotEnvKey(key: string): boolean {
  return SENSITIVE_DOTENV_KEY_RE.test(key);
}

let packageRootCache: string | null | undefined;

/** The overcast package root (the dir holding its package.json), or null when it
 *  can't be resolved — e.g. inside the bun-compiled binary's virtual /$bunfs. */
function packageRoot(): string | null {
  if (packageRootCache !== undefined) return packageRootCache;
  packageRootCache = null;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    if (dir.includes("$bunfs") || dir === "/") return packageRootCache;
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, "package.json"))) {
        packageRootCache = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* leave null */
  }
  return packageRootCache;
}

/** Is a dotenv in this directory allowed to set command/endpoint variables? */
export function isTrustedDotEnvDir(dir: string): boolean {
  if (envEnabled("OVERCAST_TRUST_DOTENV")) return true;
  const target = resolvePath(dir);
  const home = process.env.OVERCAST_HOME
    ? resolvePath(process.env.OVERCAST_HOME)
    : join(homedir(), ".overcast");
  if (target === home) return true;
  const root = packageRoot();
  return root !== null && target === resolvePath(root);
}

export function loadDotEnv(dir = process.cwd(), opts: { override?: boolean } = {}): string | undefined {
  if (process.env.OVERCAST_NO_DOTENV === "1") return undefined;
  const file = join(dir, ".env");
  if (!existsSync(file)) {
    if (opts.override) clearOverrideDotEnv();
    return undefined;
  }
  const text = readFileSync(file, "utf8");
  const parsed = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const m = raw.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    parsed.set(m[1], unquoteEnvValue(m[2]));
  }
  // An untrusted directory's dotenv may carry ordinary settings, but not the
  // keys that redirect a credentialed call or choose a binary to spawn.
  if (!isTrustedDotEnvDir(dir)) {
    const skipped: string[] = [];
    for (const key of [...parsed.keys()]) {
      if (isSensitiveDotEnvKey(key)) {
        parsed.delete(key);
        skipped.push(key);
      }
    }
    if (skipped.length) {
      process.stderr.write(
        `overcast: ignoring ${skipped.length} command/endpoint variable(s) from an untrusted dotenv ${file}: ` +
          `${skipped.join(", ")}\n` +
          `  (they can redirect API calls or choose which binary runs — set OVERCAST_TRUST_DOTENV=1 to honor them)\n`,
      );
    }
  }
  if (opts.override) clearOverrideDotEnv(new Set(parsed.keys()));
  for (const [key, value] of parsed) {
    const previousOverride = OVERRIDE_DOTENV_VALUES.get(key);
    const previousBase = BASE_DOTENV_VALUES.get(key);
    const canOverrideDotEnvValue = opts.override && (
      (previousOverride !== undefined && process.env[key] === previousOverride) ||
      (previousBase !== undefined && process.env[key] === previousBase) ||
      process.env[key] === undefined
    );
    if (process.env[key] !== undefined && !canOverrideDotEnvValue) continue;
    process.env[key] = value;
    if (opts.override) OVERRIDE_DOTENV_VALUES.set(key, value);
    else BASE_DOTENV_VALUES.set(key, value);
  }
  return file;
}

function clearOverrideDotEnv(keep = new Set<string>()): void {
  for (const [key, value] of OVERRIDE_DOTENV_VALUES) {
    if (keep.has(key)) continue;
    if (process.env[key] === value) {
      const base = BASE_DOTENV_VALUES.get(key);
      if (base !== undefined) process.env[key] = base;
      else delete process.env[key];
    }
    OVERRIDE_DOTENV_VALUES.delete(key);
  }
}

export function redactSecrets(input: string): string {
  let out = input.replace(SECRET_VALUE_RE, "[REDACTED]");
  out = out.replace(
    /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:=|:\s*))(.+)$/gm,
    (full, prefix: string, name: string, value: string) => SECRET_NAME_RE.test(name) && value.trim() ? `${prefix}[REDACTED]` : full,
  );
  return out;
}

export function envPresent(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name] !== "";
}

/** True only for an AFFIRMATIVE env value (1/true/yes/on, case-insensitive). A
 *  bare `if (process.env.X)` truthy check treats `X=0` / `X=false` as enabled
 *  (they're non-empty strings) — use this for opt-in/opt-out toggles so an
 *  operator setting `=0` isn't silently read as "on". */
export function envEnabled(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
