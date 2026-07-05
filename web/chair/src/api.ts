// Typed fetch wrapper for the chair bridge API. The token arrives in the URL
// fragment (#t=…, set by the pairing QR) — it never reaches the server as a
// path/query for regular calls (Bearer header), and never touches storage
// other than sessionStorage so a same-tab reload keeps the pairing.

import type { CaseGlance, ChairPromptMode, ChairPromptResult, ChairSnapshot } from "../../../src/chair/wire.js";

const TOKEN_KEY = "chair-token";

// sessionStorage can throw (private browsing, storage disabled) — never let that
// abort boot; the URL #fragment is the source of truth, storage is just a
// same-tab reload convenience (matches the inline fallback's guarded access).
function store(op: (s: Storage) => void): void {
  try {
    op(sessionStorage);
  } catch {
    /* storage unavailable — carry on with the hash token */
  }
}

export function pairToken(): string {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("t");
  if (fromHash) {
    store((s) => s.setItem(TOKEN_KEY, fromHash));
    return fromHash;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Drop the stored token — called when the bridge rejects it (401, i.e. the
 *  token was rotated by /chair off) so a reload doesn't keep sending the
 *  revoked bearer; re-pairing then needs a fresh QR scan. */
export function clearToken(): void {
  store((s) => s.removeItem(TOKEN_KEY));
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${pairToken()}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    // any 401 is an auth failure regardless of body shape (a proxy may return
    // HTML) — surface it as "unauthorized" so the caller clears the token + gates
    if (res.status === 401) throw new Error("unauthorized");
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || `${res.status}`);
  }
  return (await res.json()) as T;
}

export const getState = (): Promise<ChairSnapshot> => call<ChairSnapshot>("/api/state");
export const getCase = (): Promise<CaseGlance> => call<CaseGlance>("/api/case");
export const postPrompt = (text: string, mode: ChairPromptMode): Promise<ChairPromptResult> =>
  call<ChairPromptResult>("/api/prompt", { text, mode });
export const postAbort = (): Promise<{ ok: boolean }> => call<{ ok: boolean }>("/api/abort", {});
