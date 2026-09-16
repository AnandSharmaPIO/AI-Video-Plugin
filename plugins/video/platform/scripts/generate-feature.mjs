#!/usr/bin/env node
/**
 * generate-feature — render a feature's walkthrough.spec.ts and narration.md
 * from its feature.yaml (the source of truth).
 *
 * Usage:
 *   node platform/scripts/generate-feature.mjs <feature-path> [--spec-only|--narration-only|--validate-only]
 *
 * feature.yaml is fully validated against platform/schemas/feature.schema.json
 * before anything is written; --validate-only stops after validation (used to
 * check drafts without generating artifacts).
 *
 * Editing model: change feature.yaml, re-run this, commit the regenerated
 * artifacts. The generated spec is reviewable output — hand edits to it will
 * be overwritten on the next generation.
 *
 * Shot bodies come from (in precedence order):
 *   custom:   verbatim TypeScript (for interactions the step language can't say)
 *   steps:    structured ops — {goto|click|glide|type|assertVisible|waitForURL|beat|installCursor}
 *             Locators: 'role:button:Sign In' | 'placeholder:Email' | 'label:Password'
 *                       | 'text:Foo' | 'text*:partial' | raw 'css=.selector'
 * A shot with guardExpr is wrapped in `if (<expr>) { mark; body } else { skip }`.
 */
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse, parseDocument } from 'yaml';
import { findUp } from '../engine/env.mjs';
import { repoRoot, pluginRoot, engine, parseArgs, sha1, featureContentHash } from './lib/common.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));

if (positional.length !== 1) {
  console.error('usage: generate-feature <feature-path> [--spec-only|--narration-only]');
  process.exit(2);
}

const featureDir = path.resolve(repoRoot, positional[0]);
const featureYaml = path.join(featureDir, 'feature.yaml');
if (!fs.existsSync(featureYaml)) {
  console.error(`error: no feature.yaml at ${featureYaml}`);
  process.exit(2);
}
const feature = parse(fs.readFileSync(featureYaml, 'utf8'));

/* ── Schema validation (deterministic — the model never checks conformance) ── */
const schemaPath = engine('schemas', 'feature.schema.json');
const ajv = new Ajv2020.default({ allErrors: true });
addFormats.default(ajv);
const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
if (!validate(feature)) {
  console.error(`error: feature.yaml violates ${path.relative(pluginRoot, schemaPath)}:`);
  for (const e of validate.errors) {
    console.error(`  ${e.instancePath || '(root)'}: ${e.message}`);
  }
  process.exit(2);
}
/* ── Semantic checks the JSON Schema can't express ──────────────────────── */
// Duplicate shot numbers silently collapse at every downstream stage
// (narration parse, ShotTimer, mux) — refuse them here.
{
  const seen = new Set();
  for (const s of feature.shots) {
    if (seen.has(s.n)) {
      console.error(`error: duplicate shot n=${s.n} — shot numbers must be unique`);
      process.exit(2);
    }
    seen.add(s.n);
  }
}

// dataSafety.stopBefore of the form '<op>:<value>' (e.g. 'click:Review Code')
// must not appear in the steps — a spec that performs its own stop-rule is a
// silent mutation. Free-text stopBefore rules are documentation only.
if (!feature.dataSafety?.mutates && feature.dataSafety?.stopBefore) {
  const m = /^(\w+):(.+)$/.exec(feature.dataSafety.stopBefore.trim());
  if (m) {
    const [, stopOp, stopValue] = m;
    for (const shot of feature.shots) {
      for (const step of shot.steps ?? []) {
        const op = Object.keys(step)[0];
        const v = step[op];
        const target = typeof v === 'string' ? v : v?.locator ?? '';
        if (op === stopOp && String(target).toLowerCase().includes(stopValue.trim().toLowerCase())) {
          console.error(
            `error: shot ${shot.n} performs '${op}:${target}' but dataSafety.stopBefore ` +
              `says the spec must stop before '${feature.dataSafety.stopBefore}' ` +
              `(and dataSafety.mutates is not true). Remove the step or declare mutates: true.`,
          );
          process.exit(2);
        }
      }
    }
  }
}

