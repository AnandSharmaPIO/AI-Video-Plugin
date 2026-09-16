---
name: walkthrough-produce
description: Produce one feature's narrated walkthrough video from its feature.yaml — generate spec + narration, record with Playwright, synthesize hash-cached TTS audio, mux, and verify by inspecting frames and streams. Use when the user asks to produce, record, re-record, or refresh a walkthrough/demo video for a feature that lives (or should live) in <p>/modules/<m>/features/<f>. Also builds JOURNEYS — compiling several already-produced feature videos into one end-to-end product walkthrough (/journey; <p>/journeys/<id>/journey.yaml) — use when the user asks for a full-app / end-to-end / compilation / stitched walkthrough. For discovering NEW modules/features or building the app map, use walkthrough-discover first.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

# Produce a Feature Walkthrough

Turn one `feature.yaml` into a verified, narrated MP4. The yaml is the source
of truth; the spec and narration are build artifacts. `<feature>` below means
`<p>/modules/<m>/features/<f>`.

## Paths — this skill runs from a plugin

The **engine** lives in the plugin; the **content** lives in the user's project.
Run every command from the **content root** (the directory you invoke
commands from; `WT_PROJECT_ROOT` overrides it) — the engine resolves the
catalog from the current working directory. A project is any immediate
subdirectory of the content root that directly contains a `project.yaml`;
there is no fixed wrapper folder.

| Shorthand below | Resolves to |
|---|---|
| `$ENGINE` | `${CLAUDE_PLUGIN_ROOT}/platform` |
| `<venv-python>` | `$ENGINE/tts/venv/Scripts/python.exe` (Windows) or `$ENGINE/tts/venv/bin/python` (POSIX) — or `$WALKTHROUGH_TTS_VENV` if set |

**Define `$ENGINE` once per shell before using any snippet below**, or substitute
the full path literally — an undefined `$ENGINE` expands to empty and silently
produces a wrong path:

```bash
ENGINE="$CLAUDE_PLUGIN_ROOT/platform"                  # bash / zsh
$ENGINE = "$env:CLAUDE_PLUGIN_ROOT\platform"           # PowerShell
```

A walkthrough project has **no `package.json` and no `npm run` scripts**. Prefer
the slash commands — `/produce`, `/doctor`, `/catalog`, `/journey`, `/publish` —
which resolve the plugin path for you. Any bare `platform/...` path mentioned
elsewhere in this document means `$ENGINE/...`.

## Auto mode

When the session's system reminders say **Auto Mode Active**, skip every
AskUserQuestion gate below that is marked **non-destructive** — make the
reasonable default call and proceed, stating the assumption in your report
instead of stopping to ask. Gates marked **always confirms** are never
skipped under auto mode: they gate an action that mutates or persists real
data in the target app, which is hard to reverse and out of scope for
auto-mode's "proceed without asking" bias.

## Fast path — one command

```bash
/produce <feature>                    # generate → TTS → record → mux → verify
# or directly:
node "$ENGINE/scripts/produce-feature.mjs" <feature>
```
This runs the whole pipeline in the **voice-first order (TTS BEFORE record)** and
uses frame-anchored muxing by default, so **audio/video sync is automatic** — you
do not hand-tune timing. Add `--headed` to watch, `--allow-mutations` for a
feature marked `dataSafety.mutates`, `--from <stage>`/`--to <stage>` to run a
slice, `--all`/`--stale` to batch. `/doctor <feature>` preflights the
toolchain + credentials + app reachability first.

