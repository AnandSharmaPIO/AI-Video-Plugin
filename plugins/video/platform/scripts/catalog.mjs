#!/usr/bin/env node
/**
 * catalog — inventory + staleness report over every feature under the content root.
 *
 * Usage:
 *   node platform/scripts/catalog.mjs [--stale] [--json]
 *     --stale  only rows that need attention
 *     --json   machine-readable output (used by the produce orchestrator)
 *
 * Staleness is CONTENT-BASED, not mtime-based: git checkout does not preserve
 * mtimes, so the old `feature.yaml newer than spec` heuristic was meaningless
 * on a fresh clone. Instead we compare committed content hashes:
 *   - feature.yaml (minus status) hash        vs the hash embedded in the spec
 *   - the spec's on-disk hash                 vs status.generatedSpecHash
 * Both hashes live in committed files, so this is accurate from a clean clone.
 *
 * Per feature, each column is OK | MISSING/none | DESYNC/STALE:
 *   spec       generated spec present and matches feature.yaml + not hand-edited
 *   recording  a recording exists (from generated/, or per committed record-meta)
 *   narration  clip set matches the current narration.md content
 *   mp4        narrated MP4 exists and is newer than the recording + clips
 *
 * Recordings/clips/mp4 live in gitignored generated/, so a fresh clone reports
 * 'none' for those — that's accurate (media is rebuilt, not pulled) and the
 * committed hashes still tell you whether spec/narration are in sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  repoRoot,
  specHash,
  sha1,
  featureContentHash,
  embeddedContentHash,
  listFeatures,
} from './lib/common.mjs';

const staleOnly = process.argv.includes('--stale');
const asJson = process.argv.includes('--json');

/** Parse the `## Shot N` blocks from narration.md into {n: text} (mirror of generate.py). */
function parseNarrationShots(md) {
  const shots = {};
  const parts = md.split(/^##\s+Shot\s+(\d+)\b.*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    const body = parts[i + 1] ?? '';
    const quote = body
      .split('\n')
      .filter((l) => l.trimStart().startsWith('>'))
      .map((l) => l.replace(/^\s*>\s?/, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (quote) shots[n] = quote;
  }
  return shots;
}

const rows = [];
for (const { project, module: mod, feature: feat, dir, yamlPath } of listFeatures()) {
  const feature = parse(fs.readFileSync(yamlPath, 'utf8'));
  const specPath = path.join(dir, 'walkthrough.spec.ts');
  const narrationPath = path.join(dir, 'narration.md');
  const metaPath = path.join(dir, 'generated', 'record-meta.json');
  const webmPath = path.join(dir, 'generated', 'walkthrough.webm');
  const manifestPath = path.join(dir, 'generated', 'clips', 'manifest.json');
  const mp4Path = path.join(dir, 'generated', 'final-video.mp4');

  const contentHash = featureContentHash(feature);

  // ── spec: present + matches feature.yaml content + not hand-edited ──
  let spec = 'MISSING';
  if (fs.existsSync(specPath)) {
    const specText = fs.readFileSync(specPath, 'utf8');
    const embedded = embeddedContentHash(specText);
    if (embedded && embedded !== contentHash) spec = 'DESYNC';        // yaml changed since generate
    else if (feature?.status?.generatedSpecHash
             && feature.status.generatedSpecHash !== sha1(specText)) spec = 'EDITED'; // hand-edited spec
    else spec = 'OK';
  }

  // ── recording: prefer live media; fall back to committed record-meta so a
  //    fresh clone can still report "was recorded, media rebuildable". ──
  let recording = 'none';
  if (fs.existsSync(webmPath)) {
    recording = 'OK';
    if (fs.existsSync(metaPath) && fs.existsSync(specPath)) {
      const meta = readJson(metaPath);
      if (meta?.specHash && meta.specHash !== specHash(specPath)) recording = 'STALE';
    }
  } else if (feature?.status?.recordedAt && feature?.status?.specHash) {
    recording = fs.existsSync(specPath) && feature.status.specHash === specHash(specPath)
      ? 'clone' // recorded before; media not present in this checkout but rebuildable & current
      : 'STALE';
  }

  // ── narration: clip manifest matches current narration.md content ──
  let narration = 'none';
  if (fs.existsSync(narrationPath)) {
    const wantShots = parseNarrationShots(fs.readFileSync(narrationPath, 'utf8'));
    const wantHashes = Object.values(wantShots).map((t) => sha1(t));
    if (!fs.existsSync(manifestPath)) {
      narration = 'none';
    } else {
      const manifest = readJson(manifestPath) ?? [];
      const haveTexts = new Set(manifest.map((m) => sha1(m.text ?? '')));
      const missing = wantHashes.filter((h) => !haveTexts.has(h));
      const extra = manifest.length - (wantHashes.length - missing.length);
      narration = missing.length === 0 && extra <= 0 ? 'OK' : 'STALE';
    }
  }

  // ── mp4: exists and is newer than BOTH the recording and the clips ──
  let mp4 = 'none';
  if (fs.existsSync(mp4Path)) {
    const mp4Ms = fs.statSync(mp4Path).mtimeMs;
    const newerDep = [webmPath, manifestPath]
      .filter((p) => fs.existsSync(p))
      .some((p) => fs.statSync(p).mtimeMs > mp4Ms);
    mp4 = newerDep || narration === 'STALE' ? 'STALE' : 'OK';
  }

  rows.push({
    feature: `${project}/${mod}/${feat}`,
    shots: feature.shots?.length ?? 0,
    mutates: feature.dataSafety?.mutates ? 'YES' : 'no',
    spec,
    recording,
    narration,
    mp4,
  });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const actionable = (r) =>
  r.spec !== 'OK' ||                              // missing / desynced / hand-edited
  !['OK', 'clone'].includes(r.recording) ||      // no recording (or stale) in this checkout
  r.narration === 'STALE' ||                      // clips don't match narration.md
  r.mp4 === 'STALE' ||                            // final older than its inputs
  (r.recording === 'OK' && r.mp4 === 'none');    // recorded but never muxed here

const shown = staleOnly ? rows.filter(actionable) : rows;

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else if (rows.length === 0) {
  console.log('No features found — no project.yaml discovered under the current directory.');
} else if (shown.length === 0) {
  console.log(`All ${rows.length} feature(s) up to date.`);
} else {
  console.table(shown);
  const stale = rows.filter(actionable).length;
  console.log(`${rows.length} feature(s); ${stale} need attention.`);
  console.log(
    "Legend: spec EDITED = hand-edited spec; recording 'clone' = recorded elsewhere, " +
      'media rebuildable here; narration STALE = clips don’t match narration.md.',
  );
}
