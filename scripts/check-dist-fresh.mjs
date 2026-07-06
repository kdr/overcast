#!/usr/bin/env node
// Guard npm packaging against a stale ignored dist/. npm pack runs this via
// prepack after release builds; local packs fail with an actionable message
// when dist/bin/overcast.js is missing, not runnable, or no longer matches src.

import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(process.env.OVERCAST_DIST_FRESH_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const DIST_FILE = resolve(process.env.OVERCAST_DIST_FRESH_DIST_FILE ?? join(ROOT, "dist", "bin", "overcast.js"));

function parseCommand(envName, fallback) {
  const raw = process.env[envName];
  if (!raw) return fallback;
  try {
    const parts = JSON.parse(raw);
    if (!Array.isArray(parts) || parts.length === 0 || parts.some((p) => typeof p !== "string")) {
      throw new Error("expected a JSON array of strings");
    }
    return { cmd: parts[0], args: parts.slice(1) };
  } catch (e) {
    fail(`${envName} must be a JSON array of strings: ${e?.message ?? e}`);
  }
}

function fail(message) {
  console.error(`[check-dist-fresh] ${message}`);
  console.error("[check-dist-fresh] Run `npm run build` and retry.");
  process.exit(1);
}

function run(label, command, args) {
  const res = spawnSync(command.cmd, [...command.args, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      OVERCAST_NO_DOTENV: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (res.error) fail(`${label} is not runnable: ${res.error.message}`);
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    const stdout = (res.stdout ?? "").trim();
    fail(`${label} exited ${res.status}${stderr || stdout ? `: ${stderr || stdout}` : ""}`);
  }
  return res.stdout;
}

function readJson(label, command, args) {
  const stdout = run(label, command, args);
  try {
    return JSON.parse(stdout);
  } catch (e) {
    fail(`${label} did not emit valid JSON for \`${args.join(" ")}\`: ${e?.message ?? e}`);
  }
}

function verbNames(value, label) {
  if (!value || !Array.isArray(value.verbs)) fail(`${label} commands output is missing .verbs[]`);
  return value.verbs
    .map((v) => v?.name)
    .filter((name) => typeof name === "string")
    .sort((a, b) => a.localeCompare(b));
}

function diffNames(source, dist) {
  const sourceSet = new Set(source);
  const distSet = new Set(dist);
  const missing = source.filter((name) => !distSet.has(name));
  const extra = dist.filter((name) => !sourceSet.has(name));
  const details = [];
  if (missing.length) details.push(`missing in dist: ${missing.join(", ")}`);
  if (extra.length) details.push(`extra in dist: ${extra.join(", ")}`);
  return details;
}

if (!existsSync(DIST_FILE)) {
  fail(`dist CLI is missing at ${DIST_FILE}`);
}
if (process.platform !== "win32") {
  try {
    accessSync(DIST_FILE, constants.X_OK);
  } catch {
    fail(`dist CLI is not executable at ${DIST_FILE}`);
  }
}

const sourceCommand = parseCommand("OVERCAST_DIST_FRESH_SOURCE_CMD", {
  cmd: process.execPath,
  args: ["--import", "tsx", join(ROOT, "bin", "overcast.ts")],
});
const distCommand = parseCommand("OVERCAST_DIST_FRESH_DIST_CMD", {
  cmd: process.execPath,
  args: [DIST_FILE],
});

const sourceVersion = readJson("source CLI", sourceCommand, ["--version", "--json"]);
const distVersion = readJson("dist CLI", distCommand, ["--version", "--json"]);
const drift = [];
for (const field of ["overcast", "pi"]) {
  if (sourceVersion[field] !== distVersion[field]) {
    drift.push(`--version --json ${field}: source=${sourceVersion[field] ?? "<missing>"} dist=${distVersion[field] ?? "<missing>"}`);
  }
}

const sourceCommands = readJson("source CLI", sourceCommand, ["commands", "--json"]);
const distCommands = readJson("dist CLI", distCommand, ["commands", "--json"]);
const sourceNames = verbNames(sourceCommands, "source CLI");
const distNames = verbNames(distCommands, "dist CLI");
if (sourceNames.join("\0") !== distNames.join("\0")) {
  drift.push(`commands --json verb names differ (${diffNames(sourceNames, distNames).join("; ") || "same names in different order"})`);
}

if (drift.length) {
  console.error("[check-dist-fresh] dist/bin/overcast.js is stale:");
  for (const d of drift) console.error(`  - ${d}`);
  console.error("[check-dist-fresh] Run `npm run build` and retry.");
  process.exit(1);
}

console.error(`[check-dist-fresh] dist/bin/overcast.js matches source (${sourceVersion.overcast}, pi ${sourceVersion.pi}; ${sourceNames.length} verbs)`);
