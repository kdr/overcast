// Typed fetch wrapper for the situation server API. The token arrives in the
// URL fragment (#t=…, set by the pairing QR/link) — Bearer header for API
// calls; media/SSE URLs carry ?token= because <video>/<img>/EventSource can't
// set headers. sessionStorage keeps a same-tab reload paired (chair precedent).

import type { SituationSnapshot } from "../../../src/situation/wire.js";

const TOKEN_KEY = "situation-token";

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

/** Drop the stored token — the server rejected it (rotated by a restart). */
export function clearToken(): void {
  store((s) => s.removeItem(TOKEN_KEY));
}

/** Attach the auth token to a server-relative media URL; remote URLs (the
 *  opt-in embeds) pass through untouched. */
export function mediaSrc(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("/media/")) return `${url}?token=${encodeURIComponent(pairToken())}`;
  return url;
}

async function call<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const res = await fetch(path, { method, headers: { Authorization: `Bearer ${pairToken()}` } });
  if (!res.ok) {
    if (res.status === 401) throw new Error("unauthorized");
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error || `${res.status}`);
  }
  return (await res.json()) as T;
}

export const getState = (): Promise<SituationSnapshot> => call<SituationSnapshot>("/api/state");
/** Force the server to rebuild from the current store ("sync to now") and return
 *  the fresh snapshot. */
export const forceSync = (): Promise<SituationSnapshot> => call<SituationSnapshot>("/api/refresh", "POST");
