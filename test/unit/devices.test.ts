import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { makeRecord, type OvercastRecord } from "../../src/record.ts";
import { buildDeviceClusters } from "../../src/signals/devices.ts";
import { devicesVerb } from "../../src/verbs/devices.ts";
import type { VerbContext } from "../../src/registry/types.ts";

function exif(opts: { ref: string; make?: string; model?: string; serial?: string; lens?: string; created?: string }): OvercastRecord {
  return makeRecord({
    verb: "exif",
    format: "json",
    payload: {
      summary: "meta",
      make: opts.make ?? null,
      model: opts.model ?? null,
      serial: opts.serial ?? null,
      lens: opts.lens ?? null,
      created: opts.created ?? null,
    },
    media: { ref: opts.ref },
  });
}

test("buildDeviceClusters: same serial links distinct media as a strong cluster", () => {
  const r = buildDeviceClusters([
    exif({ ref: "a.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }),
    exif({ ref: "b.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }),
  ]);
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].strength, "serial");
  assert.equal(r.clusters[0].count, 2);
  assert.equal(r.clusters[0].serial, "SN1");
  assert.equal(r.linkedMedia, 2);
  assert.equal(r.totalExif, 2);
});

test("buildDeviceClusters: same serial links across stripped/inconsistent make/model", () => {
  const r = buildDeviceClusters([
    exif({ ref: "a.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }),
    exif({ ref: "b.jpg", serial: "SN1" }), // make/model stripped by an editor
  ]);
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].strength, "serial");
  assert.equal(r.clusters[0].count, 2);
  assert.equal(r.clusters[0].make, "Canon"); // backfilled from the member that carried it
  assert.equal(r.clusters[0].model, "EOS R5");
});

test("buildDeviceClusters: serial-less media fall back to a weaker make+model+lens link", () => {
  const r = buildDeviceClusters([
    exif({ ref: "a.jpg", make: "Apple", model: "iPhone 15", lens: "main" }),
    exif({ ref: "b.jpg", make: "Apple", model: "iPhone 15", lens: "main" }),
  ]);
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].strength, "model");
  assert.equal(r.clusters[0].serial, null);
});

test("buildDeviceClusters: a serial-bearing and serial-less record for the same model do NOT merge", () => {
  const r = buildDeviceClusters([
    exif({ ref: "a.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }),
    exif({ ref: "b.jpg", make: "Canon", model: "EOS R5" }),
  ]);
  // one serial cluster (size 1) + one model cluster (size 1) — neither reaches min 2
  assert.equal(r.clusters.length, 0);
});

test("buildDeviceClusters: a file with both serial-less and serial records lands in ONE cluster (no double count)", () => {
  const r = buildDeviceClusters([
    exif({ ref: "x.jpg", make: "Canon", model: "EOS R5" }), // x, older run: no serial
    exif({ ref: "x.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }), // x, newer run: serial
    exif({ ref: "y.jpg", make: "Canon", model: "EOS R5" }), // y: serial-less R5
    exif({ ref: "z.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }), // z: serial
  ]);
  // x collapses to its serial record → the serial:SN1 cluster {x,z}; the model
  // cluster {y} is size 1 and dropped. x is counted once, in exactly one cluster.
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].strength, "serial");
  assert.equal(r.clusters[0].count, 2);
  assert.deepEqual(r.clusters[0].members.map((m) => m.ref).sort(), ["x.jpg", "z.jpg"]);
  assert.equal(r.linkedMedia, 2); // not 4 — x not double-counted
});

test("buildDeviceClusters: members dedup by media.ref; single-media clusters are dropped", () => {
  const r = buildDeviceClusters([
    exif({ ref: "same.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }),
    exif({ ref: "same.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }),
  ]);
  assert.equal(r.clusters.length, 0); // one distinct media → below min size
  assert.equal(r.totalExif, 2);
});

test("buildDeviceClusters: records with no identifying device fields are ignored", () => {
  const r = buildDeviceClusters([exif({ ref: "a.jpg" }), exif({ ref: "b.jpg" })]);
  assert.equal(r.clusters.length, 0);
  assert.equal(r.totalExif, 2);
});

test("buildDeviceClusters: strong (serial) clusters sort ahead of weak (model) ones", () => {
  const r = buildDeviceClusters([
    exif({ ref: "m1.jpg", make: "Apple", model: "iPhone 15" }),
    exif({ ref: "m2.jpg", make: "Apple", model: "iPhone 15" }),
    exif({ ref: "s1.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }),
    exif({ ref: "s2.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }),
  ]);
  assert.equal(r.clusters.length, 2);
  assert.equal(r.clusters[0].strength, "serial");
  assert.equal(r.clusters[1].strength, "model");
});

function withCase(fn: (c: ReturnType<typeof openCase>) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-devices-"));
  const c = openCase(dir);
  c.ensure();
  return Promise.resolve(fn(c)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function ctxFor(c: ReturnType<typeof openCase>, opts: Record<string, unknown> = {}): VerbContext {
  return { input: undefined, rest: [], opts, case: c, profile: { name: "test", providers: {} }, profileName: "test" } as unknown as VerbContext;
}

test("devicesVerb: emits a report record; --findings creates a deduped serial-link lead", () =>
  withCase(async (c) => {
    c.writeRecord(exif({ ref: "a.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }));
    c.writeRecord(exif({ ref: "b.jpg", make: "Canon", model: "EOS R5", serial: "SN1" }));

    const report = await devicesVerb.run(ctxFor(c));
    assert.equal(report.length, 1);
    const rp = report[0].payload as Record<string, unknown>;
    assert.equal(rp.mode, "devices");
    assert.equal((rp.clusters as unknown[]).length, 1);

    const withFindings = await devicesVerb.run(ctxFor(c, { findings: true }));
    const finding = withFindings.find((r) => r.verb === "finding");
    assert.ok(finding, "a device-link finding was created");
    const fp = finding.payload as Record<string, unknown>;
    assert.equal(fp.status, "suggested");
    assert.equal(fp.trigger, "device-link");
    assert.equal((fp.signal as Record<string, unknown>).kind, "device-link");
    assert.match(String(fp.text), /share camera Canon EOS R5 \(serial SN1\)/);

    // persist the finding, then a second --findings run must NOT re-suggest it
    c.writeRecord(finding);
    const again = await devicesVerb.run(ctxFor(c, { findings: true }));
    assert.equal(again.some((r) => r.verb === "finding"), false);
  }));
