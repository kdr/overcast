# Changelog

Notable changes to the Overcast VS Code extension. The extension version rides
the overcast release train — it matches the root `package.json` version stamped
by `scripts/sync-version.mjs`, so a given `.vsix` version pairs with the same
CLI version.

## 0.0.11

Initial preview release — first published to the VS Code Marketplace and Open
VSX as `kdrrr.overcast`.

- Right-click senses on any media file — Watch, Listen, See, Detect Faces,
  EXIF, Chronolocate, Enhance, Find Similar, Audio Fingerprint, Voice Match,
  View, Grid — plus multi-select **Analyze All Selected**.
- **Overcast** activity-bar view: case deck (intelligence-cycle actions),
  Sources & Monitors, Records, Investigation (with inline lead accept/dismiss),
  and Runs trees.
- Evidence artifacts as editor tabs: Map, Graph, Wall, Brief, and the live
  Situation panel.
- `@overcast` chat participant (`/ask /scan /status /brief /capture /sense
  /note`) and six `#overcast*` language-model tools for agent mode, each behind
  a confirmation dialog showing the exact CLI command.
