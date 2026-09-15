#!/usr/bin/env node
/**
 * journey — stitch already-produced feature videos into ONE end-to-end
 * walkthrough. Reuses each feature's generated/walkthrough-narrated.mp4 (nothing
 * is re-recorded), trims per-segment via the feature's shot-timings-narrated.json
 * (fromShot/toShot), and concatenates into journeys/<id>/generated/journey.mp4.
 *
 * Usage:
 *   node platform/scripts/journey.mjs walkthroughs/<p>/journeys/<id> [flags]
 *     --produce-missing        produce any segment feature that is missing/stale first
 *     --env <name>             environment for --produce-missing (live | local | …)
 *     --allow-mutations        pass through to --produce-missing (needed for mutating features)
 *     --out <path>             override output MP4 path
 *
 * This file is generic — never edit it per project or feature.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { repoRoot, engine, parseArgs, venvPython } from './lib/common.mjs';

const LEAD = 0.35; // matches build_narrated LEAD: a shot's visual starts ~this
                   // much before its audio, so cut here to include the shot cleanly.

const { flags, positional, opt } = parseArgs(process.argv.slice(2), ['--env', '--out']);
if (positional.length !== 1) {
  console.error('usage: journey <walkthroughs/<p>/journeys/<id>> [--produce-missing --env <e> --allow-mutations --out <mp4>]');
  process.exit(2);
}

const journeyDir = path.resolve(repoRoot, positional[0]);
const journeyFile = path.join(journeyDir, 'journey.yaml');
if (!fs.existsSync(journeyFile)) {
  console.error(`✗ no journey.yaml at ${path.relative(repoRoot, journeyDir)}`);
  process.exit(2);
}

// Derive the project from the path: walkthroughs/<project>/journeys/<id>.
const relParts = path.relative(repoRoot, journeyDir).replace(/\\/g, '/').split('/');
if (relParts[0] !== 'walkthroughs' || relParts[2] !== 'journeys') {
  console.error(`✗ journey must live at walkthroughs/<project>/journeys/<id> (got ${relParts.join('/')})`);
  process.exit(2);
}
const project = relParts[1];

const journey = parse(fs.readFileSync(journeyFile, 'utf8'));
// ── Light validation (schema documents the full contract) ──
const errs = [];
if (!journey?.id) errs.push('missing id');
if (!journey?.name) errs.push('missing name');
if (!Array.isArray(journey?.segments) || journey.segments.length === 0) errs.push('missing segments[]');
for (const [i, s] of (journey.segments ?? []).entries()) {
  if (!s?.feature || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(s.feature)) errs.push(`segment ${i}: feature must be "<module>/<feature>"`);
}
if (errs.length) { console.error('✗ journey.yaml invalid:\n  - ' + errs.join('\n  - ')); process.exit(2); }

const py = venvPython();
if (!py) { console.error('✗ TTS venv not found (build_journey uses its ffmpeg). Build it: bash platform/tts/setup-tts.sh'); process.exit(2); }

// ── Catalog status → is each segment feature produced + fresh? ──
function catalogStatus() {
  const r = spawnSync('node', [engine('scripts', 'catalog.mjs'), '--json'], { cwd: repoRoot, encoding: 'utf8' });
  try { return new Map(JSON.parse(r.stdout).map((row) => [row.feature, row])); } catch { return new Map(); }
}

const passRecord = ['--allow-mutations'].filter((f) => flags.has(f));
if (opt('--env')) passRecord.push('--env', opt('--env'));

function ensureReady(seg) {
  const [mod, feat] = seg.feature.split('/');
  const featureRel = `walkthroughs/${project}/modules/${mod}/features/${feat}`;
  const featureDir = path.resolve(repoRoot, featureRel);
  const key = `${project}/${seg.feature}`;
  const ready = () => catalogStatus().get(key)?.mp4 === 'OK'
    && fs.existsSync(path.join(featureDir, 'generated', 'walkthrough-narrated.mp4'));
  if (ready()) return { featureDir, ok: true };
  if (!flags.has('--produce-missing')) return { featureDir, ok: false };
  console.log(`\n▶ producing missing/stale segment: ${seg.feature}`);
  const r = spawnSync('node', [engine('scripts', 'produce-feature.mjs'), featureRel, ...passRecord],
    { cwd: repoRoot, stdio: 'inherit' });
  return { featureDir, ok: r.status === 0 && ready() };
}

// ── Resolve every segment, produce if asked, else collect blockers ──
const notReady = [];
const resolved = [];
for (const seg of journey.segments) {
  const { featureDir, ok } = ensureReady(seg);
  if (!ok) { notReady.push(seg.feature); continue; }
  resolved.push({ seg, featureDir });
}
if (notReady.length) {
  console.error(`\n✗ these segments are not produced/fresh:\n  - ${notReady.join('\n  - ')}\n` +
    '  Produce them first (npm run produce -- <feature>), or re-run with --produce-missing.');
  process.exit(1);
}

// ── Compute each segment's trim window from its narrated timings ──
function windowFor({ seg, featureDir }) {
  const tf = path.join(featureDir, 'generated', 'shot-timings-narrated.json');
  const timings = JSON.parse(fs.readFileSync(tf, 'utf8')).sort((a, b) => a.shot - b.shot);
  let start = 0;
  if (seg.fromShot) {
    const t = timings.find((x) => x.shot >= seg.fromShot); // first recorded shot at/after
    start = t ? Math.max(0, t.start - LEAD) : 0;
  }
  let end = null;
  if (seg.toShot) {
    const nxt = timings.find((x) => x.shot > seg.toShot); // start of the shot after toShot
    end = nxt ? Math.max(start + 0.1, nxt.start - LEAD) : null;
  }
  return {
    mp4: path.join(featureDir, 'generated', 'walkthrough-narrated.mp4'),
    start, end, label: seg.feature,
  };
}
const plan = resolved.map(windowFor);

const genDir = path.join(journeyDir, 'generated');
fs.mkdirSync(genDir, { recursive: true });
const planFile = path.join(genDir, 'plan.json');
fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
const outMp4 = opt('--out') ? path.resolve(repoRoot, opt('--out')) : path.join(genDir, 'journey.mp4');

console.log(`\n\x1b[36m══ journey ${journey.id} — ${plan.length} segment(s) ══\x1b[0m`);
const r = spawnSync(py, [engine('tts', 'build_journey.py'), '--plan', planFile, '--out', outMp4],
  { cwd: repoRoot, stdio: 'inherit' });
if (r.status !== 0) { console.error('\x1b[31m✗ journey build failed\x1b[0m'); process.exit(1); }
console.log(`\n\x1b[32m✓ journey built -> ${path.relative(repoRoot, outMp4)}\x1b[0m`);
console.log('Media stays out of git — publish the final journey to shared storage.');
