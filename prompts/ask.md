---
name: ask
description: Query the case memory in natural language with cited findings.
---
Use the `ask` verb (or the overcast `ask` tool) to answer the user's question
over the current case's records. Always cite findings by their `record.id` and
`media.at` timestamp so each claim traces back to a frame. Prefer grounded,
retrieved evidence over speculation. For deep semantic search over a video
collection, pass `--deep`.

Question: $ARGUMENTS
