# Security Policy

Thanks for helping keep overcast and its users safe. overcast is an
investigation toolkit that handles untrusted media and adversarial web content,
so we take security seriously and welcome good-faith research.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report privately through **GitHub Security Advisories**:
[**Report a vulnerability**](https://github.com/kdr/overcast/security/advisories/new)
(the "Report a vulnerability" button under the repository's **Security** tab).
This creates a private thread with the maintainers.

Please include:

- A description of the issue and its impact.
- The version / commit (`overcast --version`) and your platform.
- Reproduction steps or a proof-of-concept, and any relevant `overcast doctor`
  output. **Redact real targets, PII, credentials, and case data** from
  anything you attach.

We aim to acknowledge a report within **5 business days** and to keep you
updated as we investigate. We'll credit reporters who want it once a fix ships.
This is a volunteer-maintained open-source project, so please allow reasonable
time before any public disclosure — we'll work with you on timing.

## Scope — what is a vulnerability vs. by-design behavior

overcast is a local, single-operator tool that deliberately gives an agent broad
capabilities. Some behavior that looks alarming is **intentional and
documented**. Understanding the trust model helps you report real issues:

**By design (not vulnerabilities):**

- **No sandbox / no permission system.** overcast runs on top of
  [pi](https://github.com/earendil-works/pi) and inherits its model: base tools
  (`read`/`write`/`edit`/`bash`/…) and providers run with the operator's own
  privileges. Treat the whole tool as running as you.
- **Untrusted media and scraped content are prompt-injection vectors.** overcast
  ingests adversarial video, audio, images, and web pages and feeds them to an
  LLM. Malicious content may attempt to steer the agent. Run investigations in
  an environment you're willing to expose to the material you're collecting.
- **Exec providers run with your environment.** A provider bound via `exec:` or
  installed with `provider install` is third-party code that runs as you and,
  today, inherits your environment (including API keys). Only install providers
  you trust — the same bar as installing an npm package or a shell plugin. See
  [`docs/providers.md`](docs/providers.md).
- **Local servers exist but are loopback + token-gated.** `situation serve` and
  `/chair` bind to `127.0.0.1` by default and require a 256-bit bearer token.
  Binding to a wider interface (`--bind`, `tailnet`, `OVERCAST_*_BIND`) is an
  explicit operator choice; do it only on networks you trust.
- **A dotenv outside a trusted root cannot pick binaries or endpoints.** overcast
  auto-loads `.env` from the working directory and from `--case <dir>`, which are
  routinely someone else's content. Command/interpreter and endpoint keys
  (`*_CMD`, `*_PY`, `*_BASE_URL`, `*_ENDPOINT`, `*_API`, `*_ACTOR`,
  `OVERCAST_FFMPEG`, …) are **ignored** from such a file, with a warning naming
  what was skipped; ordinary keys still load. The overcast package root and
  `OVERCAST_HOME` are trusted, and `OVERCAST_TRUST_DOTENV=1` opts any directory
  back in.
- **A case directory selects providers, it does not supply commands.** A case's
  `.overcast/setup.json` may name a provider `choice`; the executable descriptor
  is resolved from the trusted catalog/manifest corpus or your profile in
  `<home>`, never taken from the case folder.

**In scope (please report):**

- Path traversal / arbitrary file read or write outside the case directory
  (e.g. via the `/media` route, static asset serving, archive/case refs, or
  provider-install tarball extraction).
- Auth bypass on the `situation` / `chair` local servers, token leakage, or
  missing constant-time comparison.
- SSRF beyond the documented residual — a way to reach internal/loopback/cloud-
  metadata hosts that defeats `assertFetchHostAllowed`, or an outbound fetch path
  that never consults it. Two **known residuals**, both narrower than a report:
  (a) the DNS-rebinding TOCTOU on the media/screenshot fetch path — see the code
  comments in `src/media/fetch.ts`; (b) the shipped shell fetchers let `curl`
  follow a redirect chain and then check the address it actually reached
  (`providers/engines/net/guarded-fetch.sh`), so a redirect INTO a private host
  still issues that one request — the body is deleted and never becomes a
  capture record, but the request is not prevented. A novel or more reliable
  bypass is still worth reporting.
- Command / argument injection into a spawned binary (ffmpeg, yt-dlp, tinycloud,
  etc.) from a filename, URL, ref, or scraped field.
- Credential/API-key leakage into persisted records, exported reports, logs, or
  the web consoles (the `redactSecrets` boundary in `src/env.ts` is meant to
  prevent this — a bypass is in scope).
- Any way for scraped/untrusted content to achieve code execution or escape the
  case directory beyond the documented prompt-injection stance.

## Supported versions

overcast is pre-1.0 and ships from `main`. Security fixes land on the latest
released version on npm (`@kdrrr/overcast`) and the `main` branch. Please test
against the latest release before reporting.

## Handling your own case data

Cases can contain sensitive media and PII. overcast stores everything locally in
the case's `.overcast/` folder — nothing is uploaded except what you send to the
third-party providers you configure. Secure your case directories accordingly,
and see [`RESPONSIBLE_USE.md`](RESPONSIBLE_USE.md) for your obligations as the
data controller.
