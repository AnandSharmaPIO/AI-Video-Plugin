---
name: walkthrough-discover
description: Discover a web app's modules, features, pages, routes, and user journeys — from its source code and/or live exploration — and write the durable knowledge base (app-map.yaml, journeys.yaml, selectors.yaml) plus proposed module.yaml/feature.yaml drafts that walkthrough-produce turns into videos. Use when mapping a new app ("map the app", "discover modules/features", "build the app map", "what walkthroughs should exist"), adding modules to the catalog, or refreshing knowledge after app changes — including when the app's knowledge/ folder is empty or stale. To then produce a specific video, hand off to walkthrough-produce.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# Discover App Structure for Walkthroughs

Build the per-project knowledge base that makes every later walkthrough cheap.
Everything extracted is **user-facing**: modules, screens, routes, labels,
journeys, workflows.

## Paths — this skill runs from a plugin

The **engine** lives in the plugin; the **content** you produce lives in the
user's project. Run every command from the **project root** (the directory that
contains, or will contain, `walkthroughs/`).

`$ENGINE` below means `${CLAUDE_PLUGIN_ROOT}/platform`. **Define it once per shell
before using any snippet** (`ENGINE="$CLAUDE_PLUGIN_ROOT/platform"`, or PowerShell
`$ENGINE = "$env:CLAUDE_PLUGIN_ROOT\platform"`), or substitute the full path
literally — an undefined `$ENGINE` expands to empty and silently produces a wrong
path. A walkthrough project has
**no `package.json` and no `npm run` scripts** — use the slash commands
(`/catalog`, `/doctor`, `/produce`) or `node "$ENGINE/scripts/<script>.mjs"`. Any
bare `platform/...` path mentioned elsewhere in this document means `$ENGINE/...`.

## Inputs, in preference order

1. **Source code** at the paths in `walkthroughs/<p>/project.yaml → source`
   (frontend first: routers, navigation components, page components, on-screen
   labels/aria, conditional rendering, API call sites; backend only to confirm
   feature boundaries and workflows).
2. **Live app** when source is missing or ambiguous: run the crawler —
   `node "$ENGINE/scripts/discover-live.mjs" walkthroughs/<p> [--max-pages N]` —
   and reason over its output, `knowledge/discovery-raw.json` (per page: url,
   headings, buttons, tabs, placeholders, empty states, nav tree). Hand-drive
   Playwright only for what the crawler can't reach (multi-step flows, modal
   content, auth quirks), and never perform destructive/mutating actions while
   exploring — note them as dataSafety candidates instead.

Use parallel Explore agents for breadth (one per app area); keep only
conclusions, not file dumps.

## Outputs (all committed)

Into `walkthroughs/<p>/knowledge/`:
- `app-map.yaml` — modules → pages → routes → key elements (visible labels,
  accessible names), navigation paths between them.
- `journeys.yaml` — cross-module user journeys and business workflows
  (what a user accomplishes, step by step, in user language).
