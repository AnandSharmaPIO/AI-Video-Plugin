#!/usr/bin/env node
/**
 * doctor — preflight the machine before the first (or a failing) production run.
 * Every prereq that otherwise fails DEEP inside a Playwright run or a Python
 * traceback is checked here up front, with the fix printed next to each failure.
 *
 * Usage:
 *   node platform/scripts/doctor.mjs [<feature-path>]
 * With a feature path it also checks that project's credentials (.env) and the
 * reachability of its baseUrl — the checks most likely to burn a 5-min timeout.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { repoRoot, pluginRoot, parseArgs, venvPython } from './lib/common.mjs';
import { findUp, loadEnvChain } from '../engine/env.mjs';

const { positional, opt } = parseArgs(process.argv.slice(2), ['--env']);
const checks = [];
const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });

// ── Node ──
const nodeMajor = Number(process.versions.node.split('.')[0]);
add('Node.js', nodeMajor >= 18, `v${process.versions.node}`,
  'Install Node.js LTS 18+ (nodejs.org).');

// ── npm deps installed ──
// Engine dependencies live in the PLUGIN, not the user's project.
add('npm dependencies', fs.existsSync(path.join(pluginRoot, 'node_modules', '@playwright')),
  fs.existsSync(path.join(pluginRoot, 'node_modules')) ? 'node_modules present' : 'node_modules missing',
  'Run: /walkthrough-setup  (npm install --prefix <plugin>)');

// ── Playwright browsers (chromium) + Chrome channel if any project needs it ──
const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
function browserCheck() {
  const bases = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(homeDir, '.cache', 'ms-playwright'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ].filter(Boolean);
  const found = bases.some((b) => fs.existsSync(b) &&
    fs.readdirSync(b).some((d) => d.startsWith('chromium')));
  add('Playwright Chromium', found, found ? 'installed' : 'not found',
    'Run: npx playwright install chromium');
}
browserCheck();

// Does any project.yaml request channel: chrome? If so, real Chrome is required.
let needsChrome = false;
try {
  const stack = [path.join(repoRoot, 'walkthroughs')];
  while (stack.length) {
    const d = stack.pop();
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'project.yaml') {
        const proj = parse(fs.readFileSync(p, 'utf8'));
        if (proj?.video?.channel === 'chrome') needsChrome = true;
      }
    }
  }
} catch { /* ignore */ }
if (needsChrome) {
  const chromePaths = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  const found = chromePaths.some((p) => fs.existsSync(p));
  add('Google Chrome (channel: chrome)', found, found ? 'found' : 'not found',
    'A project.yaml sets video.channel: chrome. Install Google Chrome, or remove ' +
      'that line to use the bundled Chromium.');
}

// ── TTS venv (must exist AND be Python 3.10–3.12) ──
const py = venvPython();
if (!py) {
  add('TTS venv', false, 'not built',
    'Build it: bash platform/tts/setup-tts.sh  (or pwsh platform/tts/setup-tts.ps1 on Windows)');
} else {
  const v = spawnSync(py, ['-c', "import sys;print('%d.%d'%sys.version_info[:2])"], { encoding: 'utf8' });
  const ver = (v.stdout || '').trim();
  const [mj, mn] = ver.split('.').map(Number);
  const supported = mj === 3 && mn >= 10 && mn <= 12;
  add('TTS venv', supported, `Python ${ver || '?'} (${path.relative(pluginRoot, py)})`,
    'venv Python is out of the supported 3.10–3.12 range — rebuild with a supported one: ' +
      'pwsh platform/tts/setup-tts.ps1 -Python "py -3.12"  (it will recreate the venv).');
}

