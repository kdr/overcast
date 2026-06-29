import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import { addSource, listSources } from "../../src/state/source.ts";
import { addTarget, listTargets } from "../../src/state/target.ts";
import { addIndex, addMember } from "../../src/state/index.ts";
import type { VerbContext } from "../../src/registry/types.ts";

function withCase(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-casev-"));
  const c = openCase(dir); c.ensure();
  c.writeRecord(makeRecord({ verb: "watch", payload: { content: "white van at the docks" }, media: { ref: "x.mp4" } }));
  c.writeRecord(makeRecord({ verb: "scan", payload: { title: "feed" } }));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const ctx = (dir: string, input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext =>
  ({ input, rest, opts, case: openCase(dir), profile: defaultProfile() });
const noIndex = { "no-index": true };

test("case info reports record count + per-verb counts", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "info"));
    assert.equal((rec.payload as Record<string, unknown>).records, 2);
    assert.deepEqual((rec.payload as Record<string, unknown>).counts, { watch: 1, scan: 1 });
  });
});
test("case records --verb filters", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "records", [], { verb: "watch" }));
    const recs = (rec.payload as Record<string, unknown>).records as unknown[];
    assert.equal(recs.length, 1);
  });
});

test("case clear previews what will be lost and requires --yes", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    writeFileSync(c.sourcesFile, JSON.stringify({ sources: [] }));
    writeFileSync(join(dir, "brief.html"), "<html></html>");

    const [rec] = await caseVerb.run(ctx(dir, "clear"));
    assert.equal(rec.state, "pending");
    assert.equal(rec.meta?.transient, true);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.confirmation_required, true);
    assert.match(String(p.confirm_with), /case clear --yes/);
    assert.equal(((p.will_lose as Record<string, unknown>).records), 2);
    assert.deepEqual(((p.will_lose as Record<string, unknown>).artifacts), ["brief.html"]);
    assert.equal(c.records().length, 2, "preview leaves records intact");
    assert.equal(existsSync(c.sourcesFile), true, "preview leaves state intact");
    assert.equal(existsSync(join(dir, "brief.html")), true, "preview leaves artifacts intact");
  });
});

test("case clear --yes clears records and state without persisting itself", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    writeFileSync(c.sourcesFile, JSON.stringify({ sources: [] }));
    writeFileSync(join(dir, "brief.html"), "<html></html>");

    const [rec] = await caseVerb.run(ctx(dir, "clear", [], { yes: true }));
    assert.equal(rec.state, "ready");
    assert.equal(rec.meta?.transient, true);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.cleared, true);
    assert.equal(((p.lost as Record<string, unknown>).records), 2);
    assert.deepEqual(((p.lost as Record<string, unknown>).artifacts), ["brief.html"]);
    assert.equal(c.records().length, 0);
    assert.equal(existsSync(c.sourcesFile), false);
    assert.equal(existsSync(join(dir, "brief.html")), false);
  });
});

test("case memory search returns passages", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["search", "white", "van"]));
    assert.ok(((rec.payload as Record<string, unknown>).passages as unknown[]).length >= 1);
  });
});
test("case unknown action errors", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "frob"));
    assert.equal(rec.state, "error");
  });
});

test("case setup without flags explains the case is not set up yet", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "setup"));
    const payload = rec.payload as Record<string, unknown>;
    assert.equal(rec.state, "pending");
    assert.equal(payload.status, "case has not been set up yet");
    assert.deepEqual(payload.wizard_steps, [
      "1. Case name",
      "2. Investigation target",
      "3. Sources or local media",
      "4. Indexes/search destinations",
      "5. Notes",
      "6. Preview and apply",
    ]);
  });
});

test("case setup without flags does not say completed setup is missing", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const records = await caseVerb.run(ctx(dir, "setup", [], { target: "done", yes: true }));
    c.writeRecord(records.at(-1)!);

    const [rec] = await caseVerb.run(ctx(dir, "setup"));
    const payload = rec.payload as Record<string, unknown>;
    assert.equal(payload.completed, true);
    assert.equal(payload.status, "case setup complete");
    assert.doesNotMatch(String(payload.note), /not been set up yet/);
  });
});

