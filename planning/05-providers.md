# 05 — Providers: defaults, authoring & registration

How sense/OSINT verbs bind to backends, the **default tinycloud** behavior we
ship first, and **copy-pasteable samples** for writing your own provider in
bash, TypeScript, or Python. The samples here are also shipped in the repo under
`examples/providers/` and rendered into `docs/providers.md`.

See [01 §8](01-architecture.md#8-provider-abstraction) for the model. One wire
contract (the **record**), three transports: `exec` (default), `http`,
`in-proc`.

## Provider contract

A provider for a verb implements three operations:

| Op | Purpose |
|---|---|
| `init` | one-time setup: install deps, pull a model, check creds. May be a **command** or a **skill** (see below). Run by `overcast provider init <verb>`. |
| `run(input, opts) -> record(s)` | do the work; emit one or more records on stdout (exec/http) or return them (in-proc). |
| `describe` | print capabilities + the output `payload` shape (feeds `setup` + `commands --json`). |

**exec wire protocol:** invoked `… run --input <ref> [--opt v] --json`; writes
record JSONL to **stdout**, logs to **stderr**; a non-zero exit is a hint, but
the record's `state`/`error` is authoritative. `init`/`describe` are subcommands.

A verb→provider binding is a descriptor stored in the active profile:

```jsonc
{ "verb": "watch", "type": "exec|http|inproc",
  "run": "…", "init": "…", "describe": "…",   // exec
  "endpoint": "http://…",                       // http
  "module": "./providers/watch.ts|.py" }        // inproc
```

Register with `overcast setup provider <verb> <spec>` (writes the descriptor) and
`overcast provider init <verb>` (runs setup). The binding lives in the profile,
so it travels with `setup`/`--profile`.

### Provider init — commands or skills

Every provider has a first-class **init** step (like a command/tool provider's
setup), run by `overcast provider init <verb>`, invoked automatically by
`prebrief` and `setup`, and checked by `overcast doctor`. `init` is either:

- a **command** — `./providers/whisper/init.sh` (install deps, pull a model,
  check creds), or
- a **skill** — `{ "skill": "<name>", "ensure": true }`. overcast **loads the
  skill locally if it isn't already installed**, then runs it — so a provider can
  reuse a rich, interactive onboarding flow instead of a brittle script.

The default **tinycloud** providers init via the **`tinycloud-init`** skill
(shipped by the tinycloud package). `overcast provider init watch` ensures that
skill is present (installing/loading it if missing) and runs it: install the
tinycloud CLI, configure the Cloudglue key (`tinycloud setup cloudglue --stdin`),
and verify (`tinycloud setup --check --json`). Descriptor:

```jsonc
{ "verb": "watch", "type": "exec",
  "run": "tinycloud watch {{input}} --shots --all-modalities --json",
  "init": { "skill": "tinycloud-init", "ensure": true },
  "describe": "tinycloud watch --schema --json" }
```

---

## Default (tinycloud) providers

v1 favors the **simplest thing that works**: a small bash wrapper around the
tinycloud CLI plus post-processing to emit a proper record. Richer extraction
comes later. **Setup** is delegated to the `tinycloud-init` skill via the
provider **init** step (see [Provider init](#provider-init--commands-or-skills))
— overcast loads that skill if missing, then runs it (CLI install, Cloudglue key,
verify).

### `watch` (default: tinycloud, exec)

- **v1:** run a tinycloud `watch`/`describe` with **shot detection** and **all
  modalities** for a comprehensive breakdown, then post-process into a flat
  `payload`:
  - `content` — markdown of the describe output (human-readable breakdown),
  - `transcript` — the speech VTT, rendered as markdown,
  - `detailed` — the full `describe` JSON fetched with `include shots` +
    `include thumbnails`.
- `media.ref` = the source; per-shot timestamps available in `detailed`.
- **Later:** target-driven `extract` jobs run **in parallel** (the same shape as
  `see`'s `--detect`/`--prompt`) plus a **face-detection** job, merged into
  `findings[]` with `media.at` anchors.

### `listen` (default: tinycloud, exec)

- **v1:** a **speech-only** describe → `transcript` (+ `segments[]` when
  available). Swap to a local whisper via `http`/`in-proc` for offline use.

### `see` (default: **placeholder**)

- **v1:** **no tinycloud implementation.** Ships as a placeholder that returns
  `state:"needs_credentials"`/guidance until a provider is bound. Bind a VLM via
  `setup provider see <http|module>`. (Image targets still route through whatever
  `see` provider is bound to produce a visual seed.)

### `enhance` (default: internal ffmpeg)

- Deterministic ops on the bundled ffmpeg toolkit; model-based ops (upscalers,
  source separation) are swappable providers. Not tinycloud-backed.

### tinycloud media-description collection (case source)

When the tinycloud provider is used **in a case**, `prebrief`/`case init` can
stand up a tinycloud **media-description collection** for that case. Every video
`watch`ed during the investigation is added to it, so `scan`/`capture`/query
against **video targets** can use the collection as a **source** (registered in
`sources.json`, `type: tinycloud-collection`). Population is hooked off the
emitted `watch` record (and can be triggered manually). This makes accumulated
perception searchable without re-running describes.

---

## Source providers (scrapers)

The OSINT-side twin of sense providers. A **source provider** is bound to a
source *type* and implements two ops (plus `init`/`describe`):

| Op | Purpose |
|---|---|
| `enumerate(query, since?, limit?)` | list items → `scan.hit` records (`title,url,source,published,snippet,media?`). Drives `scan`/`monitor`. `query` is either a **keyword search** or a **handle/channel/playlist/hashtag** ref (the active target supplies it by default). |
| `fetch(item, --index?)` | pull the item's media/content into the case → `capture` record. Drives `capture`. |

This is why there is **no `scrape` verb**: `source add` binds a scraper,
`scan`/`monitor` enumerate through it, `capture` fetches. Ad-hoc one-off scraping
of an arbitrary URL is just `capture <url>` (download / screenshot / scrape).

Same transports as sense providers (`exec`/`http`/`in-proc`) and the same
descriptor, keyed by source type instead of verb:

```jsonc
{ "source": "tiktok", "type": "exec",
  "enumerate": "./providers/sources/tiktok.sh enumerate",
  "fetch":     "./providers/sources/tiktok.sh fetch",
  "init":      { "command": "./providers/sources/tiktok.sh init" },  // checks APIFY_TOKEN
  "describe":  "./providers/sources/tiktok.sh describe" }
```

### Default source providers

Both enumerate either by **keyword search** or by a specific
**user/channel/playlist/hashtag**, selected by the source ref or `scan --query`:

- **`youtube`** — backed by **yt-dlp** (vendored alongside ffmpeg). `enumerate`
  resolves a **channel/handle**, a **playlist**, or a **keyword search** into
  video hits; `fetch` downloads the video. **No API key.** Bind forms:
  `source add youtube:@handle` · `youtube:playlist:<id>` · `youtube:search:"pier 9"`.
- **`tiktok`** — backed by the **Apify** actor
  [`clockworks/tiktok-scraper`](https://apify.com/clockworks/tiktok-scraper).
  `enumerate` runs the actor for a **user**, a **#hashtag**, or a **keyword
  search** and reads its dataset into hits; `fetch` pulls media via the returned
  URLs. **Needs `APIFY_TOKEN`** — `init` verifies it (and is where the user is
  prompted). Bind forms: `source add tiktok:@user` · `tiktok:#tag` ·
  `tiktok:search:"pier 9"`. Billed per Apify usage.

Both register in `sources.json` and respect `--since`/`--limit`. Add more
platforms by dropping in another source provider (same contract) and
`source add <type>:<ref>`.

### Sample: tiktok source provider (bash/exec, Apify)

`examples/providers/sources/tiktok.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
op="${1:?op}"; shift || true
ACTOR="clockworks~tiktok-scraper"
case "$op" in
  init)     [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN (apify.com)" >&2; exit 13; }; exit 0 ;;
  describe) echo '{"source":"tiktok","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
  enumerate)
    # args: --query <user|#tag> [--limit N]
    run=$(curl -s -X POST "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
          -H 'content-type: application/json' \
          -d "{\"profiles\":[\"$2\"],\"resultsPerPage\":${4:-20}}")
    jq -c '.[] | {id:("rec_"+(now|tostring)), verb:"scan", format:"json",
                  payload:{title:.text, url:.webVideoUrl, source:"tiktok",
                           published:.createTimeISO, author:.authorMeta.name},
                  media:{ref:.webVideoUrl}, meta:{provider:"apify:tiktok"}, state:"ready"}' <<<"$run" ;;
  fetch)    yt-dlp -o "$2" "$3"; echo "{\"verb\":\"capture\",\"media\":{\"ref\":\"$2\"},\"state\":\"ready\"}" ;;
esac
```

Register:

```bash
overcast source add tiktok:@some_user        # user (or tiktok:#tag / tiktok:search:"…")
overcast provider init tiktok                # prompts/validates APIFY_TOKEN
overcast scan --source tiktok --since 24h --pull           # enumerate the bound ref
overcast scan --query "pier 9" --source youtube,tiktok --pull   # ad-hoc keyword search
```

---

## Memory providers

The third provider class: where records are **written** and **recalled**. The
spec is multi-provider (**A-spec**); v1 ships a single local provider
(**B-first**) with the fan-out interface already in place.

| Op | Purpose |
|---|---|
| `write(record)` | persist/index a record — called automatically after every verb. |
| `query(q, opts) -> records\|passages` | retrieval for `ask` / recall / `brief`. |
| `answer(q) -> {text, citations}` | *(optional)* grounded NL answer. |
| `deepsearch(q) -> hits` | *(optional)* agentic semantic search. |
| `init` / `describe` | as usual. |

### Tiers & defaults

- **local** (default, always on, **B-first ships this**) — the
  `.overcast/records/*.jsonl` store + a lightweight index (keyword; embeddings
  optional). No external deps. Per-case.
- **cloudglue** (when tinycloud is the backend) — backs memory with a Cloudglue
  **collection**. Recall uses tinycloud's **public CLI verbs only** — `tinycloud
  search` (keyword), `tinycloud probe` (deep search over the collection),
  `tinycloud ask` (grounded responses w/ time-anchored citations), `tinycloud
  library` (collection membership). **Never call tinycloud internal libs** — only
  its verbs (verify names against `tinycloud commands --json`). Per-case; also
  registered as a `source` (the duality). Stood up by `prebrief`/`case init`.
- **pi-memory** (recommended companion, optional, **global**) — the
  investigator's curated notes / scratchpad / daily logs across sessions. Reuse
  the pi-memory pi package rather than reimplement; overcast writes distilled
  facts to it only if the user opts in.

### Resolved decisions

- **Scope:** records + media-semantic memory are **per-case**; agent notes
  (pi-memory) are **global / cross-case**.
- **`ask` routing:** **fan out** across bound memory providers and merge,
  preferring grounded/cited results; `ask --deep` forces agentic deepsearch.
  Question-shape routing is a later optimization.
- **Granularity:** store **full records**; a distilled facts/entities layer is
  **post-v1** (a `distill` step), out of v1 scope.

### Descriptor (cloudglue, illustrative — verify verbs against `commands --json`)

```jsonc
{ "memory": "cloudglue", "type": "exec",
  "write":      "tinycloud library add {{collection}} {{media}} --json",
  "query":      "tinycloud search {{q}} --in collection:{{collection}} --json",
  "deepsearch": "tinycloud probe  {{q}} --in collection:{{collection}} --json",
  "answer":     "tinycloud ask    {{q}} --in collection:{{collection}} --json",
  "init":       { "skill": "tinycloud-init", "ensure": true },
  "describe":   "tinycloud commands --json" }
```

Bind with `overcast setup memory add <spec>` (multiple allowed; the local
provider is implicit and always present).

---

## Sample: bash provider (exec)

`examples/providers/bash/watch.sh` — the canonical v1 pattern.

```bash
#!/usr/bin/env bash
# overcast exec provider: watch (tinycloud)
set -euo pipefail
case "${1:-run}" in
  init)     command -v tinycloud >/dev/null || { echo "install tinycloud" >&2; exit 13; }; exit 0 ;;  # minimal; production init defers to the tinycloud-init skill
  describe) echo '{"verb":"watch","kind":"video.analysis","payload":["content","transcript","detailed"]}'; exit 0 ;;
esac
# run --input <ref> --json
input="$2"; shift 2 || true
desc="$(tinycloud watch "$input" --shots --all-modalities --json)"        # provider call
content="$(jq -r '.summary_markdown'      <<<"$desc")"
transcript="$(tinycloud caption "$input" --vtt --json | jq -r '.vtt_markdown')"
detailed="$(tinycloud describe "$input" --include shots,thumbnails --json)"
jq -n --arg c "$content" --arg t "$transcript" --argjson d "$detailed" --arg ref "$input" \
  '{id:("rec_"+ (now|tostring)), verb:"watch", format:"json",
    payload:{content:$c, transcript:$t, detailed:$d},
    media:{ref:$ref}, meta:{provider:"tinycloud"}, state:"ready"}'
```

Register:

```bash
overcast setup provider watch "exec:./examples/providers/bash/watch.sh"
overcast provider init watch
```

---

## Sample: TypeScript provider (in-proc / exec)

`examples/providers/ts/see.ts` — using `@overcast/provider-sdk`. Run in-proc when
the harness is TS, or as a subprocess (exec) otherwise.

```ts
import { defineProvider } from "@overcast/provider-sdk";

export default defineProvider({
  verb: "see",
  async init(ctx) { if (!process.env.VLM_API_KEY) ctx.fail("needs_credentials", "set VLM_API_KEY"); },
  describe: () => ({ verb: "see", kind: "image.analysis", payload: ["caption", "ocr", "detections"] }),
  async run({ input, opts }, ctx) {
    const r = await myVlm(input, { ocr: opts.ocr, detect: opts.detect });   // your model call
    return ctx.ok("image.analysis", {                                       // → record
      caption: r.caption, ocr: r.text, detections: r.boxes,
    }, { media: { ref: input } });
  },
});
```

Register (in-proc module, or wrap as exec):

```bash
overcast setup provider see "inproc:./examples/providers/ts/see.ts"
# or expose over the exec contract:
overcast setup provider see "exec:overcast-provider ./examples/providers/ts/see.ts"
```

---

## Sample: Python provider (http / exec)

`examples/providers/python/listen.py` — a local whisper, served over http or run
as exec. Uses `overcast_sdk`.

```python
from overcast_sdk import provider, ok, fail

@provider(verb="listen")
def run(input, opts, ctx):
    if not shutil.which("whisper"):
        return fail("needs_credentials", "install whisper")
    segments, text = transcribe(input, diarize=opts.get("diarize"))   # your model call
    return ok("audio.analysis",
              {"transcript": text, "segments": segments},
              media={"ref": input})

def describe():
    return {"verb": "listen", "kind": "audio.analysis", "payload": ["transcript", "segments"]}
```

Run as a local HTTP endpoint, then bind:

```bash
python -m overcast_sdk.serve examples/providers/python/listen.py --port 8090
overcast setup provider listen "http://localhost:8090"
# or exec:
overcast setup provider listen "exec:python examples/providers/python/listen.py"
```

---

## What the repo must ship

- `examples/providers/{bash,ts,python}/` — the three samples above, runnable.
- `@overcast/provider-sdk` (TS) and `overcast_sdk` (Python) — `defineProvider` /
  `@provider`, helpers (`ok`, `fail`), and a tiny `serve` for http.
- `docs/providers.md` — generated/derived from this doc for end users.
- The **default tinycloud** bash providers for `watch` + `listen`, and the `see`
  **placeholder**.
- **Source providers**: `youtube` (yt-dlp) + `tiktok` (Apify).
- **Memory providers**: `local` (record store + index, default/B-first) +
  `cloudglue` (collection via public tinycloud verbs); pi-memory documented as a
  recommended companion.
