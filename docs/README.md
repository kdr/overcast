# overcast documentation

The front-door [README](../README.md) covers what overcast is, install, and the
verb surface. This folder holds the deeper references.

| Doc | What's in it |
| --- | --- |
| [flows.md](flows.md) | End-to-end investigation flows — how the verbs chain into real workflows (scan → capture → sense → ask/brief). |
| [providers.md](providers.md) | The provider model in depth: binding senses/sources, the profile system, and **authoring your own provider** (manifests, `provider install`). |
| [../RESPONSIBLE_USE.md](../RESPONSIBLE_USE.md) | Dual-use / acceptable-use policy and per-source legal constraints. |
| [../SECURITY.md](../SECURITY.md) | Trust model and vulnerability disclosure. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Dev setup, architecture invariants, and the PR checklist. |
| [../RELEASING.md](../RELEASING.md) | Release process and versioning. |
| [../CLAUDE.md](../CLAUDE.md) | The architecture guide (written for AI agents, accurate for humans) — invariants, stack, and the full verb surface. |

Authoritative, always-current references:

```bash
overcast commands --json   # the verb registry — the source of truth
overcast <verb> --help     # a man page for any verb
overcast doctor            # what's installed / configured
```
