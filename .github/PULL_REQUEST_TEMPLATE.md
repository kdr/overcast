<!-- Thanks for contributing to overcast! Please fill this out so review is quick. -->

## What & why

<!-- What does this change do, and what problem does it solve? Link any issue: Fixes #123 -->

## How was it verified?

<!-- Which commands/tests did you run? For provider/record changes, mention the fixture/verb you exercised. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (and `npm run test:e2e` if providers/records changed)
- [ ] Regenerated `skills/` (`overcast skills generate`) if the verb registry changed
- [ ] Did **not** bump the pinned `@earendil-works/*` versions (that's a separate, reviewed change)
- [ ] Documented any new env var / provider in `.env.example` and the README
- [ ] Commits are signed off (`git commit -s`) per the [DCO](../blob/main/CONTRIBUTING.md#sign-off-dco)

## For new OSINT sources reaching personal data

- [ ] N/A — not a PII-reaching source
- [ ] The source is **opt-in and never a default binding**
- [ ] It's documented in [`RESPONSIBLE_USE.md`](../blob/main/RESPONSIBLE_USE.md) with its legal constraints (ToS, DPPA/FCRA/biometric law as applicable)

## Security-sensitive code

- [ ] N/A
- [ ] New outbound fetches go through the SSRF guard (`assertFetchHostAllowed`)
- [ ] New `spawn`s pass arguments as an argv array (no `shell: true`); untrusted inputs are treated as hostile
- [ ] New user-facing output that can contain provider data goes through `redactSecrets`