// NOTE: --validate-only also dry-runs the renderers (so unknown step ops / bad
// locators fail at validation, not on the next real generation). That happens
// after the render functions are defined — see the end of this file.

/* ── Locator mini-language ──────────────────────────────────────────────── */
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function locator(expr) {
  if (typeof expr !== 'string') throw new Error(`locator must be a string: ${JSON.stringify(expr)}`);
  if (expr.startsWith('css=')) return `page.locator(${q(expr.slice(4))})`;
  const [kind, ...rest] = expr.split(':');
  const value = rest.join(':');
  switch (kind) {
    // 'role' matches the accessible name exactly; 'role*' is a substring,
    // case-insensitive match — use for icon-buttons (e.g. antd prefixes the
    // icon's aria-label: accessible name is "plus Add New User").
    case 'role':
    case 'role*': {
      const idx = value.indexOf(':');
      if (idx === -1) return `page.getByRole(${q(value)})`;
      const role = value.slice(0, idx);
      const name = value.slice(idx + 1);
      const exact = kind === 'role' ? ', exact: true' : '';
      return `page.getByRole(${q(role)}, { name: ${q(name)}${exact} })`;
    }
    case 'placeholder': return `page.getByPlaceholder(${q(value)})`;
    case 'label': return `page.getByLabel(${q(value)})`;
    case 'text': return `page.getByText(${q(value)}, { exact: true })`;
    case 'text*': return `page.getByText(${q(value)})`;
    case 'heading': return `page.getByRole('heading', { name: ${q(value)} })`;
    default: throw new Error(`unknown locator kind '${kind}' in '${expr}'`);
  }
}

/* ── Step ops → TypeScript lines ────────────────────────────────────────── */
function stepLines(step, shotN) {
  const op = Object.keys(step)[0];
  const v = step[op];
  switch (op) {
    case 'goto':
      return [`await page.goto(${q(v)});`, `await installCursor(page);`];
    case 'installCursor':
      return [`await installCursor(page);`];
    case 'click':
      return [`await moveAndClick(page, ${locator(typeof v === 'string' ? v : v.locator)});`];
    case 'glide':
      return [`await glideTo(page, ${locator(typeof v === 'string' ? v : v.locator)});`];
    case 'scroll':
      // Smoothly scroll a below-the-fold element into view (reveals long-page
      // content). Cursor is fixed-position so it stays visible while scrolling.
      return [`await scrollToLocator(page, ${locator(typeof v === 'string' ? v : v.locator)});`];
    case 'type': {
      const loc = locator(v.locator);
      const text = v.env ? `requiredEnv(${q(v.env)})` : q(v.text);
      const delay = v.delay ?? 55;
      return [
        `{`,
        `  const field = ${loc};`,
        `  await glideTo(page, field);`,
        `  await field.click();`,
        `  await field.pressSequentially(${text}, { delay: ${delay} });`,
        `}`,
      ];
    }
    case 'assertVisible': {
      const opts = typeof v === 'object' && v.timeout ? `{ timeout: ${v.timeout} }` : '';
      return [`await expect(${locator(typeof v === 'string' ? v : v.locator)}).toBeVisible(${opts});`];
    }
    case 'waitForURL': {
      const timeout = typeof v === 'object' && v.timeout ? v.timeout : 30_000;
      const pat = typeof v === 'string' ? v : v.pattern;
      return [`await page.waitForURL(${q(pat)}, { timeout: ${timeout} });`, `await installCursor(page);`];
    }
    case 'beat':
      return [`await beat(page, ${Number(v) || 1600});`];
    default:
      throw new Error(`unknown step op '${op}' in shot ${shotN}`);
  }
}

/* ── Spec assembly ──────────────────────────────────────────────────────── */
const indent = (lines, pad) => lines.map((l) => (l ? pad + l : l));

// Steps that only get the shot to the right screen (silent lead-in) vs. steps
// that ARE the demonstrated action. The voice anchor (mark) goes between them.
const ACTION_OPS = new Set(['click', 'glide', 'type', 'scroll']);

