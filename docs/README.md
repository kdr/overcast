# overcast documentation

The front-door [README](../README.md) covers what overcast is, install, and the
verb surface at a glance. This folder holds the deeper references.

| Doc | What's in it |
| --- | --- |
| [field-manual.md](field-manual.md) | **Field Manual** — the operational playbook: the quickstart cookbook + end-to-end investigation flows (scan → capture → sense → ask/brief), the live control room, and the case memory model. |
| [verbs.md](verbs.md) | Verb & source reference — every verb and every built-in source ref. |
| [configuration.md](configuration.md) | Binding senses/sources to backends, the profile system, findings tuning, local DBs, and the full environment-variable surface. |
| [providers.md](providers.md) | The provider model in depth: **authoring your own provider** (manifests, `provider install`) and the binding contract. |
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
