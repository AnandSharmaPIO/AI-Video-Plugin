---
description: Preflight the machine — Node, deps, browser, TTS venv, ffmpeg, and optionally a feature's credentials + app reachability
argument-hint: [<feature-path>] [--env <name>]
allowed-tools: Bash, Read
---

Preflight the walkthrough toolchain.

Run from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/doctor.mjs" $ARGUMENTS
```

With no arguments this checks the machine only: Node 18+, npm dependencies,
Playwright Chromium, the TTS venv (must be Python 3.10–3.12), and an
MP4-capable ffmpeg (libx264 + AAC).

Given a `<feature-path>` it additionally resolves that project's recording
environment and checks its credentials (`.env`) and whether its baseUrl is
reachable — the two failures most likely to burn a five-minute Playwright
timeout.

Every failing check prints its own fix. Relay the failures and the fixes; do not
attempt to produce a video until `doctor` is clean.

If the TTS venv is missing entirely, run `/setup` first.
