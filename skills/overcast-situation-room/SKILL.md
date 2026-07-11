---
name: overcast-situation-room
description: >-
  Stand up the live monitoring page over a case — pick and seed sources, have the
  operator serve the page in its own pane, then drive the running page (panels,
  interval, filters) through the control plane without ever opening the listener
  yourself.
---

# overcast-situation-room

Use this skill to "monitor the situation": put a live, self-updating multi-panel
page over a case — wall tiles, a reverse-chron scan/monitor feed, a live GPS map,
and refreshing webcam/browser stills — so an operator watches the case evolve in
real time. Use the broad `overcast` skill and `overcast/reference/verbs.md` for
exact flags.

> **Hard rule — opening the listener is an OPERATOR action.** The agent NEVER runs
> `overcast situation` / `serve` — starting a network listener is an operator act
> (invariant #10). A human runs `overcast situation` in its own terminal pane, or
> `/situation on` in the TUI (in-process, bound to the session). The agent only
> drives a page that is ALREADY running, via `situation status | set | stop`.

## Workflow

1. Pick and verify the sources the page will show. Panels are auto-picked from the
   configured sources, so decide what should be live first — GPS-bearing feeds
   (`dispatch`, `flights`, `firms`, `overpass`) feed the map; `webcam`/`browser`
   feed the stills panel; anything scanned/monitored feeds the feed + wall:

```bash
overcast doctor --sources --json          # which source creds resolve
overcast case init --json
overcast source list --json               # what's registered/enabled for this case
overcast source add "dispatch:sf" --json  # (example) add a rolling real-time feed
```

2. Seed the monitors so fresh records land on the page. Either run a standing
   monitor loop yourself (its own pane), or let the serving process own the cadence
   with `--every` at serve time — pick ONE, not both:

```bash
overcast monitor --once --json            # sanity pass: confirm sources resolve
overcast monitor --every 5m --limit 5 --json   # standing loop (own pane) — OR use situation --every below
```

3. **Operator step (not the agent):** a human starts the page in its own pane. It
   BLOCKS on that process. `--every` makes the serving process own the monitor
   cadence too, so a separate loop isn't needed:

```bash
overcast situation                        # operator only — serves 127.0.0.1:7374, opens the browser
overcast situation --every 5m --panels wall,feed,map,stills   # operator: page owns the monitor cadence
# in the TUI instead: /situation on
```

4. Drive the running page. `situation set` retunes panels / interval / filters
   cross-process through the `.overcast/situation/` control plane (consumed on the
   ~2s poll tick), `status` reports what's live, `stop` halts it:

```bash
overcast situation status --json                                    # panels + filters + liveness
overcast situation set --panels wall,map --source dispatch --since 12h --limit 16 --json
overcast situation set --clear source,since,limit --json            # drop filters back to auto
overcast situation stop --json                                      # stop via the control file
```

## Panels

- **wall** — case videos muted + looping at their evidence moments (`--limit` caps
  tiles).
- **feed** — reverse-chron scan/monitor hits as they land.
- **map** — every GPS-bearing record; `flights` build tracks over successive polls.
- **stills** — `webcam`/`browser` sources re-captured each refresh.

## Output

A running, token-authed page an operator watches, plus the `situation status`
record documenting which panels/filters are live and the serve URL. State the
cadence, which sources feed which panels, and that the operator (not the agent)
opened the listener.

## Caveats

Opening the listener is operator-only — the agent stays on `status`/`set`/`stop`
(the `/situation` slash + agent tool expose only those). The page binds
`127.0.0.1` by default; keep it off public interfaces. Local media streams over the
token-authed `/media` Range route (a page served over http:// can't load
`file://`); remote embeds are gated by `OVERCAST_REPORT_REMOTE_MEDIA`. Refresh is
poll-based (store fingerprint → SSE), not eventing — a `--poll` tune trades
freshness for load. The page is situational context, not evidence: `situation` is
out of ask/brief.
