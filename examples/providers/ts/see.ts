#!/usr/bin/env -S node --import tsx
// overcast exec/in-proc provider: see (VLM sketch).
//
// Bind with:
//   overcast setup provider see "exec:node --import tsx examples/providers/ts/see.ts"
//   overcast provider init see
//
// Implements the overcast exec wire contract (init | describe | run --input <ref>).
// Map your model's output to the loose record; overcast persists it verbatim.

interface Record_ {
  verb: string;
  format: "json";
  payload: Record<string, unknown>;
  media?: { ref: string };
  meta?: Record<string, unknown>;
  state?: string;
  error?: string;
}

function describe(): void {
  process.stdout.write(
    JSON.stringify({ verb: "see", kind: "image.analysis", payload: ["caption", "ocr", "detections"] }) + "\n",
  );
}

function init(): void {
  if (!process.env.VLM_API_KEY) {
    process.stderr.write("set VLM_API_KEY to use this provider\n");
    process.exit(13);
  }
}

function run(input: string, opts: { ocr?: boolean; detect?: string }): void {
  // Replace with your real VLM call; this stub emits the record shape.
  const rec: Record_ = {
    verb: "see",
    format: "json",
    payload: { caption: "", ocr: opts.ocr ? "" : undefined, detections: [] },
    media: { ref: input },
    meta: { provider: "vlm-sample" },
    state: process.env.VLM_API_KEY ? "ready" : "needs_credentials",
    error: process.env.VLM_API_KEY ? undefined : "set VLM_API_KEY",
  };
  process.stdout.write(JSON.stringify(rec) + "\n");
}

function main(argv: string[]): void {
  // args after [node, script]. Don't assume argv[2] is the op — under
  // `node --import tsx see.ts <op>` the loader/positions vary; parse by VALUE.
  const args = argv.slice(2);
  // the subcommand is ONLY the first token — so an object label that happens to be
  // "describe"/"init" (e.g. `--detect describe`) doesn't trigger a subcommand.
  if (args[0] === "describe") return describe();
  if (args[0] === "init") return init();
  let input = "";
  const opts: { ocr?: boolean; detect?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // guard ++i so a trailing flag yields "" rather than undefined/malformed output
    if (a === "--input") input = i + 1 < args.length ? args[++i] : "";
    else if (a === "--ocr") opts.ocr = true;
    else if (a === "--detect") opts.detect = i + 1 < args.length ? args[++i] : "";
    else if (a === "run") continue;
    else if (!a.startsWith("-")) input = a; // last positional wins (input contract)
  }
  run(input, opts);
}

main(process.argv);