Use the numbered stages below only to **author or debug** a feature; `produce`
already sequences them correctly (and re-runs only what's stale).

**Environment — ASK live vs local first (non-destructive).** If the
project.yaml defines `environments` and the user hasn't said which, ask
(AskUserQuestion): **Live** (the deployed URL) or **Local** (auto-starts the
app's frontend + backend from `app-source/` before recording). **Under auto
mode**, skip the ask and use `project.yaml`'s `defaultEnv`, noting the choice
in your report. Pass it through:
`/produce <feature> --env local`. The environments and the default live
in `project.yaml` (`environments:` + `defaultEnv:`) — change `defaultEnv` to
switch the default any time, or override per run with `--env`. Preflight the
chosen target with `/doctor <feature> --env <name>` (it confirms the
baseUrl and, for local, that servers will auto-start). Nothing to start by hand —
Playwright boots the environment's `start` command(s) and tears them down after.

## Workflow

**Enter at the earliest stale stage.** All pipeline state is durable on disk:
`/catalog --stale` shows what's out of date. Note the
order: **TTS (step 3) runs BEFORE record (step 4)** so the recorder can pace each
shot to its narration length and the mux can anchor the voice to the action.

### 1. Locate or create the feature
Existing feature: confirm `<feature>/feature.yaml` exists (see the catalog for
the inventory). New feature: create the folder + `feature.yaml` — shot list
with `narration` per shot, interactions as structured `steps` (locator
mini-language documented in `platform/schemas/feature.schema.json`) or
verbatim `custom` TS blocks, `guardExpr` for data-dependent shots, honest
`dataSafety`. Use `*/project-overview/` (routes, proven selectors, quirks)
before exploring from scratch; a starter spec template lives at
`platform/templates/walkthrough.spec.ts.tmpl`.

**Confirm new or changed shot lists + narration copy with the user
(AskUserQuestion) before recording — non-destructive.** A re-record of an
unchanged, previously confirmed feature.yaml (a prior `status.recordedAt`
exists) may proceed without re-asking — except when `dataSafety.mutates` is
true, which always confirms (see below). **Under auto mode**, also skip
re-asking for a new/changed shot list as long as no shot is
`dataSafety.mutates`: proceed with the authored list and report it in the
summary instead of gating on it.

**Click-action confirmation gate (REQUIRED).** The video CLICKS controls to show
what they do (see "Click, don't just point" in Authoring), so before recording you
MUST list **every control the recording will click**, stating for each: the
control, what clicking it does, **how far the demo goes** (e.g. "opens the edit
page — no save", "opens the delete confirmation — does NOT delete"), and any real
values typed. This list is always produced. What differs is whether it's also
posed as an AskUserQuestion:
- **Non-mutating clicks (view/edit/add/export/search/filter/pagination, and a
  destructive click that stops at `stopBefore` without crossing it)** — confirm
  with the user (AskUserQuestion) normally; **under auto mode, skip the ask**
  and proceed with the listed clicks, printing the list in your report instead.
- **Destructive / mutating clicks that actually cross the boundary** —
  delete-through, save, submit-create — **always confirm with the user
  (AskUserQuestion), auto mode or not.** They default to NOT performed and run
  only on explicit opt-in, then with `--allow-mutations` + a `reset:` plan. A
  re-record of an unchanged, previously confirmed feature.yaml may skip
  re-asking for everything EXCEPT any mutating click, which always re-confirms
  regardless of mode.

### 2. Generate the artifacts
```bash
node "$ENGINE/scripts/generate-feature.mjs" <feature>
```
The generator fully validates feature.yaml against the schema and regenerates
the spec + narration from it; after any yaml change, this is the only step
between you and re-recording.

### 3. Prepare demo state (if needed)
If a shot mutates data, arrange a **reversible** clean state using the app's
own tooling, set `dataSafety.mutates: true` + `reset:` in feature.yaml, and
tell the user what changed. The recorder refuses mutating features without
`--allow-mutations`.

### 3b. Narration audio — BEFORE recording (voice-first)
```bash
<venv-python> "$ENGINE/tts/generate.py" --dir <feature>   # hash-cached: only changed lines re-synthesize
```
Generate the clips first so the recorder can dwell on each shot for exactly its
narration length. Without clips, recording still works but falls back to fixed
`holdMs` pacing (a warning prints) and sync will be loose.

### 4. Record
```bash
node "$ENGINE/scripts/record-feature.mjs" <feature>   # add --headed to watch locally
```
The recorder refuses a stale spec (regenerate first) and, on success, stamps
`status.recordedAt`/`specHash` into feature.yaml itself. On failure, fix
locators in feature.yaml (prefer role/text/placeholder/label), regenerate,
re-record — and append any locator that had to be fixed, plus any environment
quirk discovered, to `<p>/project-overview/selectors.yaml` so the next
feature doesn't re-derive it.

### 5. Verify the recording — by looking, not by exit code
```bash
<venv-python> "$ENGINE/tts/verify_media.py" --dir <feature>
```
extracts one frame per shot into `generated/frames/verify/` and probes the
streams. **Read the frames** (cursor on target, results rendered, no error
toasts) — that judgment is the point of this step. Iterate until each shot is
clean.

**Mechanical checks now include** resolution (must equal the delivered
1920×1080), constant **30 fps** (`narratedFps30`/`narratedResolutionOk` — a video
built before the 30fps change fails until re-muxed), plus the existing stream /
audible / coverage-of-narration / baseline checks. **`blankFrames` is a loud
advisory** (not a hard fail): it lists shots whose RESTING frame is near-uniform —
a lazy-load flash or an unsettled async page. **Read every flagged frame**: if a
shot truly rests on a blank/spinner, fix feature.yaml (end the shot on settled
content — `assertVisible` a real element — so the freeze lands on the rendered
screen). Sparse-by-design pages (a centered login, a still-loading dashboard) are
legitimate — that's why it advises rather than blocks. Note too that
`generate-feature` prints **narration + coverage lints** (implementation-jargon /
over-long narration; controls in `app-map.yaml` not referenced by any shot) — act
on those before recording.

**Framing — the full top bar must be in frame, nothing clipped.** Check the
frames' top edge: the app's header row (logo, page title, account menu, and any
top-right action buttons) must be fully visible, not cut off. The engine captures
a small top gutter and the mux crops exactly that gutter (see
`platform/engine/env.mjs` `FRAME_GUTTER`), so a correctly-recorded frame shows the
whole top bar. If the top looks clipped, do NOT hand-tune the mux — the recording
predates the framing fix (re-record) or the app renders a taller-than-viewport
fixed header (raise `FRAME_GUTTER`). Also confirm the bottom controls a list
feature needs (pagination, page-size) are in frame.

**Coverage gate — did the video actually operate the whole feature?** Cross-check
the recorded shots against the control inventory `walkthrough-discover` derived
from the page's source (`app-map.yaml`, grounded in `project.yaml → source`). Walk
the inventory — headings, labels, textboxes, buttons, tabs, row actions — and
confirm each meaningful control has a shot where the cursor visibly lands on it.
If any enumerated control is unvisited (or its on-screen label doesn't match what
the source renders), the fix is in **feature.yaml**: add the missing shots (one
control each, in top-to-bottom/left-to-right order), correct the label to match
app-source, regenerate, and re-produce. A recording that merely passes is not
done until it covers the feature.

**Frame timing — a shot's verify frame is sampled ~0.8s after the shot's
`mark`, not at its end.** So a shot whose first action is a navigation/click
that triggers a load will be captured mid-spinner. Do the navigation + the
wait-for-content (`assertVisible` a real content element) at the **end of the
previous shot**, so the next shot opens on already-loaded content. Wait on
content, never a fixed `beat`, for correctness. Gotchas proven here: antd tables
render a hidden measure row (so `.ant-table-row:first-child` misses — use
`css=.ant-table-row >> nth=0`), and antd duplicates header cells (so a header
`getByText` hits a strict-mode violation).

### 6. Mux the narration onto the video
```bash
<venv-python> "$ENGINE/tts/build_narrated.py" --dir <feature>  # default mode: anchored
<venv-python> "$ENGINE/tts/verify_media.py"   --dir <feature>  # checks.ok: streams, coverage, audible, baseline
```
(TTS from step 3 already produced the clips.) Venv python:
`$ENGINE/tts/venv/Scripts/python.exe` (Windows) or `.../bin/python` (POSIX);
missing venv → run `/setup`.

**Sync is automatic — do NOT hand-tune it.** The recorder tagged each shot with
a scan marker + anchor screenshot (`markVisual`); `anchored` mode finds each
shot's true frame in the recording (immune to SPA render-lag and the
screencast's variable frame rate, and unambiguous even when consecutive shots
share the same screen), rebuilds the video from those boundaries, and **freezes
each shot's frame to fit its narration** (cursor waits at its point until the
voice ends) while **trimming excess dead time** (slow loads/typing, capped at
~2s) — so the voice lands on the action with no gap and no overlap. The muxer
prints each shot's placement (`same screen`/`anchor -> video`, `froze`/`trimmed`)
so you can see what happened. Other modes exist for fallback only: `extend`
(wall-clock marks, pre-marker recordings), `exact`, `sequential`.

If sync still feels off for a shot, the fix is in **feature.yaml**, never in the
mux/clips: make the shot end on settled content (`assertVisible` a real element),
split a shot that does two things, or adjust the narration length. A transient
UI (an open dropdown) must be **held open across its narration** — see Authoring.

**After ANY re-record, re-mux before trusting frames.** `verify_media` samples
the narrated MP4 on its own (`shot-timings-narrated.json`) timeline; verifying a
mux built from an earlier recording samples a fresh webm at stale timestamps
(`timingsMismatch` → `checks.ok` false). If you see it, re-mux — don't re-debug
the recording.

### 7. Close out
`status.recordedAt`/`specHash` were stamped at recording time; add
`status.appVersion` if you know it. **Required: record every locator you had to
fix and every environment quirk you hit to `project-overview/selectors.yaml`** before
closing out — this is what stops the next feature from re-deriving the same
locators (a fix figured out twice belongs there). Run
`/catalog` to confirm nothing is flagged, and report
the output path `<feature>/generated/final-video.mp4` to the user.
Media stays out of git — publish finals to shared storage (`/publish`).

## Journeys — stitch features into one end-to-end tour

A **journey** compiles several already-produced feature videos into a single
walkthrough (sign-in → … → sign-out) WITHOUT re-recording — it reuses each
feature's `generated/final-video.mp4`, so a feature video and the journey
stay in sync from one source. Author
`<p>/journeys/<id>/journey.yaml` (schema:
`platform/schemas/journey.schema.json`) — an ordered `segments:` list of
`<module>/<feature>` refs (any module — a journey is the whole-app tour). Because
every feature video opens with sign-in, keep the **first** segment full and give
later segments `fromShot: <n>` to trim their repeated login/entry (frame-accurate
off each feature's `shot-timings-narrated.json`; `toShot` trims the tail).

```bash
/journey <p>/journeys/<id>                       # reuse finished MP4s
/journey <p>/journeys/<id> --produce-missing --env <e>   # produce stale/missing segments first
```

The build refuses to stitch a segment whose feature isn't produced/fresh (per the
catalog) unless `--produce-missing`, trims each to its window, concatenates to
`journeys/<id>/generated/journey.mp4` at **1920×1080 / 30fps**, and asserts that
format. It records nothing itself — each feature is produced under its OWN rules
first (the click/mutation confirmation gates apply there, not to the stitch;
`--produce-missing` passes `--allow-mutations` through only if you set it). Media
stays gitignored — publish the final journey to shared storage.

## Authoring patterns (feature.yaml)

Sync + coverage come from how the shots are authored, not from tuning the mux:

- **app-source is the source of truth for labels + locators.** Take every
  on-screen string (heading, field label, placeholder, button/tab text,
  `aria-label`) from the actual page component in `project.yaml → source`, not
  from memory or the live DOM alone. If a `feature.yaml` label disagrees with the
  source, fix the yaml to match the source — never guess a label or invent a
  control that isn't there. (This strengthens, not contradicts, "feature.yaml is
  the source of truth for the walkthrough": the yaml is authoritative for the
  demo, and you keep it faithful to what app-source renders.)
