# Setup Guide — Video Creator

> **Archived reference.** This guide describes the framework as a **standalone
> repo**, before it became a plugin: it assumes `platform/` sits inside your
> project and that `npm run …` scripts exist there. Neither is true in plugin
> form — a walkthrough project is pure content with no `package.json`.
> For current instructions see the plugin README, `/setup` and
> `/init`. Kept because its conceptual material (the rules, the
> troubleshooting, the lexicon) is still accurate.

Video Creator makes narrated walkthrough videos of **any** web app for you.
You point it at an app. It opens the app, records the screen, adds a voiceover,
and saves an MP4. You do not edit videos by hand.

**Two things to keep straight:**

- `platform/` is the tool itself. **You never change it.**
- `walkthroughs/<app>/` is your content for one app. **This is what you create.**

One copy of this repo can hold many apps, each in its own folder under
`walkthroughs/`.

The guide has three parts. Do Part 1 once per computer. Do Part 2 once per app.
Do Part 3 every time you want a video.

---

## Part 1 — Install the tool (once per computer)

### Step 1: Check you have these

| You need | Version | Why |
|---|---|---|
| Node.js | 18 or newer | Runs the tool |
| Python | **3.10, 3.11, or 3.12** | Makes the voiceover. **Do not use 3.13 or 3.14** — they are not supported yet |
| Git | any | Downloads the code |
| Internet | first run only | Downloads the voice model once (a few GB) |

You do **not** need to install ffmpeg or Chrome yourself. The tool brings its own.

### Step 2: Get the code and install it

Run these commands one after another:

```bash
git clone <your-repo-url> video-creator
cd video-creator

npm install
npx playwright install chromium
```

### Step 3: Install the voice toolkit

Pick the **one** line that matches your computer:

```bash
# macOS, Linux, or Git Bash on Windows:
bash platform/tts/setup-tts.sh

# Windows PowerShell:
powershell -ExecutionPolicy Bypass -File platform/tts/setup-tts.ps1
```

The first time, this takes about 15–20 minutes because it downloads the voice
model. After that it is quick, because the model is saved on your computer.

### Step 4: Confirm everything works

```bash
npm run doctor
```

Every line should show a green `✓`. If a line shows a problem, `doctor` tells you
how to fix it. Fix it, then run `npm run doctor` again until all lines are green.

---

## Part 2 — Add an app to make videos of (once per app)

There are two cases. Read both titles and follow the one that matches you.

### Case A — The app is already set up in this repo

If a folder `walkthroughs/<app>/` already exists, someone set the app up before.
You only need to add the login. Passwords live in a `.env` file that is **never**
shared or committed.

1. Copy the example file:
   ```bash
   cp walkthroughs/<app>/.env.example walkthroughs/<app>/.env
   ```
2. Open the new `.env` file and type in the real email and password. If the app
   has more than one environment (e.g. a live site and a local copy that need
   **different** logins), `.env.example` will show extra slots like
   `WALKTHROUGH_LOCAL_EMAIL` / `WALKTHROUGH_LOCAL_PASSWORD` — fill in the ones you
   plan to record against.
3. That's all. Go to Part 3.

### Case B — A brand-new app

1. **(Optional) Add the app's source code** to the `app-source/` folder. This
   helps the tool understand the app. No source code? That's fine — the tool can
   explore the running app instead.
2. **Start the app** and note its web address, for example
   `http://localhost:3000`.
3. **Let the tool set everything up.** In Claude Code, run:
   ```
   /walkthrough-discover
   ```
   It builds the `walkthroughs/<your-app>/` folder for you: the settings, a map of
   the app, and draft plans for videos. It will ask you for the app's address and
   login details.
4. **Add the real login.** Open the `.env` file the tool created and type in the
   real email and password.

> Want to do it by hand instead? Copy
> `platform/templates/project.yaml.tmpl` to
> `walkthroughs/<your-app>/project.yaml` and fill in the address and login path.

---

## Part 3 — Make a video

One command does the whole job. It stops and tells you if anything goes wrong:

```bash
npm run produce -- walkthroughs/<app>/modules/<module>/features/<feature>
```

This writes the script, records the screen, makes the voiceover, joins them
together, and checks the result. Every video comes out **Full HD (1920×1080) at
30 fps** with a smooth on-screen cursor. When it finishes, your video is here:

```
walkthroughs/<app>/modules/<module>/features/<feature>/generated/walkthrough-narrated.mp4
```

**Before it records, the tool checks with you.** If a video would do anything that
changes real data — submit a form, create, save an edit, or delete — it lists
those exact actions and asks you to confirm first. By default it stops right at
that line (it fills the form or opens the delete prompt but never commits). It
only performs a real change if you say so.

Helpful extras:

- **Want to watch the browser while it records?** Add `--headed` to the end of the
  command.
- **Want to keep the finished video somewhere safe?** Videos are not saved in git.
  Copy one out with:
  ```bash
  npm run publish -- walkthroughs/<app>/modules/<module>/features/<feature> --dest <your-folder>
  ```

### Choose where to record: live or local

