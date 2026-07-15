# `examples/` — read-and-copy material, not shipped code

Everything under `examples/` is **teaching material and helpers you read, copy, or
run by hand**. It is deliberately *not* the shipped provider tree.

After the provider restructure there are two trees, and the split is the point:

| Tree | What it is | Who points at it |
| --- | --- | --- |
| **`providers/`** (repo root) | The **shipped** provider scripts — production code | The catalog (`provider setup apply --choice …`), `shipped:<relpath>` refs, the bun sidecar, `package.json` `files` |
| **`examples/`** (here) | Authoring demos + a profile helper | Nothing automatic — you read/copy them yourself |

So overcast never *ships* anything here as a bindable: the catalog doesn't list
these, no `shipped:` ref resolves to them, and the profile-healing move table
leaves them alone (see `src/providers/shipped-ref.ts`). If you're looking for the
real, catalog-bound providers, they live in
[`../providers/`](../providers/) — start with [`docs/providers.md`](../docs/providers.md).

## What's in here

- **[`providers/`](providers/)** — one minimal "how to write a provider" demo per
  language (bash / python / TypeScript), plus an MCP-source prototype. These show
  the exec wire contract you implement when authoring your own provider. See
  [`providers/README.md`](providers/README.md).
- **[`profiles/`](profiles/)** — `install-profiles.sh`, a convenience script that
  builds a few ready-made profiles (`fal`, `cloudglue`, `elevenlabs`, `hf`,
  `recon`) combining the **shipped** providers so you can A/B backends. See
  [`profiles/README.md`](profiles/README.md).

## The one nuance

Most of these are pure *sketches* — skeletal, "map your model's output to the
record" stubs. Two are **dual-use** (functional enough to actually bind, via the
sanctioned raw-`exec:` escape hatch in invariant #6):

- `providers/python/enhance.py` — a real fal-routed HF image upscale/unblur binding
- `providers/sources/mcp-bridge.ts` — drives any stdio MCP server as an overcast source

They stay here (not in `providers/`) because they're opt-in / BYO-model demos the
catalog should never auto-bind — but they work if you point an `exec:` binding at
them.
