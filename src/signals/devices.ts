/**
 * Device-linking correlation — group case media by the camera that produced it.
 * Pure functions over records (no I/O), offline-testable like signals/triggers.ts.
 *
 * A serial number is a near-unique per-device id (a STRONG link — two clips with
 * the same serial almost certainly came from the same physical camera); make +
 * model + lens is a weaker "same model" hint (a WEAK link — many cameras share it).
 * Reads only `exif` records already in case memory; adds no index.
 */
import type { OvercastRecord } from "../record.js";

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

/** Roll all `exif` records up into device clusters. A serial-bearing record keys
 *  on its serial (a serial-less record for the same body can't be proven identical,
 *  so it stays separate); serial-less records key on make+model+lens. Members are
 *  deduped by media.ref, and only clusters of `minSize`+ distinct media are kept. */
export function buildDeviceClusters(records: OvercastRecord[], opts: { minSize?: number } = {}): DeviceRollup {
  const minSize = opts.minSize ?? 2;
  const groups = new Map<string, Acc>();
  let totalExif = 0;

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

    const strength: "serial" | "model" = serial ? "serial" : "model";
    const fingerprint = serial
      ? `serial:${norm(make)}|${norm(model)}|${norm(serial)}`
      : `model:${norm(make)}|${norm(model)}|${norm(lens)}`;

    let g = groups.get(fingerprint);
    if (!g) {
      g = { make, model, serial, lens, strength, members: new Map() };
      groups.set(fingerprint, g);
    }
    const memberKey = rec.media?.ref ?? rec.id;
    if (!g.members.has(memberKey)) {
      g.members.set(memberKey, {
        recordId: rec.id,
        ref: rec.media?.ref ?? null,
        created: str(p.created),
        place: str(p.place),
      });
    }
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
