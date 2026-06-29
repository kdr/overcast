import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_NAME_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)(?:_|$)/i;
const SECRET_VALUE_RE = /\b(?:apify_api_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b/g;
const DOTENV_VALUES = new Map<string, string>();

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function loadDotEnv(dir = process.cwd(), opts: { override?: boolean } = {}): string | undefined {
  if (process.env.OVERCAST_NO_DOTENV === "1") return undefined;
  const file = join(dir, ".env");
  if (!existsSync(file)) {
    if (opts.override) clearLoadedDotEnv();
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
  if (opts.override) clearLoadedDotEnv(new Set(parsed.keys()));
  for (const [key, value] of parsed) {
    const previous = DOTENV_VALUES.get(key);
    const canOverrideDotEnvValue = opts.override && previous !== undefined && process.env[key] === previous;
    if (process.env[key] !== undefined && !canOverrideDotEnvValue) continue;
    process.env[key] = value;
    DOTENV_VALUES.set(key, value);
  }
  return file;
}

function clearLoadedDotEnv(keep = new Set<string>()): void {
  for (const [key, value] of DOTENV_VALUES) {
    if (keep.has(key)) continue;
    if (process.env[key] === value) delete process.env[key];
    DOTENV_VALUES.delete(key);
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
