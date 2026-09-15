#!/usr/bin/env node
/**
 * publish — copy finished narrated MP4s out of gitignored generated/ to a
 * durable home (a shared drive, an artifact dir), with a manifest. Media is
 * never committed, so without this step the deliverable lives only on the
 * machine that recorded it; this gives it somewhere to go.
 *
 * Destination (first that resolves):
 *   --dest <dir>                 CLI override
 *   WT_PUBLISH_DIR               env override
 *   project.yaml → publish.dest  per-project default
 *
 * Usage:
 *   node platform/scripts/publish.mjs <feature-path> [--dest <dir>]
 *   node platform/scripts/publish.mjs --all [--dest <dir>]
 *
 * Layout at the destination:
 *   <dest>/<project>/<module>/<feature>.mp4
 *   <dest>/manifest.json   (feature → {file, bytes, publishedAt, recordedAt, shots})
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { findUp } from '../engine/env.mjs';
import { repoRoot, parseArgs, listFeatures } from './lib/common.mjs';

const { flags, positional, opt } = parseArgs(process.argv.slice(2), ['--dest']);
const destFlag = opt('--dest') ?? null;

let targets;
if (flags.has('--all')) {
  targets = listFeatures();
} else if (positional.length === 1) {
  const dir = path.resolve(repoRoot, positional[0]);
  const parts = path.relative(path.join(repoRoot, 'walkthroughs'), dir).split(path.sep);
  targets = [{ project: parts[0], module: parts[2], feature: parts[4], dir,
              yamlPath: path.join(dir, 'feature.yaml') }];
} else {
  console.error('usage: publish <feature-path> | --all [--dest <dir>]');
  process.exit(2);
}

const stamp = new Date().toISOString();
let published = 0, skipped = 0;
const byDest = new Map(); // dest -> manifest rows

for (const t of targets) {
  const mp4 = path.join(t.dir, 'generated', 'walkthrough-narrated.mp4');
  if (!fs.existsSync(mp4)) {
    console.log(`  – skip ${t.project}/${t.module}/${t.feature}: no narrated MP4 (produce it first)`);
    skipped++;
    continue;
  }

  // Resolve destination for this feature's project.
  const projectFile = findUp('project.yaml', t.dir);
  const project = projectFile ? parse(fs.readFileSync(projectFile, 'utf8')) : null;
  const dest = destFlag || process.env.WT_PUBLISH_DIR || project?.publish?.dest;
  if (!dest) {
    console.error(
      `error: no publish destination for ${t.project} — pass --dest, set WT_PUBLISH_DIR, ` +
        'or add publish.dest to its project.yaml.',
    );
    process.exit(2);
  }
  const destRoot = path.resolve(repoRoot, dest);

  const outDir = path.join(destRoot, t.project, t.module);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${t.feature}.mp4`);
  fs.copyFileSync(mp4, outFile);

  const feature = fs.existsSync(t.yamlPath) ? parse(fs.readFileSync(t.yamlPath, 'utf8')) : {};
  const metaPath = path.join(t.dir, 'generated', 'record-meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  if (!byDest.has(destRoot)) byDest.set(destRoot, []);
  byDest.get(destRoot).push({
    feature: `${t.project}/${t.module}/${t.feature}`,
    file: path.relative(destRoot, outFile).replace(/\\/g, '/'),
    bytes: fs.statSync(outFile).size,
    publishedAt: stamp,
    recordedAt: feature?.status?.recordedAt ?? meta?.recordedAt ?? null,
    shots: feature?.shots?.length ?? (meta?.shots?.length ?? null),
  });
  console.log(`  ✓ ${t.project}/${t.module}/${t.feature} → ${outFile}`);
  published++;
}

// Merge each destination's manifest (idempotent per feature key).
for (const [destRoot, rows] of byDest) {
  const manifestPath = path.join(destRoot, 'manifest.json');
  let existing = [];
  if (fs.existsSync(manifestPath)) {
    try { existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { existing = []; }
  }
  const merged = new Map(existing.map((r) => [r.feature, r]));
  for (const r of rows) merged.set(r.feature, r);
  fs.writeFileSync(manifestPath,
    JSON.stringify([...merged.values()].sort((a, b) => a.feature.localeCompare(b.feature)), null, 2));
  console.log(`  manifest: ${manifestPath}`);
}

console.log(`\nPublished ${published} video(s); skipped ${skipped}.`);
process.exit(0);
