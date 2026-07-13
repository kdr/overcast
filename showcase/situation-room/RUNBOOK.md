# Case: The Situation Room

**What it proves:** overcast can stand up a live, self-updating control-room page
over a case — "monitor the situation." The `situation` verb serves a
token-authenticated local dashboard: a map of every geolocated record, a
reverse-chronological feed of incoming hits, refreshing webcam/browser stills, and
a video wall — panels auto-picked from the case's configured sources, refreshing
themselves as new records land.

This case wires three **keyless / no-extra-cost** live San Francisco sources:
police CAD dispatch, live traffic-camera locations, and (when aircraft are
overhead) ADS-B flights.

> The page is **live** — it needs its local server running, so unlike the other
> case files it can't be hosted as a static page. The image on the card is a real
> snapshot of the running dashboard. Run the commands below to get the live one.

## Run

```bash
overcast case init --case showcase/situation-room

# wire live sources (dispatch + windy webcams are keyless / free-tier; flights is
# keyless OpenSky). Any of these alone is enough to drive a panel.
overcast source add "dispatch:sf"                              --case showcase/situation-room
overcast source add "webcam:37.7749,-122.4194,50"             --case showcase/situation-room
overcast source add "flights:-122.55,37.70,-122.35,37.83"     --case showcase/situation-room

# seed the case with one pass of each source
overcast scan --source dispatch --limit 25 --case showcase/situation-room
overcast scan --source webcam   --limit 6  --case showcase/situation-room
overcast scan --source flights  --limit 40 --case showcase/situation-room

# stand up the live page (blocking; runs in its own terminal). --every makes the
# serving process own the monitor cadence, so this one command IS "monitor the
# situation" — the dashboard refreshes itself as new calls/flights land.
overcast situation serve --case showcase/situation-room --panels map,feed,stills --every 5m
```

`situation set` retunes panels/filters on the fly and `situation stop` shuts it
down — both from another terminal (or the agent), applied within ~2s:

```bash
overcast situation set  --panels map,feed --case showcase/situation-room
overcast situation stop --case showcase/situation-room
```

## Artifact

`situation.png` — a snapshot of the running dashboard: 21 geolocated SF dispatch
calls on the map, a live feed interleaving traffic-camera locations and CAD calls
(SUSPICIOUS PERSON, CITIZEN STANDBY, PETTY THEFT…), a ticking clock and a LIVE
pulse. In the real page these update on their own.
