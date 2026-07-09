// Device-linking correlation verb: a case-wide rollup that groups `exif` records
// by camera fingerprint (make/model/serial/lens) and reports media shot on the
// same device. A pure read over existing records (no new index) — analogous to
// how brief/ask read case memory. Cross-record links can't ride the per-record
// finding-trigger engine, so with --findings this verb creates the suggested
// findings itself (deduped by fingerprint so re-runs don't duplicate).

import { makeRecord, type OvercastRecord } from "../record.js";
import { makeFinding } from "./finding.js";
import { buildDeviceClusters } from "../signals/devices.js";
import type { VerbSpec } from "../registry/types.js";

/** Fingerprints of device-link findings already in the case, so re-running
 *  `devices --findings` never re-suggests the same cluster. */
function seenDeviceFingerprints(records: OvercastRecord[]): Set<string> {
  const seen = new Set<string>();
  for (const rec of records) {
    if (rec.verb !== "finding" || !rec.payload || typeof rec.payload !== "object") continue;
    const sig = (rec.payload as Record<string, unknown>).signal;
    if (sig && typeof sig === "object" && (sig as Record<string, unknown>).kind === "device-link") {
      const fp = (sig as Record<string, unknown>).fingerprint;
      if (typeof fp === "string") seen.add(fp);
    }
  }
  return seen;
}

export const devicesVerb: VerbSpec = {
  name: "devices",
  group: "inspect",
  summary: "Correlate case media by camera fingerprint (make/model/serial/lens) and report shared-device clusters.",
  description:
    "Rolls up all case `exif` records into device clusters keyed by make + model + serial + lens. A serial number " +
    "is a durable per-device id (a strong link — same serial ≈ same physical camera); when a serial is absent the " +
    "cluster falls back to make + model + lens (a weaker 'same model' hint). Reports every cluster of ≥2 media shot " +
    "on the same device — e.g. an anonymous account's photo sharing a camera serial with an identified one. Pure " +
    "read over records already in memory (no new index; run `exif` on media first so serial/lens are populated). " +
    "With --findings it also emits `suggested` findings for serial-linked (strong) clusters, deduped by fingerprint.",
  args: [],
  flags: [
    { name: "min", summary: "Minimum media per cluster to report", type: "number", default: 2 },
    { name: "findings", summary: "Also emit suggested findings for serial-linked (strong) clusters", type: "boolean" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "devices",
  providerKey: "devices",
  run: async (ctx) => {
    const minRaw = Number(ctx.opts.min ?? 2);
    const minSize = Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : 2;
    const records = ctx.case.records();
    const rollup = buildDeviceClusters(records, { minSize });

    const report = makeRecord({
      verb: "devices",
      format: "json",
      payload: {
        mode: "devices",
        clusters: rollup.clusters,
        total_exif: rollup.totalExif,
        linked_media: rollup.linkedMedia,
        ...(rollup.clusters.length
          ? {}
          : { note: "no shared-device clusters — run `exif <media>` on more media (serial/lens come from embedded EXIF)" }),
      },
      meta: { provider: "devices", case: ctx.case.dir },
      state: "ready",
    });

    const out: OvercastRecord[] = [report];

    if (ctx.opts.findings === true) {
      const seen = seenDeviceFingerprints(records);
      for (const cluster of rollup.clusters) {
        if (cluster.strength !== "serial" || cluster.count < 2) continue; // strong links only
        if (seen.has(cluster.fingerprint)) continue;
        const source = ctx.case.recordById(cluster.members[0].recordId);
        if (!source) continue; // representative record vanished — skip rather than fabricate one
        const device = [cluster.make, cluster.model].filter(Boolean).join(" ") || "camera";
        out.push(
          makeFinding({
            text: `${cluster.count} media share camera ${device} (serial ${cluster.serial})`,
            target: "",
            sourceRecord: source,
            trigger: "device-link",
            status: "suggested",
            confidence: "high",
            signal: {
              kind: "device-link",
              fingerprint: cluster.fingerprint,
              members: cluster.members.map((m) => m.recordId),
            },
          }),
        );
      }
    }

    return out;
  },
};
