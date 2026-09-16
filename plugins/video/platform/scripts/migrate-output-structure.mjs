#!/usr/bin/env node
/**
 * migrate-output-structure — one-time upgrade for content authored under the
 * old layout (a fixed `walkthroughs/<project>/` wrapper, `knowledge/`) to the
 * current one (`<project>/` directly at the content root, `project-overview/`).
 *
 * Usage:
 *   node platform/scripts/migrate-output-structure.mjs            # dry run — prints the plan
 *   node platform/scripts/migrate-output-structure.mjs --apply    # actually perform it
 *
 * What it does, per project found under a top-level `walkthroughs/` folder:
 *   1. Moves `walkthroughs/<project>/` up to `<project>/` at the content root.
 *   2. Renames `<project>/knowledge/` to `<project>/project-overview/` if present.
 * Refuses (per project) if a same-named directory already exists at the
 * content root, rather than silently merging/overwriting.
 *
 * `generated/` folders are moved along with everything else (they're just
 * regular subdirectories), but nothing inside them needs renaming: media is
 * gitignored and fully regenerable — the next `/produce` run writes
 * `final-video.mp4` in place of any old `walkthrough-narrated.mp4` there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './lib/common.mjs';

const apply = process.argv.includes('--apply');
const oldRoot = path.join(repoRoot, 'walkthroughs');

if (!fs.existsSync(oldRoot)) {
  console.log('No walkthroughs/ folder found here — nothing to migrate.');
  process.exit(0);
}

const projects = fs.readdirSync(oldRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

if (projects.length === 0) {
  console.log('walkthroughs/ exists but is empty — nothing to migrate.');
  process.exit(0);
}

console.log(`${apply ? 'Applying' : 'Planning'} migration for ${projects.length} project(s):\n`);

let blocked = false;
for (const project of projects) {
  const src = path.join(oldRoot, project);
  const dest = path.join(repoRoot, project);
  if (fs.existsSync(dest)) {
    console.error(`  ✗ ${project}: refusing — "${dest}" already exists at the content root.`);
    blocked = true;
    continue;
  }
  console.log(`  ${project}: walkthroughs/${project}/  ->  ${project}/`);
  const knowledgeDir = path.join(src, 'knowledge');
  if (fs.existsSync(knowledgeDir)) {
    console.log(`    + rename knowledge/ -> project-overview/`);
  }
  if (apply) {
    fs.renameSync(src, dest);
    const movedKnowledge = path.join(dest, 'knowledge');
    if (fs.existsSync(movedKnowledge)) {
      fs.renameSync(movedKnowledge, path.join(dest, 'project-overview'));
    }
  }
}

if (blocked) {
  console.error('\nOne or more projects were skipped — resolve the conflicts above and re-run.');
  process.exit(1);
}

if (apply) {
  // Remove the now-empty wrapper folder (only if every project moved cleanly).
  if (fs.readdirSync(oldRoot).length === 0) fs.rmdirSync(oldRoot);
  console.log('\nDone. Run /catalog to confirm every feature is discovered, then');
  console.log('/produce --stale to regenerate media as final-video.mp4.');
} else {
  console.log('\nDry run only — nothing was changed. Re-run with --apply to perform the move.');
}
