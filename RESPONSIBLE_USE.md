# Responsible Use

overcast gives an agent **senses** (video / audio / image understanding) and
**OSINT reach** (search, capture, monitor, reverse-image/-face lookup,
skip-trace and public-records sources). Those are powerful, general-purpose
capabilities. Like a camera, a search engine, or a network scanner, they can be
used for legitimate investigation and journalism — or misused to surveil,
harass, dox, or stalk. This document sets the boundary we expect every user to
stay inside.

**By using overcast you agree to use it only for lawful purposes and only
against targets you are authorized to investigate.**

## Use it for

- Security research, red-team / blue-team, and CTF work **on systems and
  accounts you own or are explicitly authorized to test**.
- Open-source intelligence for journalism, research, fact-checking, and
  incident response, conducted lawfully and ethically.
- Analyzing **your own** media, or media you have the right to analyze.
- Missing-person, disaster-response, and public-safety work by people
  authorized to do it.

## Do not use it for

- Stalking, harassment, doxxing, intimidation, or building profiles of private
  individuals without a lawful basis.
- Surveillance of people who have a reasonable expectation of privacy.
- Circumventing the Terms of Service of any third-party platform or data source.
- Any use prohibited by law in your jurisdiction or the target's — including
  data-protection law (GDPR, CCPA, and equivalents), anti-stalking law,
  computer-misuse law, and sector-specific restrictions (below).
- Automated decisions about a person's eligibility for credit, employment,
  housing, or insurance. overcast is **not** a consumer-reporting tool and its
  output is **not** an FCRA report.

## The high-sensitivity sources

Several sources reach **personal information about real, identifiable people**.
They are **opt-in and never enabled by default** — you must deliberately bind
and invoke them — and each carries legal constraints you are responsible for:

| Source | What it reaches | Your responsibility |
| --- | --- | --- |
| `facesearch` | Reverse **face** search across the web | ToS/privacy-gated; many jurisdictions regulate biometric processing (e.g. BIPA, GDPR Art. 9). Get a lawful basis. |
| `person` | People-search / skip-trace (addresses, phones, relatives, age) | **Not** an FCRA consumer report — never use for credit/employment/housing/insurance decisions. |
| `phone` | Reverse-phone / number OSINT | Public-footprint only; don't use to harass or for prohibited screening. |
| `property` | Assessor / tax / recorder records | Public records, but re-purposing them to target a resident can still be unlawful harassment. |
| `plate` | License-plate → vehicle spec | Registered-**owner** data is **DPPA-restricted** in the US; overcast ships **no default actor** for this and returns vehicle spec only. |
| `username` | Account discovery across many sites | Aggregating someone's accounts can constitute stalking if used to target them. |
| `lens`, `yandeximg` | Reverse-image search | Can de-anonymize people in photos; use lawfully. |
| `shodan`, `dork` | Host/service recon, Google dorking | Recon only; do not use to access systems without authorization. |

overcast also **captures and stores** third-party media and scraped content in a
case folder. You are the data controller for anything you collect. Retain only
what you need, secure it, and delete it when your lawful basis ends.

## Third-party services and their terms

Many sources call third-party APIs and scraping actors (Apify, Google/Yandex,
Serper, Shodan, Cloudglue/tinycloud, fal, and others). You bring your own keys
and you are bound by **their** terms of service and rate limits as well as the
law. overcast does not grant you any right to a third party's data.

## No warranty; you are responsible

overcast is provided under the Apache-2.0 license, **without warranty of any
kind**. OSINT results can be wrong, stale, or point at the wrong person —
treat every result as a **lead, not proof** (many verbs deliberately stamp
`payload.caveat` to reinforce this). You are solely responsible for how you use
this tool and for complying with all applicable laws and terms. The authors and
contributors accept no liability for misuse.

If your intended use doesn't clearly fit "Use it for" above, that's a signal to
stop and reconsider.
