import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runWatch } from "../../src/providers/tinycloud/watch.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "..", "fixtures", "fake-watch.sh");
const CASES = join(HERE, "..", "fixtures", "fake-watch-cases.sh");

test("runWatch maps a real tinycloud envelope to the loose record (via fixture provider)", async () => {
  chmodSync(FAKE, 0o755);
  // exercise the REAL mapping code against the REAL captured envelope, offline.
  const rec = await runWatch("browse-hackernews.mp4", {
    run: `bash ${FAKE} {{input}}`,
  });

  assert.equal(rec.verb, "watch");
  assert.equal(rec.format, "json");
  assert.equal(rec.state, "ready");
  assert.equal(rec.error, undefined);
  assert.equal(rec.media?.ref, "browse-hackernews.mp4");

  const payload = rec.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["content", "detailed", "transcript"]);

  // content is synthesized from title + summary + segment breakdown
  assert.match(payload.content as string, /Hacker News/);
  assert.match(payload.content as string, /## Segments/);

  // detailed carries the structured describe data
  const detailed = payload.detailed as Record<string, unknown>;
  assert.equal(detailed.title, "Exploring Hacker News Discussions on macOS Customization and AI Tools");
  assert.ok(Array.isArray(detailed.segments));

  // meta carries provider + extracted title/duration
  assert.equal(rec.meta?.provider, "tinycloud");
  assert.equal(rec.meta?.title, detailed.title);
});

test("runWatch returns an error record when the provider emits no JSON", async () => {
  const rec = await runWatch("x.mp4", { run: `bash -c 'echo not-json' {{input}}` });
  assert.equal(rec.state, "error");
  assert.ok(rec.error);
});

test("runWatch surfaces a non-zero exit even when JSON is present (no silent success)", async () => {
  chmodSync(CASES, 0o755);
  const rec = await runWatch("x.mp4", { run: `bash ${CASES} exit7 {{input}}` });
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /exit 7/);
});

test("runWatch maps an error envelope (status:error) to an error record", async () => {
  chmodSync(CASES, 0o755);
  const rec = await runWatch("x.mp4", { run: `bash ${CASES} error {{input}}` });
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /quota exceeded/);
});

test("runWatch tags pending when the marker is nested under data", async () => {
  chmodSync(CASES, 0o755);
  const rec = await runWatch("x.mp4", { run: `bash ${CASES} pending {{input}}` });
  assert.equal(rec.state, "pending");
  assert.equal(rec.error, undefined);
});
