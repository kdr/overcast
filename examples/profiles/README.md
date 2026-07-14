# `examples/profiles/` — ready-made profile builder

`install-profiles.sh` binds a few overcast **profiles** in one shot so you can A/B
different backend combinations without wiring each verb by hand. A profile is just
a named set of provider bindings in your `$OVERCAST_HOME` (default `~/.overcast`);
switch with `--profile <name>` or `OVERCAST_PROFILE=<name>`.

## Run it

```bash
bash examples/profiles/install-profiles.sh [--home <dir>]
# then:
overcast see ./img.jpg --json --profile fal
overcast --profile recon            # or: OVERCAST_PROFILE=recon overcast
```

Needs the CLI built (`npm run build` — the script calls `node dist/bin/overcast.js`)
and, per profile, the relevant keys in `.env` or your shell: `CLOUDGLUE_API_KEY`,
`FAL_KEY`, `ELEVENLABS_API_KEY`, `HF_TOKEN`.

## Profiles it builds

| Profile | Bindings |
| --- | --- |
| `cloudglue` | Baseline defaults — `watch`/`listen` = tinycloud, `enhance` = ffmpeg, `see` = brain LLM |
| `fal` | `see` + `enhance` via fal.ai (esrgan image / deepfilternet3 audio) |
| `elevenlabs` | `listen` = Scribe STT, `enhance` = voice isolator (audio) |
| `hf` | `see` = gemma vision-LLM caption, `enhance` = the `python/enhance.py` demo (fal-routed HF upscale) |
| `recon` | Best-of-breed OSINT mix — `watch` = tinycloud, `listen` = elevenlabs, `see` = fal, `enhance` = fal |

## Note on paths

The script binds by absolute path against the **shipped** providers
(`providers/senses/*`) plus the one Python demo (`examples/providers/python/enhance.py`).
The shipped-provider binds **heal to portable `shipped:` refs on load**, so a
profile written here survives an install move (nvm switch, binary relocation); the
demo bind stays a literal `exec:` path. Doing the same setup with the catalog
(`overcast provider setup apply --verb … --choice … --yes`) writes the `shipped:`
refs directly — this script is the older, all-in-one convenience path.
