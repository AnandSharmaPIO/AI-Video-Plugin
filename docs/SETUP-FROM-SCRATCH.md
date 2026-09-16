# Setup From Scratch — New Machine + New App

> **Archived reference.** Describes the framework as a standalone repo, before
> it became a plugin (`platform/` inside the project, `npm run …` scripts).
> For current instructions see the plugin README, `/setup` and
> `/init`.

Use this guide when **both** are true:

- You are on a **fresh machine** that has never run Video Creator, and
- You are adding a **brand-new app** (its source code goes into `app-source/`).

Follow the parts in order. Part 1 sets up the machine. Part 2 onboards the app.
Part 3 makes your first video.

> If the machine is already set up, or the app already has a `walkthroughs/<app>/`
> folder, use `docs/SETUP.md` instead — it covers those shorter paths.

---

## Part 1 — Set up the machine

### Step 1: Install the prerequisites

Install these first, then check each version:

| Tool | Version | Check command |
|---|---|---|
| Node.js | 18 or newer | `node -v` |
| Python | **3.10, 3.11, or 3.12** (not 3.13 / 3.14) | `python --version` |
| Git | any | `git --version` |

You do **not** install ffmpeg or a browser yourself. The tool ships its own
ffmpeg, and downloads its own Chromium in Step 3.

You also need internet for the first run — it downloads the voice model once
(a few GB), then caches it.

### Step 2: Clone the repo and install dependencies

```bash
git clone <your-repo-url> video-creator
cd video-creator

npm install
npx playwright install chromium
```

`npm install` sets up the Node engine. `npx playwright install chromium` fetches
the browser the recorder drives.

### Step 3: Build the TTS (voiceover) toolkit

This creates a Python virtual environment (venv) under `platform/tts/venv` and
downloads the voice model. Run the **one** line for your shell:

```bash
# macOS, Linux, or Git Bash on Windows:
bash platform/tts/setup-tts.sh

# Windows PowerShell:
powershell -ExecutionPolicy Bypass -File platform/tts/setup-tts.ps1
```

The first build takes about 15–20 minutes (model download). Later builds are
fast, because the model is cached in your user profile.

### Step 4: Verify the machine

```bash
npm run doctor
```

Read the output. Every line should show a green `✓`. If a line fails, `doctor`
prints the exact fix — apply it and run `npm run doctor` again until all pass.

The machine is now ready for any app.

---

## Part 2 — Onboard the new app

### Step 1: Add the app's source code

Put the app's source into the `app-source/` folder (for example a `Frontend/`
and `Backend/` folder). The discovery step reads this to learn the app's pages,
routes, labels, and user journeys.

No source code available? You can skip it — the tool can explore the running app
live instead. Source just makes discovery faster and more accurate.

### Step 2: Make the app reachable

Start the app (locally or a deployed URL) and confirm you can open its address in
a normal browser, for example `http://localhost:3000` or
`https://app.example.com`. Keep this address handy — you'll enter it in the next
step.

### Step 3: Run discovery

In Claude Code, run:

```
/walkthrough-discover
```

This builds the catalog for the app under `walkthroughs/<your-app>/`:

- `project.yaml` — the app's settings (address, login, video options, and — if
  it has more than one — named **environments** such as `live` and `local`).
- `knowledge/` — the app map, user journeys, and proven locators.
- `modules/<m>/features/<f>/feature.yaml` — draft plans for each video (it also
  drafts each control's click and any full-app **journey**).

It will ask you for the app's address and how login works. Answer those prompts.

> Want to scope it? You can tell discovery to map only part of the app, e.g.
> *"only the Users module"*.

### Step 4: Fill in the login

Discovery creates a `.env.example`. Copy it and add the real credentials. The
`.env` file is **never committed** — passwords stay only on your machine.

```bash
cp walkthroughs/<your-app>/.env.example walkthroughs/<your-app>/.env
# open .env and type the real email + password
```

The `feature.yaml` files only name the environment variables (like
`WALKTHROUGH_EMAIL`); the real values live in `.env`. If the app has a `local`
environment that needs a **different** login than `live`, `.env.example` includes
extra slots (e.g. `WALKTHROUGH_LOCAL_EMAIL` / `WALKTHROUGH_LOCAL_PASSWORD`) — fill
in the ones you'll record against.

### Step 5: Pick a browser if the built-in one is blocked

On locked-down work machines, security software often blocks the bundled
Chromium from running (you'll see `spawn EPERM` / `Permission denied` when
recording). If so, tell the tool to use the Chrome or Edge you already have.
Add this to `walkthroughs/<your-app>/project.yaml`:

```yaml
video:
  channel: chrome     # or: msedge
```

If the built-in browser records fine, skip this step.

---

## Part 3 — Make your first video

Run the full pipeline for one feature. It writes the script, records the screen,
generates the voiceover, muxes them, and verifies the result — output is **Full
HD (1920×1080) at 30 fps**:

```bash
npm run produce -- walkthroughs/<your-app>/modules/<module>/features/<feature>
```

Add `--headed` to watch the browser as it records.

**Before recording, the tool confirms with you.** If the video would change real
data (submit/create/save/delete) it lists those exact actions first and, by
default, stops right before committing them — it only performs a real change if
you opt in.

When it finishes, the video is here:

```
walkthroughs/<your-app>/modules/<module>/features/<feature>/generated/walkthrough-narrated.mp4
```

**Recording live vs local.** If discovery set up environments, choose one with
`--env`:

```bash
npm run produce -- <feature> --env live      # deployed site
npm run produce -- <feature> --env local     # local copy — the tool starts frontend+backend for you
```

**Full-app tour.** After you have several feature videos, stitch them into one
end-to-end walkthrough (no re-recording):

```bash
npm run journey -- walkthroughs/<your-app>/journeys/<id>
```

Videos are not stored in git (they can be rebuilt anytime). To keep a copy:

```bash
npm run publish -- walkthroughs/<your-app>/modules/<module>/features/<feature> --dest <your-folder>
```

To see every planned video and its status:

```bash
npm run catalog
```

---

## If something breaks

**`doctor` says the venv Python is out of range.**
The voice toolkit was built with Python 3.13/3.14. Rebuild with 3.12:
```bash
# Windows PowerShell:
powershell -ExecutionPolicy Bypass -File platform/tts/setup-tts.ps1 -Python "py -3.12"
# macOS/Linux:
bash platform/tts/setup-tts.sh --python=python3.12
```

**Recording fails immediately with `spawn EPERM` / `Permission denied`.**
The built-in browser is blocked from running. Set `video.channel: chrome`
(or `msedge`) in the app's `project.yaml` — see Part 2, Step 5.

**The app can't be reached, or recording times out.**
The app must be running before you record. If it's a cloud app that sleeps, open
it once to wake it — the first recording can be slow while it starts. Then check
it responds: `npm run doctor -- <feature>`.

**No internet to download the voice model.**
Copy `~/.cache/huggingface` (Windows: `%USERPROFILE%\.cache\huggingface`) from a
machine that already has it.
