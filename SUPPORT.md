# Support

Thanks for using overcast! Here's how to get help.

## First, self-diagnose

Most setup problems are a missing prerequisite or an unbound provider. Run:

```bash
overcast doctor            # checks pi, providers, ffmpeg, and credentials
overcast doctor --sources  # also checks source credentials
overcast commands --json   # the authoritative list of verbs and flags
overcast <verb> --help     # a man page for any verb
```

The [README](README.md), [`docs/flows.md`](docs/flows.md) (end-to-end flows), and
[`docs/providers.md`](docs/providers.md) (provider setup and authoring) cover most
questions.

## Where to go

| I want to… | Go to |
| --- | --- |
| Ask a question / share a workflow / propose an idea | [Discussions](https://github.com/kdr/overcast/discussions) |
| Report a reproducible bug | [Issues](https://github.com/kdr/overcast/issues/new/choose) |
| Request a feature | [Issues](https://github.com/kdr/overcast/issues/new/choose) |
| **Report a security vulnerability** | [Security Advisories](https://github.com/kdr/overcast/security/advisories/new) — **not** a public issue (see [SECURITY.md](SECURITY.md)) |
| Contribute code | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Before filing an issue

- Update to the latest release (`npm i -g @kdrrr/overcast@latest`) and re-check.
- Include your `overcast --version`, OS, Node version, and `overcast doctor`
  output.
- **Redact real targets, PII, credentials, and case data** from anything you
  paste.

This is a community-maintained open-source project — please be patient and kind.