test("case setup --yes seeds setup.json from existing registries", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    addTarget(c, "existing target");
    addSource(c, "web:existing query");
    addIndex(c, { id: "idx_existing", name: "Existing Media", type: "media-descriptions" });
    addMember(c, "idx_existing", { ref: "existing.mp4" });

    const records = await caseVerb.run(ctx(dir, "setup", [], { yes: true }));
    const setupRecord = records.at(-1)!;
    c.writeRecord(setupRecord);

    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.equal(saved.completed, true);
    assert.deepEqual(saved.targets, ["existing target"]);
    assert.deepEqual(saved.sources, ["web:existing query"]);
    assert.deepEqual((saved.indexes as Array<Record<string, unknown>>).map((i) => i.id), ["idx_existing"]);
    assert.deepEqual(((saved.media as Record<string, unknown>).routes as Array<Record<string, unknown>>)[0], {
      ref: "existing.mp4",
      signals: ["watch"],
      indexes: ["idx_existing"],
    });
  });
});

test("case setup status/show before and after saved setup", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const [before] = await caseVerb.run(ctx(dir, "setup", ["status"]));
    assert.equal(((before.payload as Record<string, unknown>).setup as Record<string, unknown>).completed, false);

    const records = await caseVerb.run(ctx(dir, "setup", [], {
      name: "Harbor Case",
      target: "white van",
      source: "web:white van",
      note: "startup note",
      yes: true,
    }));
    const setupRecord = records.at(-1)!;
    c.writeRecord(setupRecord);
    assert.equal(setupRecord.state, "ready");
    assert.equal((setupRecord.payload as Record<string, unknown>).op, "startup_setup");
    assert.equal(existsSync(c.setupFile), true);

    const [show] = await caseVerb.run(ctx(dir, "setup", ["show"]));
    const saved = show.payload as Record<string, unknown>;
    assert.equal(saved.case_name, "Harbor Case");
    assert.deepEqual(saved.targets, ["white van"]);
    assert.deepEqual(saved.sources, ["web:white van"]);

    const [after] = await caseVerb.run(ctx(dir, "setup", ["status"]));
    assert.equal(((after.payload as Record<string, unknown>).setup as Record<string, unknown>).completed, true);
  });
});

test("case setup edit updates setup file, applies registries, and emits update record", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], { target: "alpha", source: "web:alpha", yes: true }));
    c.writeRecord(records.at(-1)!);

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { target: "bravo", source: "youtube:@bravo", index: "col_face:face:Faces", yes: true, ...noIndex }));
    const update = records.at(-1)!;
    c.writeRecord(update);
    assert.equal((update.payload as Record<string, unknown>).op, "startup_setup_update");
    assert.match(JSON.stringify((update.payload as Record<string, unknown>).applied_operations), /bravo/);

    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.equal(saved.last_update_record_id, update.id);
    assert.deepEqual(saved.targets, ["alpha", "bravo"]);
    assert.deepEqual(saved.sources, ["web:alpha", "youtube:@bravo"]);
    assert.equal(listTargets(c).some((t) => t.value === "bravo"), true);
    assert.equal(listSources(c).some((s) => s.type === "youtube" && s.ref === "@bravo"), true);
  });
});

test("case setup plan does not save or apply", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const [plan] = await caseVerb.run(ctx(dir, "setup", ["plan"], { target: "planned", source: "web:planned" }));
    assert.equal(plan.state, "pending");
    assert.equal(plan.meta?.transient, true);
    assert.equal((((plan.payload as Record<string, unknown>).after as Record<string, unknown>).completed), false);
    assert.equal(existsSync(c.setupFile), false);
    assert.equal(listTargets(c).some((t) => t.value === "planned"), false);
  });
});

test("case setup plan reports unresolved remote indexes as incomplete", async () => {
  await withCase(async (dir) => {
    const [plan] = await caseVerb.run(ctx(dir, "setup", ["plan"], { index: "Scenes:media-descriptions" }));
    const payload = plan.payload as Record<string, unknown>;
    assert.deepEqual(payload.incomplete_indexes, [{ name: "Scenes", type: "media-descriptions" }]);
    assert.equal(((payload.after as Record<string, unknown>).completed), false);
  });
});

