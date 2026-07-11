---
name: overcast-connect-the-dots
description: >-
  String the board — build the case knowledge graph, read its hubs (shared media,
  targets, device fingerprints, places, typed entities), focus the neighborhood
  around a node, optionally run the opt-in LLM entity pass, and promote real
  connections into evidence via findings.
---

# overcast-connect-the-dots

Use this skill to "connect the dots": render the whole case as one relational graph
and find the links that tie records, people, devices, places, and entities
together. This is the **relational/entity** board; the visual crop corkboard is
`overcast-crime-board` (faces + object crops with red string). Use the broad
`overcast` skill and `overcast/reference/verbs.md` for exact flags.

## Workflow

1. Build the graph and read the hubs. `graph` emits ONE self-contained interactive
   HTML force-graph — records, shared-media hubs, targets, accepted/open findings,
   cluster people, device fingerprints, places, and regex-harvested typed entities
   (email / phone / @handle / url / domain / hashtag + exif serial + scan identity
   lifts) — with every edge carrying its provenance record id:

```bash
overcast doctor --json
overcast case init --json
overcast graph --no-open --json           # build; inspect the payload's nodes/edges/hubs
overcast graph --json                     # (also opens the viewer) hand-rolled canvas, no CDN/egress
```

2. Focus a node's 2-hop neighborhood — a target, a finding, a record id, a media
   ref, or an entity's text. The anchor is never trimmed; `--limit` drops
   lowest-degree leaf entities first, `--since` is capture-time-aware (an in-window
   finding pulls its out-of-window source record back in):

```bash
overcast graph --focus <target-id> --json          # everything around a line of investigation
overcast graph --focus "+15551234567" --json       # everything touching an entity value
overcast graph --since 7d --limit 250 --json        # recent, trimmed
```

3. (Optional) Run the opt-in LLM entity/relation pass. `--extract` sends evidence
   TEXT to your **brain LLM** (BYO, text-only), caches to
   `.overcast/graph/extract.jsonl` (delete the file to re-extract), and marks every
   result leads-not-proof (`payload.caveat`). It co-filters with `--since`:

```bash
overcast graph --extract --json                     # adds LLM-inferred entities/relations (cached)
overcast graph --extract --since 7d --focus <target-id> --json
```

4. Promote real connections into evidence. Graph edges and `--extract` output are
   NOT evidence on their own — a link you confirm becomes a finding stamped onto a
   line of investigation, which is what enters ask/brief:

```bash
overcast finding create "@handle in scan REC and phone in property REC resolve to the same person" --ref <record-id> --target <target-id> --confidence medium --json
overcast finding list --state triage --json         # if a match verb auto-suggested the link
overcast finding accept <id> --target <target-id> --json
overcast note "graph: <n> shared-media hubs; strongest cross-link = <a> to <b> via <record-id>" --tag tldr --json
overcast brief --export ./connect-the-dots.html --json
```

## Output

The graph HTML plus a written read of its structure: the shared-media hubs, the
target-to-evidence threads, device-fingerprint memberships, and the typed entities
that recur across records — each asserted connection cited to the edge's provenance
`record.id`, and each CONFIRMED connection promoted to a finding.

## Caveats

`graph` is operational — it (and `--extract` output) stays OUT of ask/brief
evidence; only findings you accept carry a link into the narrative. `--extract` is
a brain-LLM inference (BYO): treat its entities/relations as leads to verify against
the underlying records, never proof — every extracted item carries `payload.caveat`.
Regex-harvested entities over-match (a string that looks like a handle may not be
one); confirm before drawing the string. `--limit` trims leaves to keep the canvas
legible, so a very large case may hide low-degree entities — raise it or `--focus`.
