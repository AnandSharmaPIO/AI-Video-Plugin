#!/usr/bin/env node
/**
 * record-feature — cross-platform runner that records one feature's walkthrough.
 *
 * Usage:
 *   node platform/scripts/record-feature.mjs <feature-path> [--headed] [--allow-mutations]
 *   npm run record -- <project>/modules/<module>/features/<feature>
 *
 * <feature-path> is a folder containing feature.yaml + walkthrough.spec.ts.
 * The runner:
 *   1. validates the feature folder and reads feature.yaml,
 *   2. refuses features marked dataSafety.mutates unless --allow-mutations,
 *   3. runs Playwright with the shared platform config (WT_FEATURE_DIR),
 *   4. verifies the promoted recording + shot timings exist.
 *
 * Replaces the bash-only scaffolder for day-to-day recording (works in
 * PowerShell, cmd, and any POSIX shell).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse, parseDocument } from 'yaml';
import { repoRoot, pluginRoot, engine, parseArgs, specHash, sha1, featureContentHash } from './lib/common.mjs';

const { flags, positional, opt } = parseArgs(process.argv.slice(2), ['--env']);
const wtEnv = opt('--env'); // recording environment (e.g. live | local); resolved in playwright.config

/**
 * On a recording failure, check whether the cause is the browser binary being
 * blocked from executing (corporate AppLocker/AV commonly blocks the bundled
 * Chromium under AppData). Runs ONLY on failure, and skips the probe when the
 * project already pins a browser channel (that config already sidesteps this).
 * Emits a targeted, actionable hint — precise rather than a generic wall.
 */