test("case setup stores provider policy, automation, and findings settings", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const records = await caseVerb.run(ctx(dir, "setup", [], {
      provider: "listen:elevenlabs,see:local-detect",
      "provider-indexable": "listen,see",
      "auto-sense": "watch,listen",
      "auto-index-new": true,
      findings: "review",
      yes: true,
      ...noIndex,
    }));
    c.writeRecord(records.at(-1)!);
    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    const providers = saved.providers as Record<string, Record<string, unknown>>;
    assert.equal(providers.listen.choice, "elevenlabs");
    assert.equal(providers.listen.indexable, true);
    assert.equal(providers.see.choice, "local-detect");
    assert.deepEqual(saved.automation, { auto_sense: ["watch", "listen"], auto_index_new: true });
    assert.deepEqual(saved.findings, { mode: "review" });
  });
});

test("case setup only marks providers indexable when provider-indexable selects them", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const records = await caseVerb.run(ctx(dir, "setup", [], {
      provider: "listen:elevenlabs,see:local-detect",
      "provider-indexable": "listen",
      yes: true,
      ...noIndex,
    }));
    c.writeRecord(records.at(-1)!);
    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    const providers = saved.providers as Record<string, Record<string, unknown>>;
    assert.equal(providers.listen.indexable, true);
    assert.equal(providers.see.indexable, false);
  });
});

test("case setup provider edit preserves indexable when provider-indexable is omitted", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], {
      provider: "listen:elevenlabs",
      "provider-indexable": "listen",
      yes: true,
      ...noIndex,
    }));
    c.writeRecord(records.at(-1)!);

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], {
      provider: "listen:tinycloud",
      yes: true,
      ...noIndex,
    }));
    c.writeRecord(records.at(-1)!);
    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    const providers = saved.providers as Record<string, Record<string, unknown>>;
    assert.equal(providers.listen.choice, "tinycloud");
    assert.equal(providers.listen.indexable, true);
  });
});

test("case setup provider-indexable can clear existing indexable flags", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], {
      provider: "listen:elevenlabs,see:local-detect",
      "provider-indexable": "listen,see",
      yes: true,
      ...noIndex,
    }));
    c.writeRecord(records.at(-1)!);

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], {
      "provider-indexable": "",
      yes: true,
      ...noIndex,
    }));
    c.writeRecord(records.at(-1)!);
    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    const providers = saved.providers as Record<string, Record<string, unknown>>;
    assert.equal(providers.listen.indexable, false);
    assert.equal(providers.see.indexable, false);
  });
});

test("case setup edit can disable auto-index-new", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], { "auto-index-new": true, yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);
    let saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.automation, { auto_sense: [], auto_index_new: true });

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { "no-auto-index-new": true, yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);
    saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.automation, { auto_sense: [], auto_index_new: false });
  });
});

test("case setup edit can clear auto-sense with an empty value", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], { "auto-sense": "watch,listen", yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);
    let saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual((saved.automation as Record<string, unknown>).auto_sense, ["watch", "listen"]);

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { "auto-sense": "", yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);
    saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual((saved.automation as Record<string, unknown>).auto_sense, []);
  });
});

test("case setup rejects unknown provider choices and finding modes", async () => {
  await withCase(async (dir) => {
    const [badProvider] = await caseVerb.run(ctx(dir, "setup", ["plan"], { provider: "listen:nope" }));
    assert.equal(badProvider.state, "error");
    assert.match(badProvider.error ?? "", /unknown provider choice/);
    const [badFinding] = await caseVerb.run(ctx(dir, "setup", ["plan"], { findings: "auto-delete" }));
    assert.equal(badFinding.state, "error");
    assert.match(badFinding.error ?? "", /unknown --findings mode/);
  });
});

