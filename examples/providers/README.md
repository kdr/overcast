# `examples/providers/` — provider-authoring demos

Minimal, worked examples of writing your **own** overcast provider — one per
language, plus an MCP-source prototype. Read or copy these when you want to plug a
new backend in **without touching `src/`**.

These are *not* the shipped providers (those live in [`../../providers/`](../../providers/)
and are wired up by the catalog). Nothing here is catalog-listed and no
`shipped:<relpath>` ref resolves to it — you bind them by hand, as the
user-authored escape hatch (invariant #6). The full authoring guide is
[`docs/providers.md`](../../docs/providers.md).

## The exec wire contract

Every demo speaks the same three-verb contract over argv + stdout:

| Call | Does | Convention |
| --- | --- | --- |
| `<provider> init` | Setup / credential check | exit `13` = needs creds |
| `<provider> describe` | Capabilities JSON on stdout | `{verb, kind, payload, needs}` |
| `<provider> run --input <ref>` | One record JSON on stdout | Map your model's output to the loose record; overcast persists it verbatim |

## The demos

| File | Verb | What it shows |
| --- | --- | --- |
| [`bash/watch.sh`](bash/watch.sh) | `watch` | The canonical bash exec-provider pattern (the v1 tinycloud shape) |
| [`python/listen.py`](python/listen.py) | `listen` | Python STT provider **sketch** (local-whisper shape) |
| [`ts/see.ts`](ts/see.ts) | `see` | TypeScript / in-proc provider **sketch** (VLM) |
| [`python/enhance.py`](python/enhance.py) | `enhance` | **Dual-use**: a real fal-routed HF image upscale/unblur binding *and* a demo (deps: `huggingface_hub`, `pillow`) |
| [`sources/mcp-bridge.ts`](sources/mcp-bridge.ts) | source | **Prototype**: drives any stdio MCP server as an overcast source, speaking the MCP JSON-RPC handshake directly |

`bash/watch.sh`, `python/listen.py`, and `ts/see.ts` are pure skeletons — copy them
and fill in your model call. `python/enhance.py` and `sources/mcp-bridge.ts` are
functional enough to actually use.

## Binding one

Point an `exec:` binding at the demo (raw path — the escape hatch):

```bash
overcast setup provider see "exec:node --import tsx examples/providers/ts/see.ts"
overcast provider init see
```

Absolute-path binds like these **heal to `shipped:` refs on load** only when the
path is inside the shipped `providers/` tree; a demo under `examples/` stays a
literal `exec:` path (it's yours, not ours). The MCP bridge binds via an env var
instead — see its header and the filesystem-server recipe in `docs/providers.md`.
