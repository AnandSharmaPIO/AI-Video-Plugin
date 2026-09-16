# Video — Claude Code plugin

Generate narrated, **UI-focused** walkthrough videos (product demos, training,
onboarding) of any web app, driven by Playwright with a visible gliding cursor
and local TTS narration.

You write a YAML description of a feature. The plugin writes the test script,
records the browser, synthesises the voiceover, muxes them in sync, and verifies
the result. Nobody screen-records, nobody edits video, nobody records a voice.

Source code is only a lens for understanding features and user journeys —
**videos never explain implementation.**

---

## The split

| | Lives in | Contains |
|---|---|---|
| **Engine** | this plugin | `platform/` — cursor runtime, Playwright config, codegen, schemas, TTS toolkit. Generic; never edited per app. |
| **Content** | your project | `walkthroughs/<app>/` — `project.yaml`, `knowledge/`, `modules/<m>/features/<f>/feature.yaml`, and gitignored `generated/` media. |

One plugin install serves every app and every project.

---

## Install

```
/plugin marketplace add <this-repo-url>
/plugin install video@<marketplace-name>
```

Then, in order:

```
/setup      # once per machine — deps, Chromium, TTS venv
/init       # once per project — links the engine, scaffolds config
```

Requirements: **Node 18+**, **Python 3.10–3.12** (not 3.13/3.14 — no wheels for
the TTS stack), and an internet connection on first run to download the voice
model. You do not need to install ffmpeg or Chrome yourself.

---

## Commands

| Command | Does |
|---|---|
| `/setup` | Per-machine toolchain setup |
| `/init` | Per-project bridge + scaffold |
| `/doctor [<feature>] [--env <name>]` | Preflight machine, credentials, app reachability |
| `/catalog [--stale]` | Inventory every feature; show what is stale |
| `/produce <feature> [--env live\|local]` | Full pipeline for one feature |
| `/journey <journey-path>` | Stitch produced feature videos into one tour |
| `/publish <feature> --dest <dir>` | Copy finished MP4s to shared storage |
| `/research <target>` | Research an entire project/website/docs, or one module/file/feature/section — writes `research.md` |

## Skills

| Skill | Use when |
|---|---|
| `walkthrough-discover` | Mapping a new app — builds `knowledge/` (app map, journeys, proven selectors) and drafts `feature.yaml` files |
| `walkthrough-produce` | Authoring or producing a feature video; carries the click-action confirmation gate and the authoring patterns |

Use the skills for authoring; the commands are the fast path once a feature is
confirmed.

## Agents

| Agent | Used by |
|---|---|
| `research` | `/research` — investigates a codebase, live website, and/or documentation set (whole or one named part) via file/grep search and the Playwright MCP server, then writes a sourced `research.md` report. Read-only: never edits, fixes, or mutates anything it researches. |

---

## How a video is made

```
generate  →  TTS  →  record  →  mux (anchored)  →  verify
```

**TTS runs before record.** That is the whole trick: the recorder reads each
shot's clip length and dwells on that shot for exactly the voiceover's duration,
so the video is paced to the audio rather than the other way round.

Sync is then made frame-exact by a scan marker — the recorder paints a brief
magenta bar in a blank top gutter at each shot's true painted frame, and the mux
finds those markers in the recording, rebuilds the video from them (freezing a
short shot to fit its voice, trimming a long dead tail), and crops the gutter
away. This survives heavy SPAs and Playwright's variable-frame-rate screencast.

**Never hand-tune timing.** If sync feels off, the fix is always in
`feature.yaml`.

Every video is delivered at **1920×1080, 30 fps, H.264 + AAC**.

---

## Rules

1. **Edit `feature.yaml`, not `walkthrough.spec.ts`** — specs are generated
   output; regenerate after every change. The recorder refuses a hand-edited spec.
2. **Never hardcode credentials.** Environment variable *names* in YAML, values
   in gitignored `.env` files.
3. **Data safety is metadata.** Anything that mutates real data gets
   `dataSafety.mutates: true` + a `reset:` plan, or a `stopBefore:` rule — which
   the generator enforces at compile time.
4. **Verify by looking.** Read the extracted frames. A passing test is not a
   good video.
5. **Locators**: role / text / placeholder / label over CSS. Wait on content, not
   on fixed delays.
6. **Media is never committed** — it is regenerable. Publish finals instead.

---

## Repository layout

```
.claude-plugin/plugin.json   manifest
commands/                    8 slash commands
skills/                      walkthrough-discover, walkthrough-produce
agents/                      research (deep-research subagent used by /research)
platform/                    the engine (copied verbatim from the source repo)
  engine/                    cursor.ts, walkthrough.ts, env.mjs, playwright.config.ts
  scripts/                   produce, generate, record, journey, catalog, doctor, publish
  schemas/                   feature / project / module / journey JSON Schemas
  templates/                 project.yaml.tmpl, .env.example, spec + narration templates
  tts/                       generate.py, build_narrated.py, verify_media.py, build_journey.py
templates/project/           package.json, tsconfig.json, CLAUDE.md dropped into a project
docs/                        setup guides and pipeline notes
```
