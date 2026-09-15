---
description: Run the full walkthrough pipeline for one feature (generate → TTS → record → mux → verify)
argument-hint: <feature-path> [--env live|local] [--headed] [--allow-mutations]
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion
---

Produce the narrated walkthrough video for: `$ARGUMENTS`

## Before running

**Auto mode.** When the session's system reminders say **Auto Mode Active**,
steps 1 and 4 below skip their AskUserQuestion and proceed with the stated
default. Step 3 never changes with mode — a mutating action always gets an
explicit human confirmation, since it changes real data in the target app.

1. **If `$ARGUMENTS` is empty**, run `/catalog` and ask which feature to
   produce. Under auto mode, still ask — there is no reasonable default for
   which feature the user wants.
2. **If the feature's `feature.yaml` is new or its shot list / narration changed
   since the last recording** (no `status.recordedAt`, or you just edited it),
   STOP and use the `walkthrough-produce` skill instead — it carries the
   click-action confirmation gate that must be cleared before anything is
   recorded. This command is the fast path for an already-confirmed feature.
3. **If the feature is marked `dataSafety.mutates: true`**, always re-confirm the
   mutating actions with the user (AskUserQuestion) before passing
   `--allow-mutations`, auto mode or not. Never add that flag on your own
   initiative.
4. **If the project defines `environments:` and no `--env` was given**, ask the
   user: live (deployed URL) or local (auto-starts the app before recording).
   Under auto mode, skip the ask and use `project.yaml`'s `defaultEnv`,
   reporting the choice.

## Run

Run from the **project root** (the directory containing `walkthroughs/`) — the
engine resolves the content catalog from the current working directory:

```
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/produce-feature.mjs" $ARGUMENTS
```

The pipeline runs in voice-first order — **TTS before record** — so the recorder
paces each shot to its narration length. Sync is automatic; never hand-tune
timing in the spec.

## After it finishes

Report the output path `<feature>/generated/walkthrough-narrated.mp4`, then
**verify by looking**: read the frames in `<feature>/generated/frames/verify/`
and confirm the cursor lands on target, results rendered, no error toasts, and
the full top bar is in frame. A passing exit code is not a good video.

If `verify` flagged `blankFrames`, read each flagged frame — that is an advisory,
not a failure, and it needs your judgment.
