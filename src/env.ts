import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_NAME_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)(?:_|$)/i;
const SECRET_VALUE_RE = /\b(?:apify_api_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b/g;
const DOTENV_KEYS = new Set<string>();

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
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const m = raw.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined && !(opts.override && DOTENV_KEYS.has(key))) continue;
    process.env[key] = unquoteEnvValue(m[2]);
    DOTENV_KEYS.add(key);
  }
  return file;
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