/**
 * Body for a steps-shot with the voice anchor placed correctly:
 *   <arrival steps>          goto / waitForURL / assertVisible / leading beats —
 *                            navigate + settle SILENTLY (no voice yet)
 *   timer.mark(n)            voice anchor — the narrated screen is now on-screen
 *   <action steps>           the click/glide/type the narration describes, so the
 *                            voice plays WHILE the cursor performs the action
 *   holdForNarration(n)      dwell until the voice finishes
 *
 * This fixes voice-over-blank-page and voice-leads-the-action: the clip is
 * anchored to when the thing being narrated is actually visible, not to the
 * shot's code-start. If a shot has no action step (pure navigation/assert), the
 * mark goes after all its steps so the voice plays over the arrived screen.
 */
function stepsShotBody(shot) {
  const steps = shot.steps;
  const firstAction = steps.findIndex((s) => ACTION_OPS.has(Object.keys(s)[0]));
  const arrival = firstAction === -1 ? steps : steps.slice(0, firstAction);
  const action = firstAction === -1 ? [] : steps.slice(firstAction);
  const lines = [];
  arrival.forEach((s) => lines.push(...stepLines(s, shot.n)));
  // markVisual waits for the screen to paint, records the wall-clock hint, AND
  // screenshots the settled screen — the mux matches that shot to its real frame.
  lines.push(`await timer.markVisual(page, FEATURE_DIR, ${shot.n}); // voice anchor — capture the painted screen`);
  action.forEach((s) => lines.push(...stepLines(s, shot.n)));
  lines.push(`await timer.holdForNarration(page, FEATURE_DIR, ${shot.n}, ${shot.holdMs ?? 2200});`);
  return lines;
}

function renderShot(shot) {
  const banner = `/* ══ Shot ${shot.n}: ${shot.title} ${'═'.repeat(Math.max(2, 52 - String(shot.title).length))} */`;
  let body;
  if (shot.custom) {
    // Custom shots pace themselves — capture the anchor at the top (author's control).
    body = [`await timer.markVisual(page, FEATURE_DIR, ${shot.n});`, ...shot.custom.replace(/\s+$/, '').split('\n')];
  } else if (Array.isArray(shot.steps)) {
    body = stepsShotBody(shot); // mark is placed INSIDE, after the arrival steps
  } else {
    throw new Error(`shot ${shot.n} ('${shot.title}') has neither custom nor steps`);
  }
  if (shot.guardExpr) {
    return [
      banner,
      `if (${shot.guardExpr}) {`,
      ...indent(body, '  '),
      `} else {`,
      `  console.log('[walkthrough] shot ${shot.n} guard failed — skipping');`,
      `}`,
    ];
  }
  return [banner, ...body];
}

function renderSpec() {
  // Credential env names come from the nearest project.yaml (auth.credentialsEnv);
  // a project without auth gets no credential constants (public walkthroughs).
  const projectFile = findUp('project.yaml', featureDir);
  const project = projectFile ? parse(fs.readFileSync(projectFile, 'utf8')) : null;
  const [emailEnv, passwordEnv] = project?.auth?.credentialsEnv ?? [];
  const credentials = project?.auth
    ? `const EMAIL = requiredEnv(${q(emailEnv ?? 'WALKTHROUGH_EMAIL')});\n` +
      `const PASSWORD = requiredEnv(${q(passwordEnv ?? 'WALKTHROUGH_PASSWORD')});\n`
    : '';

  const constants = Object.entries(feature.constants ?? {})
    .map(([k, v]) => `const ${k} = ${q(v)};`)
    .join('\n');

  const shots = [...feature.shots].sort((a, b) => a.n - b.n);
  const shotBlocks = shots.map((s) => indent(renderShot(s), '  ').join('\n')).join('\n\n');

  // Import scrollToLocator ONLY when a shot uses it, so adding the feature didn't
  // churn every existing spec's hash (which would falsely flag them as stale).
  const usesScroll = shots.some((s) => Array.isArray(s.steps) && s.steps.some((st) => 'scroll' in st));
  const cursorImports = ['installCursor', 'resetCursor', 'glideTo',
    ...(usesScroll ? ['scrollToLocator'] : []), 'moveAndClick'].join(', ');

  // A fixed 5-minute cap leaves almost no slack once a feature has many/long
  // shots (narration alone can approach it) — scale with shot count instead,
  // never below the existing 5-minute floor so short features are unaffected.
  const testTimeoutMs = Math.max(5 * 60 * 1000, shots.length * 15000 + 60000);

  return `import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ${cursorImports} } from '@engine/cursor';
import {
  beat,
  loadEnvChain,
  requiredEnv,
  ShotTimer,
  promoteRecording,
} from '@engine/walkthrough';

/**
 * GENERATED from feature.yaml — do not edit by hand.
 * Change feature.yaml, then re-run:
 *   node platform/scripts/generate-feature.mjs <this feature's path>
 *
 * ${feature.name ?? feature.id} (${feature.module}/${feature.id})
 * Shot list and narration: feature.yaml + narration.md (same numbers).
 * feature-content-hash: ${featureContentHash(feature)}
 */

const FEATURE_DIR = path.dirname(fileURLToPath(import.meta.url));

loadEnvChain(FEATURE_DIR);
${credentials}${constants ? '\n/* Non-secret demo constants (feature.yaml → constants) */\n' + constants + '\n' : ''}
const timer = new ShotTimer();
let bodyCompleted = false;

test('feature walkthrough', async ({ page }) => {
  test.setTimeout(${testTimeoutMs});
  resetCursor();
  timer.start(); // t0 ≈ first frame of the recording

${shotBlocks}

  timer.save(FEATURE_DIR);
  bodyCompleted = true;
});

test.afterAll(async () => {
  if (!bodyCompleted) {
    // A failed run must not clobber the previous good recording — its
    // shot-timings.json was never rewritten, so promoting would desync them.
    console.log('[walkthrough] run failed — keeping the previous recording (nothing promoted)');
    return;
  }
  promoteRecording(FEATURE_DIR);
});
`;
}

