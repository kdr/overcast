import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord, type OvercastRecord } from "../../src/record.ts";
import { toAgentTool, verbCallLine } from "../../src/registry/to-agent-tool.ts";
import type { VerbSpec } from "../../src/registry/types.ts";
import { caseVerb } from "../../src/verbs/case.ts";

test("verbCallLine: class-colored ⟦ TAG ⟧ ▸ arg (semantic split + primary arg)", () => {
  const watch = { name: "watch", args: [{ name: "url" }] } as unknown as VerbSpec;
  const scan = { name: "scan", args: [{ name: "query" }] } as unknown as VerbSpec;
  const w = verbCallLine(watch, { url: "https://x/v.mp4" });
  assert.match(w, /⟦ WATCH ⟧/);
  assert.ok(w.includes("\x1b[38;2;0;255;127m"), "sense verb → neon green tag");
  assert.match(w, /▸.*https:\/\/x\/v\.mp4/);
  const s = verbCallLine(scan, {});
  assert.match(s, /⟦ SCAN ⟧/);
  assert.ok(s.includes("\x1b[38;2;255;46;151m"), "osint verb → magenta tag");
  assert.ok(!s.includes("▸"), "no separator when no primary arg");
});

test("renderResult: collapses long output to a preview + expand hint (full when expanded)", () => {
  const spec = { name: "doctor", args: [], flags: [] } as unknown as VerbSpec;
  const deps = { getCase: () => ({}), getProfile: () => ({}) } as unknown as Parameters<typeof toAgentTool>[1];
  const tool = toAgentTool(spec, deps);
  const theme = { fg: (_k: string, t: string) => t } as never;
  const longText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const result = { content: [{ type: "text", text: longText }] } as never;

  const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {} as never);
  const c = collapsed.render(200).join("\n");
  assert.match(c, /14 more lines, ctrl\+o to expand/); // 20 - 6 preview lines
  assert.ok(!c.includes("line 20"), "tail is hidden when collapsed");

  const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {} as never);
  const e = expanded.render(200).join("\n");
  assert.ok(e.includes("line 20"), "full output when expanded");
  assert.ok(!/more lines/.test(e), "no expand hint when expanded");
});

/** Build a tool whose run() returns the given records, execute it, return the
 *  LLM-facing text (what the agent actually sees). */
async function renderViaTool(records: OvercastRecord[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "oc-agent-"));
  try {
    const spec: VerbSpec = {
      name: "fake",
      group: "sense",
      summary: "fake",
      args: [],
      flags: [],
      outputKind: "fake",
      run: async () => records,
    };
    const deps = {
      getCase: () => {
        const c = openCase(dir);
        c.ensure();
        return c;
      },
      getProfile: () => defaultProfile(),
    };
    const tool = toAgentTool(spec, deps);
    const res = (await tool.execute("call_1", {}, undefined as never)) as {
      content: Array<{ type: string; text: string }>;
    };
    return res.content[0].text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a small record is inlined in full (agent sees the value, not just keys)", async () => {
  const text = await renderViaTool([
    makeRecord({ verb: "ask", payload: { text: "Irene Evanston (Fort Mohave Tribe) opposed it.", question: "who?" } }),
  ]);
  assert.match(text, /Irene Evanston \(Fort Mohave Tribe\) opposed it\./);
  assert.doesNotMatch(text, /payload\{/); // never the old key-only stub
});

test("a huge record previews with a paging pointer (does not dump the field)", async () => {
  const big = "X".repeat(60_000);
  const text = await renderViaTool([
    makeRecord({ id: "rec_huge01", verb: "watch", payload: { content: big, transcript: "" } }),
  ]);
  assert.doesNotMatch(text, /X{500}/); // previewed, not dumped (preview width ~200)
  // single-record hint embeds --case (works from any cwd) before --field
  assert.match(text, /case memory get rec_huge01 --case \S+ --field <name>/);
});

test("an explicit page-chunk record is always shown in full, even over budget", async () => {
  const big = "Y".repeat(20_000);
  const text = await renderViaTool([
    makeRecord({
      verb: "case",
      payload: { record: "rec_x", field: "content", offset: 0, limit: 20000, total: 60000, returned: 20000, has_more: true, next_offset: 20000, chunk: big },
    }),
  ]);
  assert.match(text, /YYYYYYYYYY/); // the requested slice is shown in full
});

test("a non-case payload that merely has a `chunk` key is NOT force-inlined", async () => {
  const big = "Z".repeat(60_000);
  // looks like it has a chunk, but it's a `see` record over budget → must preview
  const text = await renderViaTool([
    makeRecord({ id: "rec_see01", verb: "see", payload: { chunk: big } }),
  ]);
  assert.doesNotMatch(text, /Z{500}/); // NOT force-inlined despite the `chunk` key
  assert.match(text, /case memory get rec_see01/);
});

test("budget cap: over-budget records become compact locators, output stays bounded", async () => {
  const records = Array.from({ length: 60 }, (_, i) =>
    makeRecord({ id: `rec_h${i}`, verb: "scan", payload: { title: `hit ${i}`, snippet: "x".repeat(400) } }),
  );
  const text = await renderViaTool(records);
  // no record is silently dropped — over-budget ones get an id + paging pointer
  assert.match(text, /not shown \(budget\); read it with/);
  // total LLM-facing text stays bounded (not the ~24KB of raw payloads)
  assert.ok(Buffer.byteLength(text, "utf8") < 14_000, `text was ${Buffer.byteLength(text, "utf8")}B`);
});