function diagnoseBrowserLaunch(fromDir) {
  try {
    // Nearest project.yaml above the feature — skip if a channel is already set.
    let dir = fromDir;
    for (let i = 0; i < 12; i++) {
      const pj = path.join(dir, 'project.yaml');
      if (fs.existsSync(pj)) {
        const cfg = parse(fs.readFileSync(pj, 'utf8'));
        if (cfg?.video?.channel) return; // already using a system browser
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    const probe = spawnSync(
      process.execPath,
      ['-e', "import('@playwright/test').then(m=>m.chromium.launch()).then(b=>b.close()).then(()=>process.exit(0)).catch(e=>{console.error(String(e&&e.message||e));process.exit(7);})"],
      // Probe from the PLUGIN — that is where @playwright/test is installed.
      { cwd: pluginRoot, encoding: 'utf8', timeout: 45_000 },
    );
    const msg = `${probe.stderr || ''}`;
    if (probe.status === 7 && /EPERM|EACCES|permission denied|spawn/i.test(msg)) {
      console.error(
        '\n▶ Diagnosis: the bundled Chromium could not be launched — it appears BLOCKED\n' +
        '  from executing (e.g. corporate AppLocker/antivirus on the AppData browser cache).\n' +
        '  Fix: use the system-installed browser by adding to project.yaml:\n' +
        '      video:\n' +
        '        channel: chrome     # or: msedge\n' +
        `  Probe error was: ${msg.trim().split('\n')[0]}`,
      );
    }
  } catch {
    /* diagnosis is best-effort — never mask the original failure */
  }
}

/**
 * The generated spec lives in the user's project (never an ancestor of the
 * plugin), and it needs Node's real ESM resolver — Playwright only picks
 * `import()` over `require()` for a test file when Node's own module-type
 * lookup (nearest package.json "type") says "module" (@playwright/test's
 * requireOrImport / fileIsModule). Without that, the spec loads as CommonJS,
 * and `@engine/cursor` -> `./env.mjs` (a real ESM-only file) hard-fails —
 * Node refuses to `require()` a .mjs file no matter what any loader hook does.
 *
 * Fix: drop two tiny, gitignored, machine-generated files next to the spec —
 * a `package.json` (`{"type":"module"}`) so Node's lookup finds "module" right
 * there, and a `node_modules` link to the plugin's own install so the spec's
 * `import '@playwright/test'` resolves under real (NODE_PATH-blind) ESM
 * resolution. Both are pure build plumbing: nothing here is authored content,
 * nothing needs to be committed, and the feature folder holds nothing else
 * that would collide with these names.
 */
function ensureEsmResolution(featureDir) {
  const pkgPath = path.join(featureDir, 'package.json');
  if (!fs.existsSync(pkgPath)) fs.writeFileSync(pkgPath, JSON.stringify({ private: true, type: 'module' }, null, 2) + String.fromCharCode(10));

  const nmPath = path.join(featureDir, 'node_modules');
  if (!fs.existsSync(nmPath)) {
    const target = path.join(pluginRoot, 'node_modules');
    try {
      fs.symlinkSync(target, nmPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

if (positional.length !== 1) {
  console.error('usage: record-feature <feature-path> [--headed] [--allow-mutations] [--allow-edited-spec]');
  process.exit(2);
}

const featureDir = path.resolve(repoRoot, positional[0]);
const featureYaml = path.join(featureDir, 'feature.yaml');
const spec = path.join(featureDir, 'walkthrough.spec.ts');

for (const [what, p] of [['feature.yaml', featureYaml], ['walkthrough.spec.ts', spec]]) {
  if (!fs.existsSync(p)) {
    console.error(`error: ${what} not found at ${p} — is this a feature folder?`);
    process.exit(2);
  }
}

const feature = parse(fs.readFileSync(featureYaml, 'utf8'));

// Content-based staleness (mtimes don't survive a git clone): if feature.yaml's
// content changed since the spec was generated, the recording wouldn't match the
// source of truth (Rule 1). Regenerate first.
const currentContentHash = featureContentHash(feature);
if (feature?.status?.contentHash && feature.status.contentHash !== currentContentHash) {
  console.error(
    'error: feature.yaml changed since walkthrough.spec.ts was generated — regenerate first:\n' +
      `  node platform/scripts/generate-feature.mjs ${positional[0]}`,
  );
  process.exit(2);
}

// Refuse a hand-edited spec: specs are generated output (Rule 1). If the on-disk
// spec doesn't match what generate-feature last produced, recording it would
// bake in edits that feature.yaml doesn't describe. --allow-edited-spec overrides
// for deliberate spec experiments.
const onDiskSpecHash = sha1(fs.readFileSync(spec, 'utf8'));
if (feature?.status?.generatedSpecHash && feature.status.generatedSpecHash !== onDiskSpecHash
    && !flags.has('--allow-edited-spec')) {
  console.error(
    'error: walkthrough.spec.ts has been edited by hand (does not match the last generated spec).\n' +
      '  Specs are generated — put changes in feature.yaml and regenerate, or\n' +
      '  re-run with --allow-edited-spec to record the edited spec deliberately.',
  );
  process.exit(2);
}
if (!feature?.status?.generatedSpecHash) {
  console.warn(
    '⚠ feature.yaml has no status.generatedSpecHash — cannot verify the spec is current. ' +
      `Regenerate to enable this check: node platform/scripts/generate-feature.mjs ${positional[0]}`,
  );
}
if (feature?.dataSafety?.mutates && !flags.has('--allow-mutations')) {
  console.error(
    `refusing to record: feature "${feature.id}" is marked dataSafety.mutates=true.\n` +
      `Reset plan: ${feature.dataSafety.reset ?? '(none documented)'}\n` +
      `Re-run with --allow-mutations once demo state is prepared and reversible.`,
  );
  process.exit(3);
}

console.log(`▶ Recording feature: ${feature?.id ?? path.basename(featureDir)}`);
if (feature?.dataSafety?.stopBefore) {
  console.log(`  (spec is expected to stop before: ${feature.dataSafety.stopBefore})`);
}

// Voice-first pipeline: the narration clips should exist BEFORE recording so
// each shot can dwell for its voiceover length (holdForNarration). Without them
// the recorder falls back to fixed holdMs pacing and the voice won't be synced.
if (!fs.existsSync(path.join(featureDir, 'generated', 'clips', 'manifest.json'))) {
  console.warn(
    '⚠ no narration clips yet (generated/clips/manifest.json) — shots will use ' +
      'fallback holdMs pacing, NOT voice-synced timing.\n' +
      '  For tight sync, generate the voiceover first, then record:\n' +
      `    <venv-python> platform/tts/generate.py --dir ${positional[0]}\n` +
      `  (or just run: npm run produce -- ${positional[0]}  — it does this in order.)`,
  );
}

// Playwright comes from the PLUGIN's node_modules — the user's project has no
// dependency on it. Invoking cli.js through node (rather than the .bin shim via
// npx/shell) keeps this correct on paths containing spaces. --tsconfig points at
// the plugin's tsconfig so the generated spec's `@engine/*` imports resolve
// across the plugin boundary, wherever the project happens to live.
const pwCli = path.join(pluginRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const pwArgs = [
  pwCli, 'test',
  '--config', engine('engine', 'playwright.config.ts'),
  '--tsconfig', path.join(pluginRoot, 'tsconfig.json'),
];
if (flags.has('--headed')) pwArgs.push('--headed');

if (wtEnv) console.log(`  environment: ${wtEnv} (playwright.config picks its baseUrl${'' } + auto-starts its servers)`);

ensureEsmResolution(featureDir);

const result = spawnSync(process.execPath, pwArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
  // WT_ENV selects the recording environment (baseUrl + which servers to start).
  env: { ...process.env, WT_FEATURE_DIR: featureDir, ...(wtEnv ? { WT_ENV: wtEnv } : {}) },
});

if (result.status !== 0) {
  console.error(`✗ recording failed (exit ${result.status})`);
  diagnoseBrowserLaunch(featureDir);
  process.exit(result.status ?? 1);
}

// Verify outputs — never assume success.
const webm = path.join(featureDir, 'generated', 'walkthrough.webm');
const timings = path.join(featureDir, 'generated', 'shot-timings.json');
let ok = true;
for (const [what, p] of [['recording', webm], ['shot timings', timings]]) {
  if (fs.existsSync(p) && fs.statSync(p).size > 0) {
    console.log(`  ✓ ${what}: ${path.relative(repoRoot, p)} (${fs.statSync(p).size} bytes)`);
  } else {
    console.error(`  ✗ missing ${what}: ${p}`);
    ok = false;
  }
}
if (!ok) process.exit(1);

const shots = JSON.parse(fs.readFileSync(timings, 'utf8'));

// Stamp what was recorded — catalog.mjs compares this against the current
// spec to detect stale recordings.
const recordedAt = new Date().toISOString();
const hash = specHash(spec);
fs.writeFileSync(
  path.join(featureDir, 'generated', 'record-meta.json'),
  JSON.stringify(
    {
      featureId: feature?.id ?? path.basename(featureDir),
      recordedAt,
      specHash: hash,
      shots: shots.map((s) => s.shot),
    },
    null,
    2,
  ),
);

// Stamp the committed status into feature.yaml (preserving comments/format).
// Staleness is content-based (specHash / contentHash), so no mtime juggling is
// needed — catalog compares these committed hashes and works from a fresh clone.
const doc = parseDocument(fs.readFileSync(featureYaml, 'utf8'));
doc.setIn(['status', 'recordedAt'], recordedAt.slice(0, 10));
doc.setIn(['status', 'specHash'], hash);
fs.writeFileSync(featureYaml, doc.toString());

console.log(`✅ recorded ${shots.length} shots: [${shots.map((s) => s.shot).join(', ')}]`);
console.log(`  ✓ stamped status.recordedAt/specHash into feature.yaml`);
console.log('Next: generate narration audio and mux —');
console.log(`  <venv-python> platform/tts/generate.py --dir "${path.relative(repoRoot, featureDir)}"`);
console.log(`  <venv-python> platform/tts/build_narrated.py --dir "${path.relative(repoRoot, featureDir)}"`);
