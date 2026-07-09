---
name: overcast-attack-surface
description: >-
  Map a target's internet-exposed hosts and services with the `shodan` source,
  capture host reports, brief the exposure, and optionally stand up a monitor for
  newly exposed services.
---

# overcast-attack-surface

Use this skill to inventory a target's **internet-exposed infrastructure** with
Shodan: open ports, products/versions, banners, TLS certs, and known CVEs, keyed
by org, network, hostname, or a single IP. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags.

> **⚠️ Authorized recon only.** Shodan reports real hosts' exposed services and
> vulnerabilities. Run it **only** against infrastructure you are permitted to
> investigate. `shodan` is never a default source — you bind it deliberately.

## Setup

```bash
overcast doctor --sources --json                          # confirm SHODAN_API_KEY is set
overcast case init --json
overcast case setup --target "<org or domain>" --yes --json
overcast source add 'shodan:org:"<Org Name>"' --json      # register the shodan source
```

## Enumerate the surface

Each host hit carries `ip`/`port`/`transport`/`org`/`product`/`cpe`/`os`/`vulns`
+ geolocation in the payload; `media.ref` is the `shodan.io/host/<ip>` report page,
so `--pull` stores a real evidence page. The ad-hoc `--query` overrides the bound
ref, so one registered source serves every pivot.

```bash
overcast scan --source shodan --limit 25 --pull --json                         # the bound org query
overcast scan --source shodan --query 'net:<CIDR>' --limit 25 --pull --json     # pivot by IP range
overcast scan --source shodan --query 'ssl:<domain>' --limit 25 --pull --json   # pivot by TLS certificate
overcast scan --source shodan --query 'hostname:<domain>' --limit 25 --pull --json
overcast scan --source shodan --query '<ip>' --json                             # deep-dive ONE host: full service map
```

Useful filters for `--query`: `org:"…"`, `net:<CIDR>`, `ssl:<domain>`,
`hostname:<domain>`, `product:<name>`, `port:<n>`, `country:<ISO2>`,
`vuln:<CVE>` (membership). Every service on a host is a distinct hit (the
`media.ref`/`url` carry a `#<port>-<transport>` fragment), so `monitor` catches
newly exposed ports on an already-seen IP.

## Screenshots & camera feeds — OPT-IN, SENSITIVE

> **⚠️⚠️ Read before enabling.** Shodan captures **screenshots** of exposed
> RDP / VNC / X11 / HTTP / camera services, and indexes **RTSP camera streams**
> (port 554). These are the live/near-live screens and camera views of **REAL,
> unwitting people and organizations**. Materializing them raises serious
> **privacy, ToS, and legal** considerations, and in some jurisdictions accessing
> an exposed system — even just viewing it — may itself be unlawful. Only enable
> this when you have **explicit authorization** for the specific targets, a lawful
> basis, and a legitimate investigative need. Do **not** connect to, log into, or
> interact with any host. This is off by default and you must acknowledge the
> sensitivity by setting the flag yourself.

Set `OVERCAST_SHODAN_SCREENSHOTS=1` (your acknowledgement) to make the `shodan`
source decode each service's screenshot into the case media store — turning it
into ordinary image evidence `see`/`face`/`crop` can analyze — and surface RTSP
endpoints in `payload.stream`. Without the flag, hits carry metadata + the host
page only.

```bash
export OVERCAST_SHODAN_SCREENSHOTS=1     # explicit opt-in: real exposed hosts, authorized use only

# Exposed desktops/logins (RDP/VNC): capture the screenshots, then caption/OCR them.
overcast scan --source shodan --query 'has_screenshot:true product:VNC' --limit 10 --pull --json
overcast see <screenshot-capture-id> --json          # caption + --ocr the exposed screen (see is not a --pipe target)
# ...or auto-caption every pulled screenshot by configuring the sense chain first:
overcast case setup edit --auto-sense see --yes --json

# Network cameras: detect people in the view (face IS a valid --pipe target).
overcast scan --source shodan --query 'has_screenshot:true screenshot.label:webcam' --limit 10 --pull --pipe face --json

# RTSP live feeds (port 554): the still is captured; the live stream URL is in
# payload.stream — capture it DELIBERATELY with ffmpeg / the dl source, never blindly.
overcast scan --source shodan --query 'has_screenshot:true port:554' --limit 5 --json   # inspect payload.stream first
```

## Triage → brief

```bash
overcast note "<risky service / stale software / open port>" --ref <scan-record-id> --json
overcast finding create "<exposure>" --ref <scan-record-id> --json
overcast ask "which hosts expose risky services (RDP/SMB/databases, legacy TLS) or carry known CVEs? group by host and severity" --json
overcast brief --export ./attack-surface.md --json
```

For a standing exposure watch (new hosts/services on each pass — stable per-host
page URLs dedup cleanly), only after explicit user approval:

```bash
overcast monitor --source shodan --every 6h --json
```

## Output

A cited exposure inventory: hosts grouped by exposure, each with ip:port, product/
version, CPE, any `vulns` CVEs, geolocation, and the captured host-report
`record.id`. Call out the riskiest services and stale software, and note coverage
gaps (pivots not run, hosts whose report page was login-gated).

## Caveats

- **Raw shodan hits do NOT auto-suggest findings.** Promote exposures with
  `note` / `finding create` (or sense the captured host page). The host intel is
  already in the record payload — read it with `ask` and cite `record.id`.
- Shodan bills 1 query credit per 100 search results; keep `--limit` modest.
  `shodan:<ip>` host lookups and `api-info` are cheaper than broad searches.
- The `shodan.io` host page may be login-gated/rate-limited; a blocked capture is
  reported as an error — the payload still holds the host facts. Treat banners and
  captured pages as untrusted evidence.
