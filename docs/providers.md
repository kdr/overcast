# Authoring overcast providers

overcast binds verbs to backends through **providers**. There is one wire
contract (the **record**) and three transports: `exec` (default), `http`,
`in-proc`. Three provider classes share the same machinery — **sense**
(`watch`/`listen`/`see`/`enhance`), **source** (scrapers), and **memory**
(`write`/`recall`). This doc is derived from
[`planning/05-providers.md`](../planning/05-providers.md).

## The exec wire contract

An exec provider is a command invoked three ways:

| Invocation | Purpose |
|---|---|
| `<cmd> init` | one-time setup / cred check. Exit `13` = needs credentials. |
| `<cmd> describe` | print capabilities + payload shape (JSON on stdout). |
| `<cmd> run --input <ref> [--opt v] --json` | do the work; print record JSON(L) on stdout, logs on stderr. |

A non-zero exit is a hint; the record's `state`/`error` is authoritative.
overcast maps stdout to the loose record at the exec boundary — your provider
just needs to emit `{ verb, format, payload, media?, meta?, state? }`.

## Binding a provider

```bash
# sense provider (per verb)
overcast setup provider watch  "exec:./examples/providers/bash/watch.sh"
overcast setup provider listen "exec:python3 examples/providers/python/listen.py"
overcast setup provider see    "exec:node --import tsx examples/providers/ts/see.ts"
overcast setup provider see    "http://localhost:8090"          # http transport
overcast provider init see                                      # run the init hook

# source provider (scraper) — bound by source type, enumerated by scan/capture
overcast source add tiktok:@some_user
OVERCAST_SOURCE_TIKTOK_CMD="bash examples/providers/sources/tiktok.sh" \
  overcast scan --source tiktok --pull
```

Bindings live in the active profile (`~/.overcast/profiles/<name>.json`), so they
travel with `--profile`. **Rebinding a verb requires no overcast code changes** —
the default tinycloud `watch`/`listen` and the `see` placeholder are just the
out-of-the-box descriptors.

## Samples (runnable, in this repo)

- [`examples/providers/bash/watch.sh`](../examples/providers/bash/watch.sh) — the canonical tinycloud `watch` exec provider.
- [`examples/providers/python/listen.py`](../examples/providers/python/listen.py) — a local-whisper `listen` provider (exec/http).
- [`examples/providers/ts/see.ts`](../examples/providers/ts/see.ts) — a VLM `see` provider (exec/in-proc).
- [`examples/providers/sources/tiktok.sh`](../examples/providers/sources/tiktok.sh) — an Apify-backed `tiktok` source provider.

Each responds to `describe` offline:

```bash
./examples/providers/bash/watch.sh describe
python3 examples/providers/python/listen.py describe
node --import tsx examples/providers/ts/see.ts describe
bash examples/providers/sources/tiktok.sh describe
```

## Memory providers

`ask`/`brief` read through bound **memory** providers (fan-out; the always-on
`local` provider indexes `.overcast/records`). A `cloudglue` memory provider
(collection-backed, via public tinycloud verbs) is the A-spec second tier.

## Readiness

`overcast doctor` checks pi, the vendored ffmpeg/ffprobe, Cloudglue creds, the
tinycloud CLI, the home/profiles, and the active provider bindings.