test("case setup plan does not initialize an unopened case store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-setup-plan-"));
  try {
    const [plan] = await caseVerb.run(ctx(dir, "setup", ["plan"], { target: "planned" }));
    assert.equal(plan.state, "pending");
    assert.equal(existsSync(openCase(dir).caseFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case setup edit with no saved setup records startup_setup, not update", async () => {
  await withCase(async (dir) => {
    const records = await caseVerb.run(ctx(dir, "setup", ["edit"], { target: "first", yes: true }));
    const setupRecord = records.at(-1)!;
    assert.equal((setupRecord.payload as Record<string, unknown>).op, "startup_setup");
  });
});

test("case setup registers image path targets as image targets", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const img = join(dir, "reference.webp");
    writeFileSync(img, "fake image");
    const records = await caseVerb.run(ctx(dir, "setup", [], { target: img, yes: true }));
    c.writeRecord(records.at(-1)!);

    const [target] = listTargets(c);
    assert.equal(target.value, img);
    assert.equal(target.kind, "image");
  });
});

test("case setup supports explicit face-ref image targets", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const img = join(dir, "reference.jpg");
    writeFileSync(img, "fake image");
    await caseVerb.run(ctx(dir, "setup", [], { "face-ref": img, yes: true }));

    const [target] = listTargets(c);
    assert.equal(target.value, img);
    assert.equal(target.kind, "image");
  });
});

test("case setup note preserves commas as one note", async () => {
  await withCase(async (dir) => {
    const records = await caseVerb.run(ctx(dir, "setup", [], { note: "spotted around August 4, 2024", yes: true }));
    const notes = records.filter((r) => r.verb === "note");
    assert.equal(notes.length, 1);
    assert.equal((notes[0].payload as Record<string, unknown>).text, "spotted around August 4, 2024");
  });
});

test("case setup duplicate note updates setup but emits no duplicate note record", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], { note: "same note", yes: true }));
    for (const rec of records) c.writeRecord(rec);
    assert.equal(records.filter((r) => r.verb === "note").length, 1);

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { note: "same note", yes: true }));
    for (const rec of records) c.writeRecord(rec);
    assert.equal(records.filter((r) => r.verb === "note").length, 0);
    assert.equal(c.records().filter((r) => r.verb === "note" && JSON.stringify(r.payload).includes("same note")).length, 1);
  });
});

test("case setup remove-target/remove-source by registry id syncs setup.json", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], { target: "alpha", source: "web:alpha", yes: true }));
    c.writeRecord(records.at(-1)!);
    const targetId = listTargets(c).find((t) => t.value === "alpha")!.id;
    const sourceId = listSources(c).find((s) => s.type === "web" && s.ref === "alpha")!.id;

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { "remove-target": targetId, "remove-source": sourceId, yes: true }));
    const update = records.at(-1)!;
    c.writeRecord(update);

    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.targets, []);
    assert.deepEqual(saved.sources, []);
    assert.equal(listTargets(c).some((t) => t.id === targetId), false);
    assert.equal(listSources(c).some((s) => s.id === sourceId), false);
  });
});

test("case setup attach index upgrades a planned index instead of duplicating it", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], { index: "Faces:face-analysis", video: "clip.mp4", yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { index: "idx_faces:face-analysis:Faces", yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);

    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    const indexes = saved.indexes as Array<Record<string, unknown>>;
    assert.equal(indexes.length, 1);
    assert.equal(indexes[0].id, "idx_faces");
    assert.equal(indexes[0].name, "Faces");
    assert.deepEqual((saved.default_signals as Record<string, unknown>).Faces, undefined);
    assert.deepEqual((saved.default_signals as Record<string, unknown>).idx_faces, ["face", "index add"]);
    assert.deepEqual(((saved.media as Record<string, unknown>).routes as Array<Record<string, unknown>>)[0].indexes, ["idx_faces"]);
  });
});

test("case setup two-part index edit preserves existing attached id", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], { index: "idx_faces:face-analysis:Faces", video: "clip.mp4", yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { index: "Faces:face-analysis", yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);

    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    const indexes = saved.indexes as Array<Record<string, unknown>>;
    assert.equal(indexes.length, 1);
    assert.equal(indexes[0].id, "idx_faces");
    assert.deepEqual((saved.default_signals as Record<string, unknown>).idx_faces, ["face", "index add"]);
    assert.deepEqual(((saved.media as Record<string, unknown>).routes as Array<Record<string, unknown>>)[0].indexes, ["idx_faces"]);
  });
});