Some apps are set up with more than one **environment** — for example a deployed
`live` site and a `local` copy that runs on your machine. Pick one with `--env`:

```bash
npm run produce -- <feature> --env live      # the deployed site
npm run produce -- <feature> --env local     # a local copy (the tool starts it for you)
```

For `local`, the tool starts the app's frontend and backend from `app-source/`
automatically before recording, and shuts them down after — you don't start
anything by hand. Each environment can have its **own login** (a live site and a
local copy usually need different accounts); those extra logins live in the same
`.env` file (see Part 2). If an app has just one address, you don't need `--env`
at all.

### Make a full-app tour (a "journey")

Once you have several finished feature videos, you can stitch them into **one**
end-to-end walkthrough (sign-in → … → sign-out) — without re-recording anything:

```bash
npm run journey -- walkthroughs/<app>/journeys/<id>
```

It reuses the finished feature videos, trims the repeated sign-in from later
parts, and joins them into
`walkthroughs/<app>/journeys/<id>/generated/journey.mp4`. Ask
`/walkthrough-discover` to draft a journey, or add
`walkthroughs/<app>/journeys/<id>/journey.yaml` yourself (an ordered list of the
features to include).

---

## Commands you'll use often

| Command | What it does |
|---|---|
| `npm run doctor` | Checks your computer is ready |
| `npm run doctor -- <feature> --env <name>` | Also checks that feature's login + environment before recording |
| `npm run catalog` | Lists every video and shows what still needs work |
| `npm run produce -- <feature>` | Makes one video from start to finish |
| `npm run produce -- <feature> --env live\|local` | Makes it against a specific environment |
| `npm run produce -- --stale` | Makes or refreshes every video that is out of date |
| `npm run journey -- <app>/journeys/<id>` | Stitches finished feature videos into one end-to-end tour |
| `npm run publish -- <feature> --dest <dir>` | Copies a finished video somewhere safe |

`<feature>` means the folder path, for example:
`walkthroughs/acme/modules/billing/features/create-invoice`.

Inside Claude Code you also have two helpers:

- **`/walkthrough-discover`** — map a new app and draft its video plans.
- **`/walkthrough-produce`** — build one video, step by step (same job as
  `npm run produce`).

---

## 5 rules that keep things working

1. **Edit `feature.yaml`, not the generated files.** The script and voiceover are
   built from `feature.yaml`. Change the yaml, then build again. (The tool refuses
   to record a script you edited by hand.)
2. **Never put passwords in the yaml.** Real logins go only in `.env`, which is
   never committed. The yaml only names them.
3. **Never edit `platform/`.** Anything one app needs goes in that app's
   `project.yaml`.
4. **Videos are not committed to git.** They can be rebuilt anytime. Use
   `npm run publish` to keep the finished files.
5. **Flag anything that changes real data.** Set `dataSafety.mutates: true` (or a
   `stopBefore:` rule) so the recorder never touches live data by accident. The
   tool confirms those actions with you before recording, and only performs a
   real change (delete, save, submit) if you opt in — with a plan to undo it.

---

## Troubleshooting

**`doctor` says the venv Python is out of range.**
You built the voice toolkit with Python 3.13 or 3.14, which is not supported yet.
Rebuild it with 3.12:
```bash
# Windows PowerShell:
powershell -ExecutionPolicy Bypass -File platform/tts/setup-tts.ps1 -Python "py -3.12"
# macOS/Linux:
bash platform/tts/setup-tts.sh --python=python3.12
```
This replaces the wrong version for you.

**Recording fails right away with "spawn EPERM" or "Permission denied".**
Your computer is blocking the tool's built-in browser from running. This is
common on locked-down work laptops (antivirus or company security rules).
The fix is to use the Chrome (or Edge) you already have installed. Open the
app's `project.yaml` and add this under `video:`
```yaml
video:
  channel: chrome     # or: msedge
```
Then record again. (When recording fails, the tool now checks for this and
prints the same hint.)

**"channel 'chrome' not found".**
The opposite case: the app's `project.yaml` asks for real Google Chrome, but it
isn't installed. Either install Chrome, or remove the `channel: chrome` line to
use the built-in browser.

**The app can't be reached, or recording times out.**
The app must be running before you record. Two things to check:
1. Start the app and confirm you can open its address in a browser.
2. If it's a cloud app that "sleeps," open it once to wake it up — the very first
   recording can be slow while it starts.

Then confirm it responds:
```bash
npm run doctor -- <feature>
```

**No internet, so the voice model won't download.**
Copy the folder `~/.cache/huggingface` (Windows:
`%USERPROFILE%\.cache\huggingface`) from a computer that already has it.

**You copied the folder instead of cloning it.**
Delete the machine-specific parts and rebuild them: `node_modules/`,
`platform/tts/venv/`, every `generated/` folder, and any `__pycache__/`. A copied
voice toolkit (venv) never works on another computer.

**A name or acronym is said wrong in the voiceover.**
Add how it should sound to a lexicon file:
`platform/tts/lexicon.default.json` (applies to all apps), or
`walkthroughs/<app>/knowledge/lexicon.json` (that app only).
Format: `{ "written word": "how it should sound" }`.