- `selectors.yaml` — proven locators + environment quirks (e.g. "auth redirect
  can take 60s", "repo list is an antd combobox"), updated whenever a
  recording session proves or disproves one.

**Auto mode.** When the session's system reminders say **Auto Mode Active**,
skip the AskUserQuestion confirmations below (they're proposing non-destructive
drafts, not performing any action against the target app) and proceed with the
reasonable default, noting the assumption in your report. The bootstrap facts
in "Gather the app facts" below are the exception — those are missing inputs
(project id, baseUrl, credentials env names) that can't be defaulted, so still
ask for whatever isn't inferable from `app-source/`.

Into the catalog (as **drafts for user confirmation**, via AskUserQuestion):
- `modules/<m>/module.yaml` for each discovered module (name, user-facing
  description, navigation, ordered feature list).
- `modules/<m>/features/<f>/feature.yaml` skeletons — shot list outline,
  draft narration, guards, honest `dataSafety` (anything that spends, creates,
  or unlocks gets `mutates: true` or a `stopBefore:`). Draft each control's click
  to the right DEPTH (view opens details, edit opens the edit page, delete clicks
  through to the confirmation dialog, …) but stop mutating steps AT the mutation
  boundary via `stopBefore` by DEFAULT — walkthrough-produce lists the whole click
  set for the user to confirm before recording and performs an opted-in mutation
  only then (with `--allow-mutations` + a `reset:` plan). Check each draft with
  `node "$ENGINE/scripts/generate-feature.mjs" <feature> --validate-only`.

- Optionally `journeys/<id>/journey.yaml` — a **compile spec** that stitches
  several (to-be-)produced features into one end-to-end tour (see
  walkthrough-produce "Journeys"). Draft it from the cross-module flows in
  `journeys.yaml`: an ordered `segments:` list of `<module>/<feature>` refs, with
  `fromShot` on later segments to skip their repeated sign-in. It reuses feature
  videos — it does not record.

Drafts land as files even if the user defers confirmation, so an interrupted
or unattended run still produces reviewable output.

## Bootstrap (when `walkthroughs/<p>/` doesn't exist yet)

A missing project folder is not an error — scaffold it first, then discover:

1. Gather the app facts, from `app-source/` first (project id, name, baseUrl,
   login path, auth presence, credential env names are usually derivable from
   the repo — package.json name, router/config files, `.env.example`); ask the
   user (AskUserQuestion) only for what's still missing. This step still asks
   under auto mode too, since a missing baseUrl/credentials name can't be
   guessed.
2. Create `walkthroughs/<id>/project.yaml` from
   `$ENGINE/templates/project.yaml.tmpl` (delete the `auth:` block for public
   apps; omit `channel:` unless Chrome is installed).
3. Create `walkthroughs/<id>/.env.example` from `$ENGINE/templates/.env.example`
   (committed) and tell the user to copy it to `.env` and fill in real
   credentials — never write credential values yourself.
4. Verify the scaffold: `/catalog` runs clean, and if
   auth exists, confirm `.env` is filled before any live exploration.

## Method

One ordering rule: **read `project.yaml` and the existing `knowledge/` before
writing anything** — extend, don't duplicate (bootstrap first if the project
folder is missing; `/catalog` shows what exists).

Write incrementally, not at the end: append each module to `app-map.yaml` as
its pages are enumerated, and each journey to `journeys.yaml` as it's traced —
the knowledge files are the working state, so an interrupted session loses
nothing. While mapping, apply what a capable pass would otherwise miss:

- Group modules by how the APP presents them (sidebar sections, nav menus),
  not by code structure.
- Per page, capture purpose, key interactions, and empty/loading/error states —
  those states become `guardExpr` guards in features.
- Trace 3–7 core journeys end to end (sign-in → outcome); they seed both
  journeys.yaml and the feature shot lists.
- **Derive the control inventory from the page's source, not from guessing.**
  For each page, open the actual page component / route in `walkthroughs/<p>/
  project.yaml → source` and read off the on-screen surface: headings, field
  labels, input placeholders, `aria-label`s, button/link text, tab names, table
  **columns**, list controls (**pagination, page-size selector**, sort/filter),
  **charts / stat cards**, **any content below the fold** (needs a `scroll` shot),
  validation/empty-state messages, and the nav path that reaches it. That
  enumerated list — recorded in `app-map.yaml` — is the coverage target for the
  feature's shots. **`app-source` is the source of truth for labels and
  locators**: use the exact on-screen text the component renders; never invent a
  control or a label the source doesn't contain, and when the live app and the
  source disagree, trust the source (the live build may be older). This does not
  weaken the rule that a feature.yaml is the source of truth for *its own
  walkthrough* — it means you author that feature.yaml to match what app-source
  actually shows.
- **Capture REAL example values while mapping.** For any control whose demo needs
  an input to produce a visible result — a search box, a filter, a form — note a
  real, valid value from the app (a name/email that actually appears in the list,
  a realistic new-record set) into `app-map.yaml`, so the feature.yaml uses real
  data, never placeholders like "test"/lorem. Get these from the live crawler
  output or seed/fixture data in the backend source, and never from real secrets.