function renderNarration() {
  const shots = [...feature.shots].sort((a, b) => a.n - b.n);
  const blocks = shots
    .map((s) => `## Shot ${s.n} — ${s.title}\n\n> ${String(s.narration).replace(/\s+/g, ' ').trim()}`)
    .join('\n\n');
  return `# ${feature.name ?? feature.id} — Walkthrough Narration

<!-- feature-content-hash: ${featureContentHash(feature)} -->

GENERATED from feature.yaml — do not edit by hand; change the \`narration\` fields
in feature.yaml and re-run generate-feature. One \`>\` block per shot; the TTS
toolkit turns each block into a per-shot audio clip.

**Voice:** warm, confident, product-demo.

${blocks}
`;
}

/* ── --validate-only: render in-memory to surface render errors, then stop ── */
if (flags.has('--validate-only')) {
  try {
    renderSpec();
    renderNarration();
  } catch (e) {
    console.error(`error: feature.yaml passed schema validation but fails to render: ${e.message}`);
    process.exit(2);
  }
  console.log(`✓ ${path.relative(repoRoot, featureYaml)} is valid (${feature.shots.length} shots)`);
  process.exit(0);
}

/* ── Write outputs ──────────────────────────────────────────────────────── */
let wrote = [];
const specPath = path.join(featureDir, 'walkthrough.spec.ts');
if (!flags.has('--narration-only')) {
  fs.writeFileSync(specPath, renderSpec());
  wrote.push('walkthrough.spec.ts');
}
if (!flags.has('--spec-only')) {
  fs.writeFileSync(path.join(featureDir, 'narration.md'), renderNarration());
  wrote.push('narration.md');
}

// Stamp the hash of the spec we just generated into feature.yaml. record-feature
// compares the on-disk spec against this to refuse recording a hand-edited spec
// (specs are generated output — edits belong in feature.yaml). Skipped for
// partial (--spec-only/--narration-only) runs where the pair may be inconsistent.
if (!flags.has('--spec-only') && !flags.has('--narration-only') && fs.existsSync(specPath)) {
  const doc = parseDocument(fs.readFileSync(featureYaml, 'utf8'));
  doc.setIn(['status', 'generatedSpecHash'], sha1(fs.readFileSync(specPath, 'utf8')));
  doc.setIn(['status', 'contentHash'], featureContentHash(feature));
  fs.writeFileSync(featureYaml, doc.toString());
}

console.log(`✓ generated ${wrote.join(' + ')} for ${feature.module}/${feature.id} (${feature.shots.length} shots)`);

