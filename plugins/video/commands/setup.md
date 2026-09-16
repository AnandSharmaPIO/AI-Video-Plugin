---
description: One-time per-machine setup — install plugin dependencies, Playwright Chromium, and the TTS venv
allowed-tools: Bash, Read
---

Set up the walkthrough toolchain on this machine. Run once after installing the
plugin. Installing a plugin copies files; it does **not** install dependencies —
that is what this command is for.

Throughout, `$CLAUDE_PLUGIN_ROOT` is this plugin's directory.

## Step 1 — Node dependencies (into the plugin, not the user's project)

```
npm install --prefix "$CLAUDE_PLUGIN_ROOT"
```

Installs `@playwright/test`, `ajv`, `ajv-formats`, `yaml`.

## Step 2 — Playwright Chromium

```
npx --prefix "$CLAUDE_PLUGIN_ROOT" playwright install chromium
```

Browsers cache in the user profile, so this is shared across projects and
survives plugin updates.

## Step 3 — The TTS virtualenv

Requires **Python 3.10, 3.11, or 3.12**. The chatterbox-tts stack (torch, spacy,
numpy) ships no wheels for 3.13 or 3.14 and the build will fail.

```
# Windows PowerShell:
powershell -ExecutionPolicy Bypass -File "$CLAUDE_PLUGIN_ROOT/platform/tts/setup-tts.ps1"

# macOS / Linux / Git Bash:
bash "$CLAUDE_PLUGIN_ROOT/platform/tts/setup-tts.sh"
```

If the machine's default Python is out of range, pin one:
`... setup-tts.ps1 -Python "py -3.12"` or `... setup-tts.sh --python=python3.12`.

First run takes roughly 15–20 minutes because it downloads the voice model.
Model weights cache in the user profile, so later venv rebuilds are quick.

> **Optional but recommended: relocate the venv outside the plugin.** Both
> `setup-tts` and the engine's `venvPython()` honour `WALKTHROUGH_TTS_VENV`, so a
> plugin reinstall cannot then destroy a multi-GB build. Set it persistently
> *before* running step 3:
>
> ```
> # Windows: [Environment]::SetEnvironmentVariable('WALKTHROUGH_TTS_VENV',
> #   "$env:LOCALAPPDATA\video\tts-venv", 'User')
> # POSIX:   export WALKTHROUGH_TTS_VENV="$HOME/.cache/video/tts-venv"
> ```
>
> Left unset, the venv builds at `platform/tts/venv` inside this plugin, which
> works fine — it is just more fragile across reinstalls.

## Step 4 — Confirm

```
node "$CLAUDE_PLUGIN_ROOT/platform/scripts/doctor.mjs"
```

Every line must show a green check. Fix anything that does not, then re-run.
Do not proceed to `/init` until this is clean.

## Notes

- Never run two setup or produce processes at once — concurrent pip installs and
  recordings collide (locked files / WinError 32).
- No internet? Copy `~/.cache/huggingface` (Windows:
  `%USERPROFILE%\.cache\huggingface`) from a machine that already has the model.