- **One control per shot — and "control" includes what users read + fill.** Each
  shot = one action (click/glide/type) + its own one-line narration. Cover not
  just buttons but the page's **headings, labels, and textboxes** too, ordered the
  way the eye moves (**top-to-bottom, left-to-right**). Actually operate every
  important control so the video *shows* the feature, not just describes it. Many
  small shots beat a few dense ones — the recorder dwells on each action for
  exactly its voice. This runs longer than a highlight reel on purpose;
  completeness is the goal (the coverage gate in step 5 checks it).
- **Frame each page: intro shot + closing recap.** Open a page with a brief
  orientation shot (what this page is for) before interacting with it, and end the
  feature with a short recap shot on the final/landing state naming what was shown.
  These bookends make the walkthrough read as a guided tour, not a click sequence.
- **Click, don't just point (hard rule).** Every meaningful control is exercised
  with a real `click` (or `type`) event and its RESULT is shown on camera — a
  cursor resting on a button does not show what the button does, so glide/hover
  alone is NOT enough. Reserve `glide` only for a control you are deliberately not
  activating (a preset/disabled field, or the final confirm of a gated destructive
  action). Every click you intend to perform is confirmed at the step-1 gate first.
- **Click depth per action type — go as far as is safe, no further.** Choose how
  far each click goes by what the control does; these are illustrations of the
  pattern — map them to whatever the page actually has:
    - **View / details** → click it; show the read-only detail page that opens.
    - **Edit** → click it; show the edit page opening. Do NOT save/submit.
    - **Add / Create** → click it; show the create/registration page.
    - **Export / download** → click it (a real click event); show the export
      happening (button spinner / toast / file), not just the cursor on it.
    - **Search / filter / pagination / page-size** → click or type a real value and
      show the changed result.
    - **Delete / remove (destructive)** → click it to reveal the confirmation
      dialog, then STOP (`dataSafety.mutates` + `stopBefore` the confirm). Click
      the confirm to show the row removed ONLY if the user opted in at the gate
      (`--allow-mutations` + `reset:`).
  A click that navigates away (view / edit / add) shows the destination, then the
  demo returns — `goto` the list route or click a back/breadcrumb control — so the
  rest of the page's controls still get covered.