test("case setup index-only edits refresh saved video route indexes", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], { index: "idx_a:media-descriptions:A", video: "clip.mp4", yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { index: "idx_b:media-descriptions:B", yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);
    let saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(((saved.media as Record<string, unknown>).routes as Array<Record<string, unknown>>)[0].indexes, ["idx_a", "idx_b"]);

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { "remove-index": "idx_a", yes: true, ...noIndex }));
    c.writeRecord(records.at(-1)!);
    saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(((saved.media as Record<string, unknown>).routes as Array<Record<string, unknown>>)[0].indexes, ["idx_b"]);
    assert.deepEqual((saved.default_signals as Record<string, unknown>).idx_a, undefined);
  });
});

test("case setup expands selected folders into routed media files", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const folder = join(dir, "videos");
    const nested = join(folder, "nested");
    mkdirSync(nested, { recursive: true });
    const a = join(folder, "a.mp4");
    const b = join(nested, "b.mov");
    const ignored = join(folder, "readme.txt");
    writeFileSync(a, "a");
    writeFileSync(b, "b");
    writeFileSync(ignored, "ignore");

    const records = await caseVerb.run(ctx(dir, "setup", [], {
      folder,
      index: "idx_media:media-descriptions:Media",
      yes: true,
      ...noIndex,
    }));
    c.writeRecord(records.at(-1)!);

    const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual((saved.media as Record<string, unknown>).folders, [folder]);
    assert.deepEqual((saved.media as Record<string, unknown>).videos, [a, b]);
    assert.deepEqual(((saved.media as Record<string, unknown>).routes as Array<Record<string, unknown>>).map((r) => r.ref), [a, b]);
    assert.match(JSON.stringify((records.at(-1)!.payload as Record<string, unknown>).applied_operations), /folder select: .*\(2 media files\)/);
  });
});

test("case setup apply creates remote indexes and starts routed video indexing", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "fake");
    const prev = process.env.OVERCAST_TINYCLOUD_CMD;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")}`;
    try {
      const records = await caseVerb.run(ctx(dir, "setup", [], {
        index: "Scenes:media-descriptions",
        video,
        yes: true,
      }));
      for (const rec of records) c.writeRecord(rec);

      assert.equal(records.some((r) => r.verb === "index" && (r.payload as Record<string, unknown>).op === "create"), true);
      assert.equal(records.some((r) => r.verb === "index" && (r.payload as Record<string, unknown>).op === "add"), true);
      assert.equal(records.some((r) => r.verb === "watch" && r.media?.ref === video), true);

      const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
      const indexes = saved.indexes as Array<Record<string, unknown>>;
      assert.equal(indexes[0].id, "col_fake123");
      assert.deepEqual((saved.default_signals as Record<string, unknown>).col_fake123, ["watch", "index add"]);
      assert.deepEqual(((saved.media as Record<string, unknown>).routes as Array<Record<string, unknown>>)[0].indexes, ["col_fake123"]);
      assert.match(JSON.stringify((records.at(-1)!.payload as Record<string, unknown>).applied_operations), /indexing started/);
    } finally {
      if (prev === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
      else process.env.OVERCAST_TINYCLOUD_CMD = prev;
    }
  });
});

test("case setup memory signals do not replace remote index ingestion defaults", async () => {
  await withCase(async (dir) => {
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "fake");
    const prev = process.env.OVERCAST_TINYCLOUD_CMD;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")}`;
    try {
      const records = await caseVerb.run(ctx(dir, "setup", [], {
        memory: "local-grep",
        signals: "note,watch",
        index: "Scenes:media-descriptions",
        video,
        yes: true,
      }));
      assert.equal(records.some((r) => r.verb === "index" && (r.payload as Record<string, unknown>).op === "add"), true);
      const setupRecord = records.at(-1)!;
      assert.match(JSON.stringify((setupRecord.payload as Record<string, unknown>).applied_operations), /indexing started/);
    } finally {
      if (prev === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
      else process.env.OVERCAST_TINYCLOUD_CMD = prev;
    }
  });
});

