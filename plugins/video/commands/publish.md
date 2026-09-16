---
description: Copy finished narrated MP4s out of gitignored generated/ to durable shared storage
argument-hint: <feature-path> --dest <dir>   (or --all --dest <dir>)
allowed-tools: Bash, Read
---

Publish finished walkthrough videos: `$ARGUMENTS`

Run from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/publish.mjs" $ARGUMENTS
```

Media is never committed to git, so without this step a deliverable exists only
on the machine that recorded it.

The destination resolves in this order: `--dest <dir>` → the `WT_PUBLISH_DIR`
environment variable → `project.yaml → publish.dest`. If none resolves, the
command exits with an error — ask the user where the videos should go rather
than inventing a path.

Layout at the destination:

```
<dest>/<project>/<module>/<feature>.mp4
<dest>/manifest.json     feature → { file, bytes, publishedAt, recordedAt, shots }
```

The manifest merge is idempotent per feature key, so re-publishing updates a row
rather than duplicating it. Features with no narrated MP4 are skipped and
reported — produce them first.