test("budget cap: beyond the locator cap, the remainder is summarized", async () => {
  const records = Array.from({ length: 120 }, (_, i) =>
    makeRecord({ verb: "scan", payload: { title: `hit ${i}`, snippet: "x".repeat(400) } }),
  );
  const text = await renderViaTool(records);
  assert.match(text, /more record\(s\) not shown/); // > MAX_LOCATORS → tail summary
  assert.ok(Buffer.byteLength(text, "utf8") < 16_000);
});

test("a single record whose preview exceeds budget still gets an id + pointer (no silent drop)", async () => {
  // ~400 fields → the preview itself exceeds the 8KB budget
  const payload: Record<string, unknown> = {};
  for (let i = 0; i < 400; i++) payload[`field_${i}`] = `value ${i}`;
  const text = await renderViaTool([makeRecord({ id: "rec_wide01", verb: "watch", payload })]);
  assert.match(text, /rec_wide01 \[watch\]/); // the id is present
  assert.match(text, /case memory get rec_wide01/); // and how to read it
});

test("greedy budget: small records inline, the big one previews (mixed batch)", async () => {
  const text = await renderViaTool([
    makeRecord({ verb: "ask", payload: { text: "SMALL-ANSWER-MARKER", question: "q" } }),
    makeRecord({ id: "rec_b", verb: "watch", payload: { content: "B".repeat(60_000) } }),
  ]);
  assert.match(text, /SMALL-ANSWER-MARKER/); // small one fully inlined
  assert.doesNotMatch(text, /B{500}/); // big one previewed (not dumped)
  assert.match(text, /emitted 2 record\(s\)/);
});

test("agent tool defaults HTML exports to CSI when the verb supports themes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-agent-theme-"));
  try {
    const seen: Array<Record<string, unknown>> = [];
    const spec: VerbSpec = {
      name: "brief",
      group: "read",
      summary: "brief",
      args: [],
      flags: [
        { name: "export", summary: "export", type: "string" },
        { name: "theme", summary: "theme", type: "string", choices: ["plain", "csi"], default: "plain" },
      ],
      outputKind: "brief",
      run: async (ctx) => {
        seen.push({ ...ctx.opts });
        return [makeRecord({ verb: "brief", payload: { export: ctx.opts.export, theme: ctx.opts.theme } })];
      },
    };
    const c = openCase(dir); c.ensure();
    const tool = toAgentTool(spec, { getCase: () => c, getProfile: () => defaultProfile() });

    await tool.execute("call_1", { export: join(dir, "report.html") }, undefined as never);
    await tool.execute("call_2", { export: join(dir, "report.md") }, undefined as never);
    await tool.execute("call_3", { export: join(dir, "plain.html"), theme: "plain" }, undefined as never);
    await tool.execute("call_4", { export: join(dir, "report.htm") }, undefined as never);

    assert.equal(seen[0].theme, "csi");
    assert.equal(seen[1].theme, undefined);
    assert.equal(seen[2].theme, "plain");
    assert.equal(seen[3].theme, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent tool defaults to CSI via a declared .html export default (no export passed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-agent-theme-default-"));
  try {
    const seen: Array<Record<string, unknown>> = [];
    // wall-shaped spec: the export flag itself defaults to an .html path, and
    // the agent path never applies FlagSpec defaults — the theme default must
    // fall back to the declared export default.
    const spec: VerbSpec = {
      name: "wall",
      group: "inspect",
      summary: "wall",
      args: [],
      flags: [
        { name: "export", summary: "export", type: "string", default: ".overcast/media/wall.html" },
        { name: "theme", summary: "theme", type: "string", choices: ["plain", "csi"], default: "plain" },
      ],
      outputKind: "wall",
      run: async (ctx) => {
        seen.push({ ...ctx.opts });
        return [makeRecord({ verb: "wall", payload: { theme: ctx.opts.theme } })];
      },
    };
    const c = openCase(dir); c.ensure();
    const tool = toAgentTool(spec, { getCase: () => c, getProfile: () => defaultProfile() });

    await tool.execute("call_1", {}, undefined as never); // default export is .html → csi
    await tool.execute("call_2", { export: join(dir, "wall.md") }, undefined as never); // explicit non-html wins
    await tool.execute("call_3", { theme: "plain" }, undefined as never); // explicit theme wins

    assert.equal(seen[0].theme, "csi");
    assert.equal(seen[1].theme, undefined);
    assert.equal(seen[2].theme, "plain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case memory get tool schema forwards subcommand and record id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-agent-case-"));
  try {
    const c = openCase(dir); c.ensure();
    const rec = makeRecord({ verb: "watch", payload: { content: "full text", transcript: "" }, media: { ref: "v.mp4" } });
    c.writeRecord(rec);
    const tool = toAgentTool(caseVerb, {
      getCase: () => c,
      getProfile: () => defaultProfile(),
    });
    const res = (await tool.execute("call_1", { action: "memory", sub: "get", arg: rec.id }, undefined as never)) as {
      content: Array<{ type: string; text: string }>;
    };
    assert.match(res.content[0].text, new RegExp(`record: ${rec.id}`));
    assert.doesNotMatch(res.content[0].text, /usage: case memory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