test("case setup remains incomplete when remote index creation does not return an id", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "fake");
    const prevCmd = process.env.OVERCAST_TINYCLOUD_CMD;
    const prevMode = process.env.OVERCAST_FAKE_TC_MODE;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")}`;
    process.env.OVERCAST_FAKE_TC_MODE = "cred";
    try {
      const records = await caseVerb.run(ctx(dir, "setup", [], {
        index: "Scenes:media-descriptions",
        video,
        yes: true,
      }));
      const setupRecord = records.at(-1)!;
      c.writeRecord(setupRecord);

      assert.equal(setupRecord.state, "pending");
      assert.deepEqual((setupRecord.payload as Record<string, unknown>).incomplete_indexes, [{ name: "Scenes", type: "media-descriptions" }]);
      const saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
      assert.equal(saved.completed, false);

      const [status] = await caseVerb.run(ctx(dir, "setup", ["status"]));
      assert.deepEqual((status.payload as Record<string, unknown>).incomplete_indexes, [{ name: "Scenes", type: "media-descriptions" }]);
    } finally {
      if (prevCmd === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
      else process.env.OVERCAST_TINYCLOUD_CMD = prevCmd;
      if (prevMode === undefined) delete process.env.OVERCAST_FAKE_TC_MODE;
      else process.env.OVERCAST_FAKE_TC_MODE = prevMode;
    }
  });
});

test("case setup saved-but-incomplete follow-up emits update op", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "fake");
    const prevCmd = process.env.OVERCAST_TINYCLOUD_CMD;
    const prevMode = process.env.OVERCAST_FAKE_TC_MODE;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")}`;
    process.env.OVERCAST_FAKE_TC_MODE = "cred";
    try {
      let records = await caseVerb.run(ctx(dir, "setup", [], {
        index: "Scenes:media-descriptions",
        video,
        yes: true,
      }));
      c.writeRecord(records.at(-1)!);
      assert.equal((records.at(-1)!.payload as Record<string, unknown>).op, "startup_setup");
      assert.equal(records.at(-1)!.state, "pending");

      records = await caseVerb.run(ctx(dir, "setup", [], {
        target: "follow-up",
        yes: true,
        ...noIndex,
      }));
      const update = records.at(-1)!;
      assert.equal((update.payload as Record<string, unknown>).op, "startup_setup_update");
    } finally {
      if (prevCmd === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
      else process.env.OVERCAST_TINYCLOUD_CMD = prevCmd;
      if (prevMode === undefined) delete process.env.OVERCAST_FAKE_TC_MODE;
      else process.env.OVERCAST_FAKE_TC_MODE = prevMode;
    }
  });
});

test("case setup edit does not say indexing started for existing index members", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "fake");
    const prev = process.env.OVERCAST_TINYCLOUD_CMD;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")}`;
    try {
      let records = await caseVerb.run(ctx(dir, "setup", [], {
        index: "Scenes:media-descriptions",
        video,
        yes: true,
      }));
      for (const rec of records) c.writeRecord(rec);

      records = await caseVerb.run(ctx(dir, "setup", ["edit"], { source: "web:second", yes: true }));
      const setupRecord = records.at(-1)!;
      c.writeRecord(setupRecord);
      const operations = (setupRecord.payload as Record<string, unknown>).applied_operations as string[];
      assert.equal(operations.some((op) => op.includes("index already member")), true);
      assert.equal(operations.some((op) => op.includes("indexing started")), false);
    } finally {
      if (prev === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
      else process.env.OVERCAST_TINYCLOUD_CMD = prev;
    }
  });
});

test("case setup defaults to local-grep memory and records selected local memory backend", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    let records = await caseVerb.run(ctx(dir, "setup", [], { target: "alpha", yes: true }));
    c.writeRecord(records.at(-1)!);
    let saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.memory, { backend: "local-grep", signals: ["note", "watch", "listen", "see", "scan"] });

    records = await caseVerb.run(ctx(dir, "setup", ["edit"], { memory: "qmd", signals: "note,watch", yes: true }));
    c.writeRecord(records.at(-1)!);
    saved = JSON.parse(readFileSync(c.setupFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.memory, { backend: "qmd", signals: ["note", "watch"] });
  });
});