// ── ffmpeg that can actually make MP4 (libx264 + aac) ──
function ffmpegCheck() {
  let ff = which('ffmpeg');
  let source = ff ? 'system' : null;
  if (!ff && py) {
    const r = spawnSync(py, ['-c',
      'import imageio_ffmpeg,sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) { ff = r.stdout.trim(); source = 'imageio-ffmpeg'; }
  }
  if (!ff) {
    add('ffmpeg (MP4-capable)', false, 'none found',
      'Install system ffmpeg, or: <venv-python> -m pip install imageio-ffmpeg');
    return;
  }
  const enc = spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
  const canMp4 = enc.includes('libx264') && / aac/.test(enc);
  add('ffmpeg (MP4-capable)', canMp4, `${source}: ${canMp4 ? 'libx264+aac ok' : 'missing H.264/AAC'}`,
    'This ffmpeg cannot encode MP4. Install a full build, or pip install imageio-ffmpeg.');
}
function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
}
ffmpegCheck();

// ── Per-feature checks: credentials + baseUrl reachability ──
async function featureChecks(rel) {
  const featureDir = path.resolve(repoRoot, rel);
  const projectFile = findUp('project.yaml', featureDir);
  if (!projectFile) { add('project.yaml', false, `none above ${rel}`, 'Feature must live under a project.'); return; }
  const project = parse(fs.readFileSync(projectFile, 'utf8'));

  loadEnvChain(featureDir);

  // Resolve the selected environment (--env / defaultEnv / top-level) first, so
  // the credentials check can target THIS environment's credentials if it names
  // its own (e.g. local uses a seeded-DB account distinct from live).
  const envs = project?.environments ?? {};
  const envName = opt('--env') || project?.defaultEnv || '';
  const env = envName ? envs[envName] : null;
  if (envName && !env) {
    add('Environment', false, `"${envName}" not defined`,
      `Add it to project.yaml environments (have: ${Object.keys(envs).join(', ') || 'none'}), or pass a valid --env.`);
    return; // can't resolve baseUrl/reachability for an unknown environment
  }

  // Credentials present? Prefer the selected environment's credentialsEnv over
  // the project-level auth.credentialsEnv when it defines them.
  if (project?.auth) {
    const baseNames = project.auth.credentialsEnv ?? ['WALKTHROUGH_EMAIL', 'WALKTHROUGH_PASSWORD'];
    const names = env?.credentialsEnv?.length ? env.credentialsEnv : baseNames;
    const missing = names.filter((k) => !process.env[k]);
    add(`Credentials${env?.credentialsEnv?.length ? ` (${envName})` : ''}`, missing.length === 0,
      missing.length ? `unset: ${missing.join(', ')}` : `present (${names.join(', ')})`,
      `Set them in ${path.dirname(projectFile)}/.env (copy from .env.example).`);
  }
  const baseUrl = (env?.baseUrl) || project?.baseUrl;
  const start = env?.start ?? project?.start;
  const autoStarts = Array.isArray(start) ? start.some((s) => s?.command) : !!start?.command;
  if (envName) add('Environment', true, `${envName} → ${baseUrl}${autoStarts ? ' (servers auto-start)' : ''}`, '');

  // baseUrl reachable? (a local env with start commands is auto-started by
  // Playwright, so "not reachable now" is fine — report it, don't fail.)
  if (baseUrl) {
    let up = false, detail = baseUrl;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(baseUrl, { signal: ac.signal, redirect: 'manual' });
      clearTimeout(t);
      up = res.status < 500;
      detail = `${baseUrl} → HTTP ${res.status}`;
    } catch (e) {
      detail = `${baseUrl} → ${e.cause?.code ?? e.name}`;
    }
    add('App reachable', up || autoStarts,
      autoStarts && !up ? `${detail} (will auto-start on record)` : detail,
      autoStarts
        ? 'App not up now — Playwright boots its start command(s) when recording.'
        : 'App not reachable. Start it, fix baseUrl, or pick an env with a start command.');
  }
}

const run = positional.length === 1 ? featureChecks(positional[0]) : Promise.resolve();
run.then(() => {
  console.log('\nVideo Creator — doctor\n');
  let allOk = true;
  for (const c of checks) {
    const mark = c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`${mark} ${c.name.padEnd(28)} ${c.detail}`);
    if (!c.ok) { console.log(`    → ${c.fix}`); allOk = false; }
  }
  console.log(allOk ? '\n\x1b[32mAll checks passed.\x1b[0m'
    : '\n\x1b[31mSome checks failed — fix the items above before producing.\x1b[0m');
  process.exit(allOk ? 0 : 1);
});