- **One control per shot — complete coverage.** "Controls" is broad: not only
  buttons but the page's **headings, field labels, and textboxes/inputs** too —
  the elements a user reads and fills, not just the ones they click. Enumerate
  EVERY meaningful one from the inventory above and give each its OWN shot that
  visibly lands the cursor on it (`click`, `glide`, or `type`) and narrates that
  action — demonstrate the functionality, don't just describe it. Order shots the
  way a user's eye moves: **top-to-bottom, left-to-right** down the page. Prefer
  many small shots over a few dense ones: each shot = one action + its one-line
  narration, so the voice-first recorder can dwell on each action for exactly its
  voiceover. (This is deliberately verbose — a fuller, longer demo that covers
  everything, over a short one that skips controls; that tradeoff is intended.)
  **Draft a real CLICK for each control, not a point-at** (see walkthrough-produce
  "Click, don't just point"): the shot `click`s or `type`s the control and shows
  its result — search types the real example value and shows the filtered list, a
  form fills real values. Glide is only for a preset/disabled field or the gated
  final confirm of a destructive action. Aim to leave no meaningful control
  unvisited.
- **Propose a click DEPTH per control, and flag mutating ones for confirmation.**
  For each control, draft how far its click goes, by action type: **view/details**
  → open the read-only detail page; **edit** → open the edit page (no save);
  **add/create** → open the create page; **export** → click and show the export
  happening; **delete** → click to open the confirmation dialog, then `stopBefore`
  it; **search/filter/pagination** → click/type a real value and show the result.
  A navigate-away click shows the destination, then the draft returns (`goto` the
  list) to keep covering the page. Mark every destructive/persisting click
  (delete-through, save, submit-create) as `dataSafety.mutates` + `stopBefore` by
  DEFAULT — walkthrough-produce lists the whole click set for the user to confirm
  before recording, and performs an opted-in mutation only with `--allow-mutations`
  + a `reset:` plan.
- **Tables → one column per shot; lists → pagination shots.** Draft a table demo
  with a separate shot per column (cursor to that column + one narration line),
  not one dense shot — so every column is explained in sync with its voice. For a
  paginated list, draft shots that click Next / a page number and open the
  page-size selector (guarded, so a single-page list skips them); add a sort shot
  if a column sorts.
- **Long pages, charts, validation.** Draft a `scroll` shot to reveal each
  below-the-fold section (charts, stat cards, extra content) before its narration.
  Charts/stat cards are read-only — draft `glide` + narrate, not a click. Where a
  form has validation, draft a shot that triggers it (submit with a required field
  empty / an invalid value) and shows the message.
- **Bookend the feature.** Draft an intro shot that orients the page before
  interacting, and a closing recap shot on the final state.
- Draft interactions so they read well on video (see walkthrough-produce
  "Authoring patterns"): **dropdowns** = open → hold open across the narration →
  select at the end; **disabled/preset fields** = glide + narrate, never type;
  end a navigating shot with an `assertVisible` on real content so the next
  shot's anchor lands on the loaded screen; brisk `type` `delay` for logins.
- Locators for buttons/links that carry an ICON default to `role*` (substring),
  not `role` (exact): component libraries fold the icon's `aria-label` into the
  accessible name (antd: a "Export Excel" button with a file icon is named
  "file-excel Export Excel"; "plus Add New User"), so exact match silently hits
  zero. Reserve exact `role:` for genuinely text-only controls.
- Finish by proposing the module/feature drafts and confirming with the user
  which features to produce first — then hand off to `/walkthrough-produce`.
  **Under auto mode**, skip that confirmation: report the drafted modules/
  features and proceed to hand off the first (or all newly drafted) feature(s)
  to `/walkthrough-produce`, which carries its own gates for anything that
  actually records or mutates.

## Rules

- Business/user language everywhere; a PM should be able to read every file.
- Record facts once: anything you had to figure out twice belongs in
  `selectors.yaml`.
- Stamp `app-map.yaml` with the app version/date analyzed so staleness is
  detectable.