test("case setup rejects skipping the local memory backend", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "setup", [], { memory: "skip", yes: true }));
    assert.equal(rec.state, "error");
    assert.match(String(rec.error), /local memory backend: local-grep or qmd/);
  });
});

test("operational setup records remain excluded from memory", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const records = await caseVerb.run(ctx(dir, "setup", [], { target: "SETUP_ONLY_NEEDLE", yes: true }));
    c.writeRecord(records.at(-1)!);

    const [search] = await caseVerb.run(ctx(dir, "memory", ["search", "SETUP_ONLY_NEEDLE"]));
    assert.equal(((search.payload as Record<string, unknown>).passages as unknown[]).length, 0);
  });
});

// --- case memory get: manifest + field paging --------------------------------

/** Seed a case with one big-content watch record; return [dir, id]. */
function withBigRecord(fn: (dir: string, id: string, content: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-getp-"));
  const c = openCase(dir); c.ensure();
  const content = Array.from({ length: 60 }, (_, i) => `scene ${i} line`).join("\n"); // multi-page
  const rec = makeRecord({ verb: "watch", payload: { content, transcript: "", detailed: { segments: [1, 2, 3] } }, media: { ref: "v.mp4" } });
  c.writeRecord(rec);
  return fn(dir, rec.id, content).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("case memory get <id> returns a field manifest with chars matching paging total", async () => {
  await withBigRecord(async (dir, id, content) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["get", id]));
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.record, id);
    assert.equal(p.verb, "watch");
    const fields = p.fields as Array<Record<string, unknown>>;
    const contentField = fields.find((f) => f.name === "content")!;
    assert.equal(contentField.type, "string");
    assert.equal(contentField.chars, content.length); // manifest chars === what paging reports as total
  });
});

test("case memory get --field pages deterministically with has_more/next_offset", async () => {
  await withBigRecord(async (dir, id, content) => {
    const [p1] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: 0, limit: 100 }));
    const a = p1.payload as Record<string, unknown>;
    assert.equal(a.field, "content");
    assert.equal(a.total, content.length);
    assert.equal(a.offset, 0);
    assert.equal(a.returned, 100);
    assert.equal(a.has_more, true);
    assert.equal(a.next_offset, 100);
    assert.equal(a.chunk, content.slice(0, 100));

    // continue at next_offset — the second page resumes exactly where the first ended
    const [p2] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: a.next_offset as number, limit: 100 }));
    const b = p2.payload as Record<string, unknown>;
    assert.equal(b.offset, 100);
    assert.equal(b.chunk, content.slice(100, 200));
  });
});

test("case memory get redacts secrets in manifests and paged chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-getsecret-"));
  try {
    const c = openCase(dir); c.ensure();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const content = `prefix CLOUDGLUE_API_KEY=${secret} suffix`;
    const rec = makeRecord({ verb: "note", payload: { content } });
    c.writeRecord(rec);

    const [manifest] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id]));
    const fields = ((manifest.payload as Record<string, unknown>).fields as Array<Record<string, unknown>>);
    assert.doesNotMatch(String(fields[0].preview), /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.match(String(fields[0].preview), /REDACTED/);

    const [page] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id], { field: "content", offset: 0, limit: content.length }));
    const payload = page.payload as Record<string, unknown>;
    assert.equal(payload.returned, String(payload.chunk).length);
    assert.doesNotMatch(String(payload.chunk), /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.match(String(payload.chunk), /CLOUDGLUE_API_KEY=\[REDACTED\]/);
    assert.equal(payload.total, "prefix CLOUDGLUE_API_KEY=[REDACTED] suffix".length);

    const redacted = "prefix CLOUDGLUE_API_KEY=[REDACTED] suffix";
    const [splitPage] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id], { field: "content", offset: redacted.indexOf("[REDACTED]"), limit: 6 }));
    const splitPayload = splitPage.payload as Record<string, unknown>;
    assert.equal(splitPayload.chunk, "[REDAC");
    assert.doesNotMatch(String(splitPayload.chunk), /sk-|abcdefgh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case memory get --field reaches the end (has_more false, next_offset null)", async () => {
  await withBigRecord(async (dir, id, content) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: 0, limit: content.length + 50 }));
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.returned, content.length);
    assert.equal(p.has_more, false);
    assert.equal(p.next_offset, null);
  });
});

