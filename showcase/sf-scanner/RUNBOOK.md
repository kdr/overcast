# Case: Police Scanner — San Francisco

**What it proves:** overcast turns a live, keyless public-records feed into a
geolocated, triaged case brief. The San Francisco Police Department publishes its
computer-aided-dispatch (CAD) calls-for-service on the Socrata SODA open-data API
— no key required. overcast's `dispatch` source reads that feed, tags every call
with GPS, and plots them on a map you can hand to an analyst.

Everything below is reproducible on any machine with overcast installed — there
are **no API keys** in this case.

## Run

```bash
# 1. a case is just a folder + its .overcast/ store
overcast case init --case showcase/sf-scanner

# 2. register the San Francisco CAD feed (a shipped preset; any Socrata city works
#    via dispatch:<domain>/<dataset>). No key — SOCRATA_APP_TOKEN only raises limits.
overcast source add "dispatch:sf" --case showcase/sf-scanner

# 3. validate the feed with a single scan — confirm rows parse and carry
#    gps / call-type / id columns (auto-detected per row)
overcast scan --source dispatch --limit 50 --case showcase/sf-scanner

# 4. open a line of investigation
overcast target add "Where are tonight's assault, battery, and suspicious-activity \
  calls clustering across SF districts?" --case showcase/sf-scanner

# 5. plot every geolocated call on one self-contained HTML map (live OSM tiles)
overcast map --since 24h --no-open --theme csi \
  --export showcase/sf-scanner/map.html --case showcase/sf-scanner

# 6. export the case brief (story-first: verdict, the line of investigation,
#    coverage, and the newest-first record trail)
overcast brief --theme csi \
  --export showcase/sf-scanner/brief.html --case showcase/sf-scanner
```

`monitor` turns the one-shot scan into a standing watch — the SF feed is a rolling
~48h real-time window, so it's a strong fit:

```bash
overcast monitor --once --case showcase/sf-scanner              # one diff pass
overcast monitor --source dispatch --every 15m --limit 20 --case showcase/sf-scanner
```

## Artifacts

- `map.html` — ~40+ live CAD calls plotted over San Francisco on OpenStreetMap
  tiles, each marker linking back to the source SODA row (PETTY THEFT, TRAF
  VIOLATION CITE, ASSAULT / BATTERY, WELL BEING CHECK, …). Fully self-contained.
- `brief.html` — the CSI-themed case brief.

Both are exported verbatim by the CLI. The only post-processing for hosting is a
scrub of the local case-directory path (see the site's `scripts/publish-case.mjs`).