/* ── Quality lints (WARN only — never block generation) ────────────────────
 * Mechanize two gates the skills otherwise leave to a human: narration must be
 * business language (never implementation internals) and the shots should cover
 * the page's control inventory. Heuristic, so they hint — they don't fail.     */
function lintNarration(feat) {
  // Implementation terms a user-facing demo must never say (CLAUDE.md: videos
  // never explain internals). Curated to avoid common-word false positives.
  const JARGON = /\b(class(es)?|method|function|endpoint|database|sql|schema|backend|frontend|middleware|repository|controller|payload|json|https?|localhost|async|await|webhook|\bapi\b|npm|git)\b/i;
  const warns = [];
  for (const s of feat.shots ?? []) {
    const n = String(s.narration ?? '').replace(/\s+/g, ' ').trim();
    if (!n) { warns.push(`shot ${s.n}: empty narration`); continue; }
    const m = n.match(JARGON);
    if (m) warns.push(`shot ${s.n}: implementation term "${m[0]}" — videos explain what users see, not internals`);
    const words = n.split(/\s+/).length;
    if (words > 42) warns.push(`shot ${s.n}: narration is long (${words} words) — keep it one action per line`);
  }
  return warns;
}

function lintCoverage(feat, dir) {
  const appMapPath = findUp('project-overview/app-map.yaml', dir);
  if (!appMapPath) return []; // no inventory to check against — skip quietly
  let appMap;
  try { appMap = parse(fs.readFileSync(appMapPath, 'utf8')); } catch { return []; }
  const module = (appMap?.modules ?? []).find((m) => m.id === feat.module);
  if (!module?.pages?.length) return [];
  // Pick the page whose id/name/route best matches this feature id.
  const toks = feat.id.split(/[-_]/).filter(Boolean);
  let page = null, best = -1;
  for (const p of module.pages) {
    const hay = `${p.id ?? ''} ${p.name ?? ''} ${p.route ?? ''}`.toLowerCase();
    const score = toks.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    if (score > best) { best = score; page = p; }
  }
  // Candidate control labels from the page's keyElements (heuristic extraction).
  const labels = new Set();
  const add = (s) => { s = String(s).trim().replace(/\s+/g, ' '); if (s.length >= 2 && s.length <= 40) labels.add(s); };
  for (const raw of page.keyElements ?? []) {
    const el = String(raw);
    for (const m of el.matchAll(/['"]([^'"]{2,40})['"]/g)) add(m[1]);
    for (const m of el.matchAll(/([A-Za-z][\w& ]*?)\s+(?:button|link|tab|action|box|field|dropdown|menu|checkbox|toggle|selector|icon)\b/gi)) add(m[1]);
    const list = el.match(/(?:columns?|actions?|fields?)\s*:\s*(.+)$/i);
    // Strip parenthetical asides BEFORE splitting, else an inner comma
    // ("Delete (trash, with confirm)") shreds the label.
    if (list) for (const part of list[1].replace(/\([^)]*\)/g, '').split(',')) add(part);
  }
  // Haystack = every shot's locators + narration + custom/guard text.
  const parts = [];
  for (const s of feat.shots ?? []) {
    parts.push(String(s.narration ?? ''), String(s.custom ?? ''), String(s.guardExpr ?? ''));
    for (const st of s.steps ?? []) for (const v of Object.values(st)) {
      if (typeof v === 'string') parts.push(v);
      else if (v && typeof v === 'object' && v.locator) parts.push(String(v.locator));
    }
  }
  const hay = parts.join(' \n ').toLowerCase();
  return [...labels].filter((l) => !hay.includes(l.toLowerCase()))
    .map((l) => `control not clearly demonstrated: "${l}" (from ${page.id ?? page.name})`);
}

const nWarn = lintNarration(feature);
const cWarn = lintCoverage(feature, featureDir);
if (nWarn.length || cWarn.length) {
  console.log('\n\x1b[33m⚠ quality lint (hints — not blocking):\x1b[0m');
  for (const w of nWarn) console.log(`  narration: ${w}`);
  for (const w of cWarn) console.log(`  coverage:  ${w}`);
  console.log('  (fix in feature.yaml, or accept if a hint is a false positive.)');
}
