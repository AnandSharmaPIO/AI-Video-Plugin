# Video Creator — Walkthrough Video Platform

Generic, project-agnostic platform that generates narrated, **UI-focused**
walkthrough videos (product demos, training, onboarding) of any web app via
Playwright + local TTS. Point it at an app (source in `app-source/`, catalog in
`walkthroughs/<id>/`) and it produces the videos. Source code is only a lens
to understand features and user journeys — **videos never explain implementation**
(no classes, methods, patterns, or internals; only what users see and do).

## Map

- `platform/` — shared engine. `engine/` (cursor, walkthrough runtime, the one
  Playwright config), `tts/` (`--dir`-parameterized), `schemas/` (YAML contracts),
  `scripts/` (record-feature, generate-feature, catalog), `templates/`.
  **Generic — never edit per feature** (a hook will challenge you).
- `walkthroughs/<id>/` — content catalog: `project.yaml`, `knowledge/` (app map,
  discovered by `/walkthrough-discover`), `modules/<m>/module.yaml`,
  `modules/<m>/features/<f>/` = `feature.yaml` (**source of truth**) +
  generated `walkthrough.spec.ts` + `narration.md`; media in gitignored `generated/`.
  `journeys/<id>/journey.yaml` = a compile spec that stitches several produced
  feature videos into one end-to-end tour (`npm run journey`).
- `app-source/` — target app source (any stack). Read-only reference for
  discovery.

The TTS venv lives at `platform/tts/venv` (gitignored). Rebuild anytime:
`bash platform/tts/setup-tts.sh` (cross-platform; model weights cache in the
user profile, so rebuilds don't re-download them).

## Commands

```bash
npm run produce -- <feature-path> [--env live|local]         # FULL pipeline (use this)
npm run journey -- <journey-path> [--produce-missing --env <name>]  # stitch produced feature videos into one end-to-end tour
npm run doctor  -- <feature-path> [--env <name>]             # preflight: toolchain + creds + env reachable
node platform/scripts/catalog.mjs [--stale]                  # inventory + staleness
npm run publish -- <feature-path> --dest <dir>               # copy finished MP4s to shared storage
```

**Recording environment**: `--env <name>` selects a target from the project's
`project.yaml → environments` (e.g. `live` = deployed URL, `local` = auto-starts
the app's frontend + backend from `app-source/` via Playwright before recording).
Default is `project.yaml → defaultEnv`; change it any time, or override per run
with `--env`. Omit environments entirely for single-URL projects (top-level
`baseUrl`/`start`).

`produce` runs the stages **in this order — TTS BEFORE record** (voice-first: the
recorder paces each shot to its narration length, so audio and video stay in
sync). Run a single stage only to debug:

```bash
node platform/scripts/generate-feature.mjs <feature-path>          # feature.yaml -> spec + narration
<venv-python> platform/tts/generate.py       --dir <feature-path>  # narration -> clips (hash-cached)
npm run record -- <feature-path>                                   # record (refuses mutates w/o --allow-mutations)
<venv-python> platform/tts/build_narrated.py --dir <feature-path>  # -> narrated MP4 (frame-anchored, default)
<venv-python> platform/tts/verify_media.py   --dir <feature-path>  # probe streams + per-shot frames
```

Sync is automatic: the recorder paints per-shot scan markers + anchor
screenshots (`ShotTimer.markVisual`), and `build_narrated.py` (mode `anchored`)
finds each shot's real frame and rebuilds the video so the voice lands on the
action — no manual timing. **Never hand-tune timing in the spec**; it's generated.

`<feature-path>` = `walkthroughs/<p>/modules/<m>/features/<f>`.
`<venv-python>` = `platform/tts/venv/Scripts/python.exe` (Windows) or
`platform/tts/venv/bin/python` (POSIX).

## Rules

1. **Edit `feature.yaml`, not `walkthrough.spec.ts`** — specs are generated;
   regenerate after every yaml change (catalog flags DESYNC).
2. **Never hardcode credentials** anywhere — env names in yaml
   (`auth.credentialsEnv`), values in gitignored `.env` files (a hook blocks
   violations).
3. **Data safety is metadata**: shots that would mutate real data get
   `dataSafety.mutates: true` (+ `reset:` plan) or a `stopBefore:` rule.
4. **Verify by looking**: after recording, extract frames and read them; after
   muxing, probe streams + volume. A passing test ≠ a good video.
5. Locators: role/text/placeholder/label over CSS; waits on network/DOM for
   correctness, `beat()` only for pacing; guard data-dependent shots.
6. Media (`*.webm/mp4/wav`, `generated/`) is never committed — regenerable.

## Skills

- `/walkthrough-discover` — analyze `app-source/` + live app → `knowledge/`,
  propose modules/features, draft feature.yaml.
- `/walkthrough-produce` — feature.yaml → generate → record → narrate → verify.

Windows notes (ffmpeg paths, venv): `README.md`.
