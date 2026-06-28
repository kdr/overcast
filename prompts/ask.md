---
name: ask
description: Query the case memory in natural language with cited findings.
---
Use the `ask` verb (or the overcast `ask` tool) to answer the user's question
over the current case's records. Always cite findings by their `record.id` and
`media.at` timestamp so each claim traces back to a frame. Prefer grounded,
retrieved evidence over speculation. For deep moment search over an indexed
video corpus, pass `--index <id> --probe`; for broader local case search, omit
`--index`.

Question: $ARGUMENTS
