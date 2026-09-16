---
description: One-time per-project setup — prepare a project to hold a walkthrough content catalog
allowed-tools: Bash, Read, Write, Glob
---

Prepare the current project to produce walkthrough videos with this plugin.
Run once per project, after `/setup` has passed on this machine.

## How the two halves fit together

| | Lives in | Contains |
|---|---|---|
| **Engine** | the plugin | `platform/`, `node_modules/`, the TTS venv |
| **Content** | this project | one folder per app at the repo root (`<app>/project.yaml`, `.env`), plus generated media |

The engine resolves the content catalog from the **current working
directory**: any immediate subdirectory that directly contains a
`project.yaml` is a project — there is no fixed wrapper folder to create.
Every command must be run from that content root. Set `WT_PROJECT_ROOT` to
override it when invoking from anywhere else.

A walkthrough project needs **no Node setup of its own** — no `package.json`, no
`node_modules`, no `tsconfig.json`. Every dependency lives in the plugin. The
project is pure content.

## Step 0 — Already set up?

If `/catalog` lists any features, this project is ready. Say so and stop.

If a `walkthroughs/` folder exists here instead (content authored under the
older layout, before projects moved to the content root), run:

```
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/migrate-output-structure.mjs"          # dry run
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/migrate-output-structure.mjs" --apply  # perform it
```

then re-run `/catalog` to confirm every feature is discovered under the new
layout, and `/produce --stale` to regenerate media as `final-video.mp4`.

## Step 1 — Bring in the rules

Copy `${CLAUDE_PLUGIN_ROOT}/templates/project/CLAUDE.md` into the project root,
unless a `CLAUDE.md` already exists — **never overwrite one**. If the project
already has a CLAUDE.md, show the user the walkthrough rules and ask whether to
append them.

These are the six rules that keep the pipeline honest: edit `feature.yaml` not
the generated spec; never hardcode credentials; data safety is metadata; verify
by looking; prefer role/text/label locators; never commit media.

## Step 2 — Ignore generated artifacts

Append to `.gitignore` (create it if absent), skipping lines already present:

```
**/generated/
.env
*.webm
*.mp4
*.wav
```

## Step 3 — Verify

```
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/doctor.mjs"
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/catalog.mjs"
```

`doctor` must be all green. `catalog` will report "No features found — no
project.yaml discovered under the current directory" on a brand-new project —
that is correct, not an error.

## Step 4 — Next

- **New app, no catalog yet** → use the `walkthrough-discover` skill. It
  bootstraps `<id>/project.yaml` and `.env.example` from the plugin's
  templates, maps the app into `<id>/project-overview/`, and drafts the first
  `feature.yaml` files.
- **Catalog already present** → `/catalog` to see what needs producing.

Tell the user to copy `<id>/.env.example` to `.env` and fill in real
credentials. **Never write credential values yourself** — the YAML names the
environment variables, the `.env` file holds the values, and it is never
committed.

> `templates/project/package.json` and `tsconfig.json` are retained in the plugin
> as a record of the pre-plugin repo layout. They are **not** used by this
> command — a project needs neither.
