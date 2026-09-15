# Video Creator — pipeline memory (voice-first + frame-anchored sync)

> **Path note:** written pre-plugin, so `npm run …` and bare `platform/…` paths
> appear throughout. In plugin form those are `/produce` etc. and
> `${CLAUDE_PLUGIN_ROOT}/platform/…`. The sync mechanics and authoring patterns
> below are unchanged and remain the authoritative explanation.

Project-local memory for THIS workspace. Captures how the narrated-video sync
works and how to author features so any video comes out in sync. All the runtime
logic lives in `platform/` and applies to every feature via `npm run produce`.

## The pipeline (voice-first order)

`npm run produce -- <feature>` runs, in order:
**generate → TTS → record → mux (anchored) → verify.**
TTS runs BEFORE record on purpose — the recorder needs each shot's clip length to
pace it. Single stages are for debugging only; `produce` sequences them and
re-runs only what's stale. `npm run doctor -- <feature>` preflights first.

## How sync is made automatic (do NOT hand-tune timing)

The hard problem: the target app is a heavy SPA (DOM changes seconds before it
paints) AND Playwright's screencast is variable-frame-rate and lags real time
continuously — so wall-clock marks do NOT map to video frames, and consecutive
same-screen shots (form fields) look identical to screenshot matching. Neither
wall-clock nor screenshot-matching alone works.

Solution (all in `platform/`):
1. **`ShotTimer.markVisual`** (`engine/walkthrough.ts`): per shot, waits for the
   screen to paint (bounded networkidle + 2 rAF), saves an anchor screenshot,
   and paints a **scan marker** — a thin magenta bar at the very top — for ~450ms.
2. **`holdForNarration`**: the recorder dwells each shot for its clip length, so
   the action is followed by a hold sized to the voice.
3. **`build_narrated.py` mode `anchored`** (default): scans the recording for the
   magenta markers → each shot's TRUE video frame (unambiguous even for identical
   same-screen shots; immune to SPA/VFR drift). Falls back to screenshot-matching,
   then wall-clock, if markers aren't found. Then it **rebuilds** the video from
   those boundaries: **freeze-to-fit** (action shorter than voice → hold the frame,
   cursor waits until the voice ends) and **tail-cap** (action much longer than
   voice, e.g. slow login → trim dead time, ~2s cap). Audio is placed back-to-back
   with a small `--lead` (0.35s) → no gap, no overlap. The **marker strip is
   cropped** out, so it never shows in the final video.
4. **`verify_media.py`**: checks streams, audible narration, `narratedCoversNarration`
   (video holds all voice clips — NOT compared to the raw recording, which the
   rebuild intentionally trims), frame-timings trustworthy, and an optional
   committable per-shot aHash baseline (`--baseline write`, `frame-baseline.json`).

If sync still feels off, fix it in **feature.yaml**, never in the mux/clips.

## Authoring patterns (feature.yaml) — see walkthrough-produce skill "Authoring patterns"

- **One control per shot** (action + one-line narration); actually operate every
  important control, don't just describe it.
- **Icon buttons → `role*`** (substring), not `role` (antd folds the icon aria-label
  into the name, e.g. "plus Add New User").
- **Dropdowns/menus: open → HOLD open across the narration (`beat` ≈ clip length)
  → select at the end.** Opening+selecting immediately closes it before the voice
  describes the options.
- **Disabled/preset fields: `glide` + narrate, never `type`.**
- **Brisk `type` `delay: 25`** for logins/long fields (default 55ms); the tail-cap
  also trims slow typing/loads.
- **End a navigating shot with `assertVisible` on real content** so the next shot's
  anchor lands on the loaded screen (not a spinner).
- **Mutations: never actually submit.** `dataSafety: { mutates: true, stopBefore:
  "click:<Save>" }`; glide to the button, don't click. `generate-feature` enforces
  `stopBefore`.

## Recording environment (live vs local)

`project.yaml` supports named `environments` + a `defaultEnv`. Each env sets a
`baseUrl` and optional `start` command(s). Select per run with `--env <name>`
(record/produce/doctor) → sets `WT_ENV`, which `platform/engine/playwright.config.ts`
resolves (env baseUrl + webServer). `start` may be a LIST → Playwright starts
several servers together (e.g. a `local` env auto-starts backend + frontend from
`app-source/`, then records against the local URL). `live` = deployed URL, no
start. Change `defaultEnv` to switch the default any time; single-URL projects
just use top-level `baseUrl`/`start` (environments optional, back-compat). The
walkthrough-produce skill ASKS live-vs-local before producing when environments
exist. metrics-viewer: `live` (Azure URL) + `local` (Vite :5173 + dotnet :5000).

## TTS / setup gotchas (Windows)

- TTS stack (chatterbox-tts → torch/spacy/numpy) needs **Python 3.10–3.12** ONLY
  (not 3.13/3.14 — no wheels). `setup-tts.ps1`/`.sh` auto-select a supported
  version, recreate a wrong/pip-less venv, and bootstrap pip via ensurepip.
- `setup-tts.ps1` must stay **ASCII-only** (Windows PowerShell 5.1 reads scripts as
  CP1252; non-ASCII breaks parsing) and drive control flow off `$LASTEXITCODE`
  (not `$ErrorActionPreference='Stop'`, which turns native stderr into a fatal
  error).
- MP4 mux needs libx264+AAC ffmpeg; the venv's `imageio-ffmpeg` provides it
  (Playwright's bundled ffmpeg is VP8-only and is rejected).
- **Never run two setup/produce processes at once** — concurrent pip installs or
  recordings collide (WinError 32 / locked files).

## Reference: the metrics-viewer/add-user feature is the worked example

`walkthroughs/metrics-viewer/modules/users/features/add-user/feature.yaml` is the
reference for all the patterns above (login with brisk typing, one-control-per-shot,
Role dropdown open-hold-select, preset Client field glide, stopBefore Save).
