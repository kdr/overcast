import { scheduleHeaderClearAndReplay } from "./branding.js";

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function includesConfirmedCaseClear(records: unknown): boolean {
  if (!Array.isArray(records)) return false;
  return records.some((rec) => {
    if (!isRecordLike(rec) || rec.verb !== "case" || rec.state !== "ready") return false;
    const payload = rec.payload;
    return isRecordLike(payload) && payload.cleared === true;
  });
}

export function maybeScheduleCaseClearReset(records: unknown, delayMs = 10_000): boolean {
  if (!includesConfirmedCaseClear(records)) return false;
  scheduleHeaderClearAndReplay(delayMs);
  return true;
}