test("case memory get errors when --offset is past the end of the field", async () => {
  await withBigRecord(async (dir, id, content) => {
    const [over] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: content.length + 100 }));
    assert.equal(over.state, "error");
    assert.match(String(over.error), /past the end/);
    // offset === total is the legitimate terminal: empty slice, has_more false
    const [end] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: content.length, limit: 50 }));
    const p = end.payload as Record<string, unknown>;
    assert.equal(p.returned, 0);
    assert.equal(p.has_more, false);
  });
});

test("case memory get errors on a missing field, listing the real fields", async () => {
  await withBigRecord(async (dir, id) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "nope" }));
    assert.equal(rec.state, "error");
    assert.match(String(rec.error), /no field 'nope'/);
    assert.match(String(rec.error), /content/);
  });
});

test("case memory get validates --offset and --limit", async () => {
  await withBigRecord(async (dir, id) => {
    const [bad1] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: -5 }));
    assert.equal(bad1.state, "error");
    const [bad2] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", limit: 0 }));
    assert.equal(bad2.state, "error");
  });
});

test("case memory get rejects --offset/--limit without --field on an object payload", async () => {
  await withBigRecord(async (dir, id) => {
    const [o] = await caseVerb.run(ctx(dir, "memory", ["get", id], { offset: 0 }));
    assert.equal(o.state, "error");
    assert.match(String(o.error), /--field <name> required/);
    const [l] = await caseVerb.run(ctx(dir, "memory", ["get", id], { limit: 100 }));
    assert.equal(l.state, "error");
  });
});

test("case memory get manifest/chunk carry meta.pageTarget for correct hints", async () => {
  await withBigRecord(async (dir, id) => {
    const [man] = await caseVerb.run(ctx(dir, "memory", ["get", id]));
    assert.equal(man.meta?.pageTarget, id);
    const [chunk] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: 0, limit: 10 }));
    assert.equal(chunk.meta?.pageTarget, id);
  });
});

test("case memory get on a missing record errors", async () => {
  await withBigRecord(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["get", "rec_doesnotexist"]));
    assert.equal(rec.state, "error");
  });
});

test("case memory get on a string record with no flags returns a (text) manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-getstrman-"));
  try {
    const c = openCase(dir); c.ensure();
    const rec = makeRecord({ verb: "note", payload: "a plain string payload body" });
    c.writeRecord(rec);
    const [man] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id]));
    const p = man.payload as Record<string, unknown>;
    const fields = p.fields as Array<Record<string, unknown>>;
    assert.equal(fields.length, 1);
    assert.equal(fields[0].name, "(text)");
    assert.equal(fields[0].chars, "a plain string payload body".length);
    assert.equal(man.meta?.pageTarget, rec.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case memory get pages a plain-string payload as (text), no --field needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-getstr-"));
  try {
    const c = openCase(dir); c.ensure();
    const rec = makeRecord({ verb: "note", payload: "a plain string payload body" });
    c.writeRecord(rec);
    const [out] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id], { offset: 0, limit: 5 }));
    const p = out.payload as Record<string, unknown>;
    assert.equal(p.field, "(text)");
    assert.equal(p.chunk, "a pla");
    assert.equal(p.total, "a plain string payload body".length);

    // a wrong --field on a string payload must error, not silently page the string
    const [bad] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id], { field: "content" }));
    assert.equal(bad.state, "error");
    assert.match(String(bad.error), /no field 'content'.*\(text\)/);
    // the explicit "(text)" field name is accepted
    const [okp] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id], { field: "(text)", offset: 0, limit: 3 }));
    assert.equal((okp.payload as Record<string, unknown>).chunk, "a p");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
