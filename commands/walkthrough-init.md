---
description: One-time per-project setup — prepare a project to hold a walkthrough content catalog
allowed-tools: Bash, Read, Write, Glob
---

Prepare the current project to produce walkthrough videos with this plugin.
Run once per project, after `/walkthrough-setup` has passed on this machine.

## How the two halves fit together

| | Lives in | Contains |
|---|---|---|
| **Engine** | the plugin | `platform/`, `node_modules/`, the TTS venv |
| **Content** | this project | `walkthroughs/`, `.env`, generated media |

The engine resolves the content catalog from the **current working directory**,
so every command must be run from the project root — the directory that contains
`walkthroughs/`. Set `WT_PROJECT_ROOT` to override that when invoking from
anywhere else.

A walkthrough project needs **no Node setup of its own** — no `package.json`, no
`node_modules`, no `tsconfig.json`. Every dependency lives in the plugin. The
project is pure content.

## Step 0 — Already set up?

If `walkthroughs/` already exists here and `/catalog` lists its features, this
project is ready. Say so and stop.

## Step 1 — Create the catalog root

```
mkdir walkthroughs
```

## Step 2 — Bring in the rules

Copy `${CLAUDE_PLUGIN_ROOT}/templates/project/CLAUDE.md` into the project root,
unless a `CLAUDE.md` already exists — **never overwrite one**. If the project
already has a CLAUDE.md, show the user the walkthrough rules and ask whether to
append them.

These are the six rules that keep the pipeline honest: edit `feature.yaml` not
the generated spec; never hardcode credentials; data safety is metadata; verify
by looking; prefer role/text/label locators; never commit media.

## Step 3 — Ignore generated artifacts

Append to `.gitignore` (create it if absent), skipping lines already present:

```
**/generated/
.env
*.webm
*.mp4
*.wav
```

## Step 4 — Verify

```
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/doctor.mjs"
node "${CLAUDE_PLUGIN_ROOT}/platform/scripts/catalog.mjs"
```

`doctor` must be all green. `catalog` will report "No features found under
walkthroughs/" on a brand-new project — that is correct, not an error.

## Step 5 — Next

- **New app, no catalog yet** → use the `walkthrough-discover` skill. It
  bootstraps `walkthroughs/<id>/project.yaml` and `.env.example` from the
  plugin's templates, maps the app into `knowledge/`, and drafts the first
  `feature.yaml` files.
- **Catalog already present** → `/catalog` to see what needs producing.

Tell the user to copy `walkthroughs/<id>/.env.example` to `.env` and fill in real
credentials. **Never write credential values yourself** — the YAML names the
environment variables, the `.env` file holds the values, and it is never
committed.

> `templates/project/package.json` and `tsconfig.json` are retained in the plugin
> as a record of the pre-plugin repo layout. They are **not** used by this
> command — a project needs neither.
