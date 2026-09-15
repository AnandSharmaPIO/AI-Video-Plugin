#!/usr/bin/env node
/**
 * produce-feature — run the FULL pipeline for one or many features, halting on
 * the first failed stage. This is the orchestrator the platform previously
 * lacked: generate → record → tts → mux → verify, in the correct order, so a
 * bad stage stops the chain instead of feeding corrupt state downstream.
 *
 * Usage:
 *   node platform/scripts/produce-feature.mjs <feature-path> [stage flags] [passthrough]
 *   node platform/scripts/produce-feature.mjs --all      [stage flags]
 *   node platform/scripts/produce-feature.mjs --stale    [stage flags]   (only features catalog flags)
 *
 * Stage flags (default: all stages run):
 *   --skip-generate --skip-record --skip-tts --skip-mux --skip-verify
 *   --from <stage> / --to <stage>   run a contiguous slice (generate|record|tts|mux|verify)
 * Passthrough:
 *   --headed                to record
 *   --allow-mutations       to record (feature marked dataSafety.mutates)
 *   --allow-edited-spec     to record
 *   --mode extend|exact|sequential   to the mux
 *   --baseline write|auto|off        to verify (default auto)
 *   --continue-on-error     with --all/--stale: don't stop the batch on one feature's failure
 *
 * Exit non-zero if any feature failed. Media stays gitignored; publish separately.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { repoRoot, engine, parseArgs, venvPython, listFeatures } from './lib/common.mjs';

const { flags, positional, opt } = parseArgs(process.argv.slice(2),
  ['--from', '--to', '--mode', '--baseline', '--env']);
const flagVal = (name, dflt) => opt(name) ?? dflt;

// Voice-first order: TTS runs BEFORE record, so the recorder can pace each shot
// to its narration length (ShotTimer.holdForNarration) and the mux is a tight
// 'aligned' overlay instead of a freeze-frame guess.
const STAGES = ['generate', 'tts', 'record', 'mux', 'verify'];
const from = STAGES.indexOf(flagVal('--from', 'generate'));
const to = STAGES.indexOf(flagVal('--to', 'verify'));
const stageOn = (name) => {
  const idx = STAGES.indexOf(name);
  return idx >= from && idx <= to && !flags.has(`--skip-${name}`);
};

// ── Resolve the target feature set ──
let targets = [];
if (flags.has('--all') || flags.has('--stale')) {
  const all = listFeatures().map((f) => path.relative(repoRoot, f.dir).replace(/\\/g, '/'));
  if (flags.has('--stale')) {
    const cat = spawnSync('node', [engine('scripts', 'catalog.mjs'), '--stale', '--json'],
      { cwd: repoRoot, encoding: 'utf8' });
    let rows = [];
    try { rows = JSON.parse(cat.stdout); } catch { rows = []; }
    const actionable = new Set(
      rows.filter((r) =>
        r.spec !== 'OK' || !['OK', 'clone'].includes(r.recording) ||
        r.narration === 'STALE' || r.mp4 !== 'OK',
      ).map((r) => r.feature),
    );
    targets = all.filter((rel) => {
      const parts = rel.split('/'); // walkthroughs/<p>/modules/<m>/features/<f>
      return actionable.has(`${parts[1]}/${parts[3]}/${parts[5]}`);
    });
  } else {
    targets = all;
  }
} else if (positional.length === 1) {
  targets = [positional[0]];
} else {
  console.error('usage: produce-feature <feature-path> | --all | --stale [stage/passthrough flags]');
  process.exit(2);
}

if (targets.length === 0) {
  console.log('Nothing to produce (no matching features).');
  process.exit(0);
}

const py = venvPython();
if ((stageOn('tts') || stageOn('mux') || stageOn('verify')) && !py) {
  console.error(
    'error: TTS venv not found. Build it first:\n' +
      '  bash platform/tts/setup-tts.sh   (or: pwsh platform/tts/setup-tts.ps1 on Windows)\n' +
      '  or run with --to record to stop before the audio stages.',
  );
  process.exit(2);
}

/** Run one command, streaming output; return true on success. */
function step(label, cmd, args) {
  console.log(`\n\x1b[1m▶ ${label}\x1b[0m  ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd === 'npx',
  });
  if (r.status !== 0) console.error(`\x1b[31m✗ ${label} failed (exit ${r.status})\x1b[0m`);
  return r.status === 0;
}

const passRecord = ['--headed', '--allow-mutations', '--allow-edited-spec'].filter((f) => flags.has(f));
if (opt('--env')) passRecord.push('--env', opt('--env')); // recording environment (live | local | …)
const muxMode = flagVal('--mode', 'anchored'); // frame-anchored: voice lands on the real painted screen
const baseline = flagVal('--baseline', 'auto');

function produceOne(rel) {
  const featureDir = path.resolve(repoRoot, rel);
  if (!fs.existsSync(path.join(featureDir, 'feature.yaml'))) {
    console.error(`✗ ${rel}: no feature.yaml`);
    return false;
  }
  const feature = parse(fs.readFileSync(path.join(featureDir, 'feature.yaml'), 'utf8'));
  console.log(`\n\x1b[36m══ ${feature?.id ?? rel} (${rel}) ══\x1b[0m`);

  if (stageOn('generate') &&
      !step('generate', 'node', [engine('scripts', 'generate-feature.mjs'), rel])) return false;
  // TTS first: produces the clip durations the recorder paces each shot to.
  if (stageOn('tts') &&
      !step('tts', py, [engine('tts', 'generate.py'), '--dir', rel])) return false;
  if (stageOn('record') &&
      !step('record', 'node', [engine('scripts', 'record-feature.mjs'), rel, ...passRecord])) return false;
  if (stageOn('mux') &&
      !step('mux', py, [engine('tts', 'build_narrated.py'), '--dir', rel, '--mode', muxMode])) return false;
  if (stageOn('verify')) {
    const r = spawnSync(py, [engine('tts', 'verify_media.py'), '--dir', rel, '--baseline', baseline],
      { cwd: repoRoot, encoding: 'utf8' });
    process.stdout.write(r.stdout ?? '');
    if (r.stderr) process.stderr.write(r.stderr);
    let ok = false;
    try { ok = JSON.parse(r.stdout).ok === true; } catch { ok = false; }
    if (!ok) {
      console.error(`\x1b[31m✗ verify: media checks did not all pass for ${rel}\x1b[0m`);
      return false;
    }
    console.log(`\x1b[32m✓ verify: all mechanical checks passed\x1b[0m`);
  }
  return true;
}

const results = [];
for (const rel of targets) {
  const ok = produceOne(rel);
  results.push({ rel, ok });
  if (!ok && !flags.has('--continue-on-error') && targets.length > 1) {
    console.error(`\nHalting batch at ${rel} (pass --continue-on-error to keep going).`);
    break;
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n\x1b[1mProduced ${results.length - failed.length}/${targets.length} feature(s).\x1b[0m`);
for (const f of failed) console.log(`  \x1b[31m✗ ${f.rel}\x1b[0m`);
process.exit(failed.length ? 1 : 0);
