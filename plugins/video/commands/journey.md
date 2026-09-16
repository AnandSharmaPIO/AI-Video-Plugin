---
description: Stitch already-produced feature videos into one end-to-end tour (no re-recording)
argument-hint: <journey-path> [--produce-missing] [--env <name>]
allowed-tools: Bash, Read, Glob, AskUserQuestion
---

Build the journey at: `$ARGUMENTS`

A journey is a **compile spec**, not a recording. It reuses each segment
feature's `generated/final-video.mp4`, trims it via that feature's own
`shot-timings-narrated.json`, and concatenates at 1920×1080 / 30 fps.

## Before running

**Auto mode.** When the session's system reminders say **Auto Mode Active**,
the `--produce-missing` confirmation below is skipped — producing a segment is
a non-destructive recording, and each segment's own `/produce` pass still
gates any `dataSafety.mutates` action with an explicit ask regardless of mode.
Asking which journey to build (first bullet) is never skipped — there's no
reasonable default for which journey the user wants.

- If `$ARGUMENTS` is empty, list `*/journeys/*/journey.yaml` and ask
  which one to build.
- The build **refuses** to stitch a segment whose feature is not produced or is
  stale. Run `/catalog` first to see which segments are ready.
- `--produce-missing` produces those segments first. That performs real
  recordings — confirm with the user before adding it (skip the confirm under
  auto mode), and note that it passes `--allow-mutations` through only if you
  explicitly set that flag too — mutation opt-in is always confirmed, auto mode
  or not.

## Run

Run from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/journey.mjs" $ARGUMENTS
```

## After it finishes

The output is `<journey-path>/generated/journey.mp4`. The build asserts the
1920×1080 / 30 fps format itself, so a clean exit means the container is right —
but spot-check the seams between segments, especially where a later segment used
`fromShot:` to trim a repeated sign-in.

Media stays out of git; use `/publish` to move finals to shared storage.

Note the journey build shells out to the engine's own `catalog` and
`produce-feature` scripts; those resolve through the plugin automatically, so
there is nothing extra to pass.
