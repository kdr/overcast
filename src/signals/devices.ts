/**
 * Device-linking correlation — group case media by the camera that produced it.
 * Pure functions over records (no I/O), offline-testable like signals/triggers.ts.
 *
 * A serial number is a near-unique per-device id (a STRONG link — two clips with
 * the same serial almost certainly came from the same physical camera); make +
 * model + lens is a weaker "same model" hint (a WEAK link — many cameras share it).
 * Reads only `exif` records already in case memory; adds no index.
 */
import { recordTimeMs, type OvercastRecord } from "../record.js";

export interface DeviceMember {
  recordId: string;
  ref: string | null;
  created: string | null;
  place: string | null;
}

export interface DeviceCluster {
  /** normalized key the cluster was grouped on (serial:… or model:…) */
  fingerprint: string;
  make: string | null;
  model: string | null;
  serial: string | null;
  lens: string | null;
  /** "serial" = a durable per-device id; "model" = make+model+lens only (weaker) */
  strength: "serial" | "model";
  /** distinct media in the cluster */
  count: number;
  members: DeviceMember[];
}

export interface DeviceRollup {
  clusters: DeviceCluster[];
  /** ready exif records considered */
  totalExif: number;
  /** distinct media that landed in a reported cluster */
  linkedMedia: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function norm(v: string | null): string {
  return (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

interface Acc {
  make: string | null;
  model: string | null;
  serial: string | null;
  lens: string | null;
  strength: "serial" | "model";
  members: Map<string, DeviceMember>;
}

interface FileCand {
  make: string | null;
  model: string | null;
  serial: string | null;
  lens: string | null;
  /** record time (epoch ms; NaN when undated) — newer wins on a same-strength tie */
  t: number;
  member: DeviceMember;
}

/** Whether candidate `a` should replace `b` as the collapsed entry for a file: a
 *  serial-bearing row beats a serial-less one; otherwise the NEWER row wins so a
 *  re-`exif` with a corrected serial supersedes the stale one, regardless of the
 *  order records were iterated. */
function betterCandidate(a: FileCand, b: FileCand): boolean {
  const aHas = !!a.serial;
  const bHas = !!b.serial;
  if (aHas !== bHas) return aHas;
  const at = Number.isNaN(a.t) ? -Infinity : a.t;
  const bt = Number.isNaN(b.t) ? -Infinity : b.t;
  return at > bt;
}

/** Roll all `exif` records up into device clusters. A serial-bearing record keys
 *  on its serial ALONE (a near-unique per-device id, robust to stripped make/model);
 *  serial-less records key on make+model+lens. Records are first collapsed to ONE
 *  entry PER FILE — preferring the serial-bearing record — so a file with both a
 *  serial-less and a serial-bearing exif record lands in a single cluster and is
 *  counted once. Only clusters of `minSize`+ distinct files are kept. */
export function buildDeviceClusters(records: OvercastRecord[], opts: { minSize?: number } = {}): DeviceRollup {
  const minSize = opts.minSize ?? 2;
  let totalExif = 0;

  // 1) collapse to one candidate per file (media.ref, else record id). Prefer the
  //    serial-bearing record so a later run that added a serial wins over an older
  //    serial-less one — the same file must not appear in two clusters.
  const perFile = new Map<string, FileCand>();
  for (const rec of records) {
    if (rec.verb !== "exif") continue;
    if (rec.state && rec.state !== "ready") continue;
    totalExif++;
    const p = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : {};
    const make = str(p.make);
    const model = str(p.model);
    const serial = str(p.serial);
    const lens = str(p.lens);
    // nothing identifying → can't be linked to a device
    if (!make && !model && !serial && !lens) continue;

    const fileKey = rec.media?.ref ?? rec.id;
    const cand: FileCand = {
      make,
      model,
      serial,
      lens,
      t: recordTimeMs(rec),
      member: { recordId: rec.id, ref: rec.media?.ref ?? null, created: str(p.created), place: str(p.place) },
    };
    const existing = perFile.get(fileKey);
    if (!existing || betterCandidate(cand, existing)) perFile.set(fileKey, cand);
  }

  // 2) cluster the per-file candidates
  const groups = new Map<string, Acc>();
  for (const cand of perFile.values()) {
    const strength: "serial" | "model" = cand.serial ? "serial" : "model";
    const fingerprint = cand.serial ? `serial:${norm(cand.serial)}` : `model:${norm(cand.make)}|${norm(cand.model)}|${norm(cand.lens)}`;

    let g = groups.get(fingerprint);
    if (!g) {
      g = { make: cand.make, model: cand.model, serial: cand.serial, lens: cand.lens, strength, members: new Map() };
      groups.set(fingerprint, g);
    } else {
      // backfill descriptive fields from any member that carries them (an earlier
      // member may have had make/model/lens stripped by an editor).
      g.make ??= cand.make;
      g.model ??= cand.model;
      g.lens ??= cand.lens;
    }
    // one member per file (perFile already deduped; the Map keeps that invariant).
    const memberKey = cand.member.ref ?? cand.member.recordId;
    if (!g.members.has(memberKey)) g.members.set(memberKey, cand.member);
  }

  const clusters: DeviceCluster[] = [];
  for (const [fingerprint, g] of groups) {
    if (g.members.size < minSize) continue;
    clusters.push({
      fingerprint,
      make: g.make,
      model: g.model,
      serial: g.serial,
      lens: g.lens,
      strength: g.strength,
      count: g.members.size,
      members: [...g.members.values()],
    });
  }
  // strongest (serial) links first, then largest clusters
  clusters.sort((a, b) => (a.strength === b.strength ? b.count - a.count : a.strength === "serial" ? -1 : 1));

  const linkedMedia = clusters.reduce((n, c) => n + c.count, 0);
  return { clusters, totalExif, linkedMedia };
}
