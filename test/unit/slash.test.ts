import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSlashCommands } from "../../src/extension/slash.ts";

type Handler = (args: string) => Promise<void>;

function fakePi() {
  const commands = new Map<string, Handler>();
  const messages: string[] = [];
  const pi = {
    registerMessageRenderer: () => {},
    registerCommand: (name: string, opts: { handler: Handler }) => {
      commands.set(name, opts.handler);
    },
    sendMessage: (message: { details?: { text?: string }; content?: string }) => {
      messages.push(message.details?.text ?? message.content ?? "");
    },
  };
  return { pi, commands, messages };
}

test("bare slash setup/provider/finding commands emit visible results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-slash-"));
  const prevCase = process.env.OVERCAST_CASE;
  try {
    process.env.OVERCAST_CASE = dir;
    const { pi, commands, messages } = fakePi();
    registerSlashCommands(pi as never);

    await commands.get("setup")?.("");
    await commands.get("provider")?.("");
    await commands.get("finding")?.("");

    assert.equal(messages.length, 3);
    assert.match(messages[0], /\[setup\].*profile/s);
    assert.match(messages[1], /\[provider\].*effective/s);
    assert.match(messages[2], /\[finding\].*findings/s);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});
