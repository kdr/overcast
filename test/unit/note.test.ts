import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import { noteVerb } from "../../src/verbs/note.ts";
import { askVerb, briefVerb } from "../../src/verbs/read.ts";
import type { VerbContext } from "../../src/registry/types.ts";

function ctx(dir: string, input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext {
  return { input, rest, opts, case: openCase(dir), profile: defaultProfile() };
}

async function withCase(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-note-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({
      verb: "watch",
      payload: { content: "A delivery van enters the east gate." },
      media: { ref: "gate.mp4", at: [30, 35] },
    }));
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("note creates a human-authored primary record with tags and evidence anchor", async () => {
  await withCase(async (dir) => {
    const source = openCase(dir).records().find((r) => r.verb === "watch")!;
    const [note] = await noteVerb.run(ctx(
      dir,
      "Analyst confirms the van has no rear plate",
      [],
      { ref: source.id, at: "00:00:31-00:00:34", tag: "vehicle,plate", confidence: "high", title: "rear plate" },
    ));

    assert.equal(note.verb, "note");
    assert.equal(note.state, "ready");
    assert.equal(note.meta?.provider, "human");
    assert.deepEqual(note.media, { ref: "gate.mp4", at: [31, 34] });

    const payload = note.payload as Record<string, unknown>;
    assert.equal(payload.text, "Analyst confirms the van has no rear plate");
    assert.equal(payload.related_record, source.id);
    assert.deepEqual(payload.tags, ["vehicle", "plate"]);
    assert.equal(payload.confidence, "high");
    assert.equal(payload.title, "rear plate");
  });
});

test("note --ref links media without inheriting source media.at unless --at is explicit", async () => {
  await withCase(async (dir) => {
    const source = openCase(dir).records().find((r) => r.verb === "watch")!;
    const [note] = await noteVerb.run(ctx(dir, "Analyst flags the same clip but not a specific moment", [], { ref: source.id }));

    assert.deepEqual(note.media, { ref: "gate.mp4" });
    assert.equal((note.payload as Record<string, unknown>).related_record, source.id);
  });
});

test("note joins unquoted positional text and rejects invalid anchors", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const [joined] = await noteVerb.run(ctx(dir, "white", ["van", "turns", "left"]));
    assert.equal((joined.payload as Record<string, unknown>).text, "white van turns left");

    const [missingRef] = await noteVerb.run(ctx(dir, "bad anchor", [], { at: "12" }));
    assert.equal(missingRef.state, "error");
    assert.match(String(missingRef.error), /--at requires --ref/);

    const mediaPath = join(dir, "x.mp4");
    writeFileSync(mediaPath, "fake media");
    const [badAt] = await noteVerb.run(ctx(dir, "bad anchor", [], { ref: mediaPath, at: "20-10" }));
    assert.equal(badAt.state, "error");
    assert.match(String(badAt.error), /invalid --at/);

    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      writeFileSync("cap_clip.mp4", "fake media");
      const [capPath] = await noteVerb.run(ctx(dir, "local cap-prefixed path", [], { ref: "cap_clip.mp4" }));
      assert.equal(capPath.state, "ready");
      assert.deepEqual(capPath.media, { ref: "cap_clip.mp4" });

      writeFileSync("rec_clip.mp4", "fake media");
      const [recPath] = await noteVerb.run(ctx(dir, "local rec-prefixed path", [], { ref: "rec_clip.mp4" }));
      assert.equal(recPath.state, "ready");
      assert.deepEqual(recPath.media, { ref: "rec_clip.mp4" });
    } finally {
      process.chdir(originalCwd);
    }

    const scan = makeRecord({ verb: "scan", payload: { title: "page result" } });
    c.writeRecord(scan);
    const [noMedia] = await noteVerb.run(ctx(dir, "bad anchor", [], { ref: scan.id, at: "12" }));
    assert.equal(noMedia.state, "error");
    assert.match(String(noMedia.error), /has no media\.ref/);

    const [missingRecord] = await noteVerb.run(ctx(dir, "bad ref", [], { ref: "rec_doesnotexist" }));
    assert.equal(missingRecord.state, "error");
    assert.match(String(missingRecord.error), /record not found/);

    const [missingCapture] = await noteVerb.run(ctx(dir, "bad ref", [], { ref: "cap_doesnotexist" }));
    assert.equal(missingCapture.state, "error");
    assert.match(String(missingCapture.error), /capture id not found/);

    const [missingPath] = await noteVerb.run(ctx(dir, "bad ref", [], { ref: join(dir, "missing.mp4") }));
    assert.equal(missingPath.state, "error");
    assert.match(String(missingPath.error), /does not resolve/);
  });
});

test("note records are searchable and included in briefs", async () => {
  await withCase(async (dir) => {
    const c = openCase(dir);
    const [note] = await noteVerb.run(ctx(dir, "Human observation: driver switches jackets near the loading dock", [], { tag: "driver" }));
    c.writeRecord(note);

    const [ask] = await askVerb.run(ctx(dir, "Who switches jackets?"));
    const answer = (ask.payload as Record<string, unknown>).text as string;
    assert.match(answer, /switches jackets/i);
    assert.ok(((ask.payload as Record<string, unknown>).citations as Array<Record<string, unknown>>).some((c) => c.verb === "note"));

    const [brief] = await briefVerb.run(ctx(dir, ""));
    const report = (brief.payload as Record<string, unknown>).report as string;
    assert.match(report, /Human observation: driver switches jackets/);
    assert.match(report, /`note`/);
  });
});
