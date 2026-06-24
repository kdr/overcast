#!/usr/bin/env node
// Package the compiled standalone binary (+ its sidecar files: branding
// package.json, builtin themes, example providers, and THIRD_PARTY_NOTICES.md)
// into a distributable tar.gz. Run after `npm run build:bun` (or via
// `npm run package:bun`). The bundled FFmpeg is GPL-licensed, so the notices file
// MUST be present in the archive — this script fails if it isn't.
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BIN = "dist/bin";
if (!existsSync(`${BIN}/overcast`)) {
  console.error("[package:bun] dist/bin/overcast not found — run `npm run build:bun` first");
  process.exit(1);
}
if (!existsSync(`${BIN}/THIRD_PARTY_NOTICES.md`)) {
  console.error("[package:bun] THIRD_PARTY_NOTICES.md missing from dist/bin — refusing to package a GPL binary without its notices");
  process.exit(1);
}

mkdirSync("dist/release", { recursive: true });
const name = `overcast-${process.platform}-${process.arch}.tar.gz`;
const out = `dist/release/${name}`;

// tar the CONTENTS of dist/bin (binary + every sidecar file, incl. the notices).
execFileSync("tar", ["-czf", out, "-C", BIN, "."], { stdio: "inherit" });

const listing = execFileSync("tar", ["-tzf", out], { encoding: "utf8" });
if (!/THIRD_PARTY_NOTICES\.md/.test(listing)) {
  console.error("[package:bun] FATAL: THIRD_PARTY_NOTICES.md is not in the archive");
  process.exit(1);
}
console.error(`[package:bun] wrote ${out} (includes THIRD_PARTY_NOTICES.md, package.json, theme/, examples/)`);
