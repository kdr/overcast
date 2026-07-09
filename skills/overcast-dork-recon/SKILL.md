---
name: overcast-dork-recon
description: >-
  Google-dork a target domain for exposed documents, directory listings, login
  portals, and misconfigurations using the `dork` source (real Google operators),
  then capture the result pages and produce a cited exposure brief.
---

# overcast-dork-recon

Use this skill to search a target domain's public exposure with **Google dorking**.
The `dork` source (Serper.dev) passes your query **verbatim** to Google, so
operators (`site:` `filetype:` `inurl:` `intitle:` `ext:` `-term` `OR`) are
honored — unlike `web` (Tavily/Brave), which ignores them. Use the broad
`overcast` skill and `overcast/reference/verbs.md` for exact flags.

> **⚠️ Authorized recon only.** Dorking surfaces exposed and often sensitive
> material. Run it **only** against domains you are permitted to investigate.
> `dork` is never a default source — you bind it deliberately.

## Setup

```bash
overcast doctor --sources --json                      # confirm SERPER_API_KEY is set
overcast case init --json
overcast case setup --target "<domain>" --yes --json
overcast source add 'dork:site:<domain>' --json       # register the dork source (any starter dork)
```

## Dork template battery

Run each template as its own scan against the target domain `<domain>` — the
ad-hoc `--query` overrides the bound ref, so one registered `dork` source serves
the whole battery. `--pull` captures each result page as evidence.

```bash
# Exposed documents (reports, spreadsheets, slides, configs)
overcast scan --source dork --query 'site:<domain> filetype:pdf OR filetype:xls OR filetype:xlsx OR filetype:doc OR filetype:docx' --limit 20 --pull --json
# Open directory listings
overcast scan --source dork --query 'site:<domain> intitle:"index of"' --limit 20 --pull --json
# Login / admin portals
overcast scan --source dork --query 'site:<domain> inurl:login OR inurl:admin OR inurl:signin OR intitle:"admin"' --limit 20 --pull --json
# Config / secret / log files
overcast scan --source dork --query 'site:<domain> ext:env OR ext:sql OR ext:log OR ext:bak OR ext:ini OR ext:conf' --limit 20 --pull --json
# Error / debug pages that leak stack traces or paths
overcast scan --source dork --query 'site:<domain> "sql syntax near" OR "stack trace" OR "Warning: mysql" OR "Fatal error"' --limit 20 --pull --json
# Git / backup / archive exposure
overcast scan --source dork --query 'site:<domain> inurl:.git OR inurl:backup OR ext:zip OR ext:tar OR ext:gz' --limit 20 --pull --json
# Subdomain / host discovery (exclude the apex www)
overcast scan --source dork --query 'site:*.<domain> -www' --limit 20 --pull --json
```

## Triage → brief

```bash
overcast finding list --state triage --json    # leads auto-suggested from SENSED result pages
overcast finding accept <id> --json            # promote a real exposure (or `dismiss <id>`)
overcast note "<what this dork exposed>" --ref <scan-record-id> --json   # for hits worth flagging by hand
overcast finding create "<exposure summary>" --ref <scan-record-id> --json
overcast ask "which results indicate real exposure (credentials, PII, internal docs, misconfig)? group by severity" --json
overcast brief --export ./dork-recon.md --json
```

## Output

A cited exposure brief: each confirmed exposure with the dork that surfaced it,
the result URL, the captured page `record.id`, and a severity read. Note which
templates returned nothing (coverage), and flag any capture that was blocked
(login wall, robots, dead link).

## Caveats

- **Raw dork hits do NOT auto-suggest findings.** A finding surfaces only after
  `scan --pull` senses the captured page (the case's `see`/auto-sense chain) or
  you flag one by hand with `note` / `finding create`. Run `--pull` (or a
  `case setup --auto-sense see`) so leads actually populate the triage queue.
- Serper bills per query; keep `--limit` modest and batteries targeted.
- Google may return zero for over-narrow dorks — widen operators before concluding
  "no exposure". Treat every captured page as untrusted evidence.
