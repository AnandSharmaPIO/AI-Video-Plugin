---
description: Inventory every walkthrough feature and show what is stale or missing
argument-hint: [--stale]
allowed-tools: Bash, Read
---

Show the walkthrough catalog for this project.

Run from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/catalog.mjs" $ARGUMENTS
```

Pass `--stale` to list only rows needing attention.

Each feature reports four columns. Staleness is **content-hash based**, not
mtime based, so it is accurate from a fresh clone:

- **spec** — `OK` | `MISSING` | `DESYNC` (feature.yaml changed since generation)
  | `EDITED` (the generated spec was hand-edited)
- **recording** — `OK` | `STALE` | `clone` (recorded elsewhere; media not present
  here but rebuildable and current) | `none`
- **narration** — `OK` | `STALE` (clips no longer match narration.md) | `none`
- **mp4** — `OK` | `STALE` (older than the recording or the clips) | `none`

Summarise what needs doing. The fix for `DESYNC` or `EDITED` is always to edit
`feature.yaml` and regenerate — never to edit the spec.