- **Real values, never placeholders.** Every typed value — search terms, form
  fields — is a real, valid value drawn from the app / app-source, distinctive
  enough to produce a visible result (a value that is a substring of a common term,
  e.g. part of the email domain, matches everything and won't narrow), never
  "anything" / lorem / "test test".
- **Tables/lists: one column per shot, cursor synced to its voice.** When
  explaining a table, give EACH column its own shot — glide to that column (its
  header or a cell) with its own one-line narration — so every column is explained
  and the cursor lands with that column's audio (voice-first: one column = one
  shot = one clip). Never cram all columns into one dense shot.
- **Pagination is part of a list demo.** A list/table feature must exercise
  pagination when the data spans pages: `click` Next (or a page number) and show
  the new page, and open the page-size selector and show the size change. Guard
  these (`guardExpr` on the pager control) so a short, single-page list skips them
  cleanly rather than failing.
- **Sorting & other grid controls.** If a column sorts, `click` its header and
  show the reorder; likewise column filters. Same click-and-show-result rule as
  search/pagination.
- **Reveal long pages with `scroll`.** When a page's content runs below the fold
  (stacked cards, charts, a long form), use the `scroll: <locator>` step to glide
  the next section into view slowly before narrating it — don't leave off-screen
  content undemonstrated, and don't jump-cut. It scrolls smoothly to center the
  target; the cursor stays visible (it's fixed-position).
- **Charts & read-only displays.** A chart/stat card isn't clickable — `glide` to
  it (or `scroll` it into view) and narrate what it shows and why it matters.
  Reserve clicks for actionable controls; use glide/scroll for things users read.
- **Validation messages: trigger, then show.** To demonstrate form validation,
  perform the action that surfaces it (e.g. `click` Save with a required field
  empty, or fill an invalid value and blur) and `assertVisible` the message — a
  real, on-screen validation state, not just narration that it exists. This is a
  non-mutating demo (the submit is rejected), so it needs no mutation opt-in.
- **Icon buttons → `role*` (substring), not `role`.** Component libraries fold
  the icon's aria-label into the accessible name (antd: "plus Add New User"), so
  exact match silently misses. Icon-only row actions expose a `title` — target
  `css=button[title="Edit"]`.
- **Every `click`/`assertVisible` locator must resolve to exactly ONE element**
  (Playwright runs in strict mode — 2+ matches throws). A per-row control repeats
  (one `button[title="Edit"]` per user), so scope it: `css=button[title="Edit"]
  >> nth=0`. Never `assertVisible` a label that appears in every group (e.g.
  "Select All", "View") — assert a unique one (a specific permission, a heading,
  or the step's Save button).
- **Gated / async content:** a tab whose panel loads on demand (e.g. a
  permissions list) needs the precise control (`role:button:Permissions`, not a
  loose `text:`) and a longer settle wait (`assertVisible { locator, timeout:
  15000 }`) before the next shot interacts with it.
- **Dropdowns/menus: open, HOLD open across the narration, then select.** e.g.
  `click: "css=.ant-select-selector"` → `beat: <~clip length>` → `click:
  "css=.ant-select-item-option[title=\"…\"]"`. If you open and select
  immediately, the menu closes before the voice describes the options. **On a page
  with MORE THAN ONE Select, scope the option click to the OPEN dropdown** —
  `css=.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option…`
  — because antd leaves *closed* dropdown portals in the DOM (hidden), so a bare
  `.ant-select-item-option` matches a stale, invisible option from a
  previously-opened Select and the click hangs on "element not visible".
- **Disabled / preset fields: `glide` to them, don't `type`.** Narrate that
  they're preset; typing into a disabled input does nothing and looks broken.
- **Type briskly for dull typing** (logins, long fields): `type: { …, delay: 25 }`
  (default is 55ms/char). The mux also caps trailing dead time (~2s) so slow
  loads/typing don't leave silent stretches.
- **End a shot on settled content.** After a `goto`/`click` that navigates, add
  `assertVisible` a real content element so the NEXT shot's anchor captures the
  loaded screen (not a spinner). Wait on content, never a fixed `beat`, for
  correctness.
- **Destructive / persisting actions: click to the safe boundary, mutate only on
  opt-in.** The demo still CLICKS the destructive control to show what it does —
  Delete opens its confirmation dialog; a form is filled — but stops AT the
  mutation boundary: set `dataSafety: { mutates: true, stopBefore: "click:<confirm
  / Save>" }` and never click that final confirm/submit (glide to it, or simply
  omit it). `generate-feature` enforces `stopBefore` (fails if a step performs it
  while `mutates` isn't true). Cross the boundary — click the delete confirm, click
  Save — ONLY when the user opted in at the step-1 gate; then record with
  `--allow-mutations`, supply a `reset:` plan, and show the result (row removed /
  record created).
- **Narration: business language, don't read labels verbatim.** Say what a
  control does and why it matters to the user, not the on-screen label word-for-word
  ("we filter the roster to one person," not "we click the Search-users-by-name box").
  One action per line; the voice-first recorder paces each shot to its narration.
- **Guarded shots** (`guardExpr`) for parts only reachable in some states; the
  recorder skips them and the mux drops their clips automatically.
- **`guardExpr` runs BEFORE the shot's steps — guard only on what's already true.**
  The guard is evaluated on whatever screen the PREVIOUS shot left, before this
  shot's `goto`/arrival runs. So two traps: (1) don't guard on a control that only
  exists on the page THIS shot navigates to — the check runs on the old page and
  is always false (silent skip); (2) don't guard on async-loaded content by count
  right after arrival — a list that fetches its rows via API is momentarily empty,
  so `locator(...).count() > 0` reads 0. If a shot must return to a screen and act
  on data-dependent content, put the `goto` + `assertVisible` (which WAITS) in the
  shot **body**, not the guard, and click there. Reserve `guardExpr` for state that
  the previous shot already left on screen (a tab that may be absent, a role that
  hides a button) — a cheap, synchronous, current-page check.

## Rules

CLAUDE.md's rules apply throughout; the two this workflow trips most are
Rule 1 (regenerate after every feature.yaml change) and Rule 5 (`guardExpr` +
logged skip for data-dependent shots — `mark` goes inside the guard).
