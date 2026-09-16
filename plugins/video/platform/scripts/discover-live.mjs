#!/usr/bin/env node
/**
 * discover-live — crawl a running web app and capture user-facing structure
 * for walkthrough planning. Generic: everything app-specific comes from the
 * project's project.yaml (+ .env credentials).
 *
 * Usage:
 *   node platform/scripts/discover-live.mjs <id> [--headed] [--max-pages N]
 *
 * Output: <id>/project-overview/discovery-raw.json — per page: url, headings,
 * buttons, tabs, placeholders, empty-state text, nav structure. READ-ONLY by
 * design: it only clicks navigation (menus/links), never forms or action buttons.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { chromium } from 'playwright';
import { loadEnvChain } from '../engine/env.mjs';
import { repoRoot, parseArgs } from './lib/common.mjs';

const args = process.argv.slice(2);
const { flags, positional } = parseArgs(args);
const maxPagesAt = args.indexOf('--max-pages');
const maxPages = maxPagesAt === -1 ? 40 : Number(args[maxPagesAt + 1]) || 40;

if (positional.length !== 1) {
  console.error('usage: discover-live <project-path> [--headed] [--max-pages N]');
  process.exit(2);
}
const projectDir = path.resolve(repoRoot, positional[0]);
const projectFile = path.join(projectDir, 'project.yaml');
if (!fs.existsSync(projectFile)) {
  console.error(`error: no project.yaml at ${projectFile}`);
  process.exit(2);
}
const project = parse(fs.readFileSync(projectFile, 'utf8'));

loadEnvChain(projectDir); // credentials from .env (project -> repo root; existing env wins)
const [userEnv, passEnv] = project.auth?.credentialsEnv ?? [];
const USER = userEnv ? process.env[userEnv] : undefined;
const PASS = passEnv ? process.env[passEnv] : undefined;

/** Capture one page's user-facing facts. */
async function snapshotPage(page) {
  return await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const texts = (sel, limit = 20) =>
      [...document.querySelectorAll(sel)]
        .filter(vis)
        .map((e) => e.textContent.trim().replace(/\s+/g, ' '))
        .filter((t) => t && t.length < 120)
        .slice(0, limit);
    return {
      url: location.pathname + location.search,
      title: document.title,
      headings: texts('h1, h2, h3', 15),
      buttons: texts('button, [role="button"]', 15),
      tabs: texts('[role="tab"]', 12),
      links: texts('a[href^="/"]', 15),
      placeholders: [...document.querySelectorAll('input[placeholder], textarea[placeholder]')]
        .filter(vis)
        .map((e) => e.placeholder)
        .slice(0, 10),
      emptyStates: texts('*', 400).filter((t) => /^no .{2,40}(found|available|data)|nothing to (show|display)/i.test(t)).slice(0, 5),
      hasTable: !!document.querySelector('table, [role="grid"]'),
      chartCount: document.querySelectorAll('canvas, .recharts-wrapper, svg[class*="chart" i]').length,
      comboboxes: document.querySelectorAll('[role="combobox"]').length,
    };
  });
}

/** Give a freshly navigated SPA page a moment to render (bounded, not fixed). */
async function settle(page, capMs = 2200) {
  await page.waitForLoadState('networkidle', { timeout: capMs }).catch(() => {});
  await page.waitForTimeout(400);
}

const result = { project: project.id, baseUrl: project.baseUrl, crawledAt: new Date().toISOString(), nav: [], pages: [] };
const seen = new Set();

const browser = await chromium.launch({
  headless: !flags.has('--headed'),
  ...(project.video?.channel ? { channel: project.video.channel } : {}),
});
const page = await browser.newPage({ viewport: project.video?.viewport ?? { width: 1920, height: 1080 } });
page.setDefaultTimeout(15_000);

try {
  /* ── Login (generic heuristics; skipped if no auth in project.yaml) ────── */
  if (project.auth?.loginPath) {
    if (!USER || !PASS) throw new Error(`credentials missing: set ${userEnv}/${passEnv} in ${positional[0]}/.env`);
    console.log('▶ logging in…');
    await page.goto(project.baseUrl + project.auth.loginPath);
    // SPA: the form renders client-side — wait for any input before probing.
    await page.waitForSelector('input', { timeout: 30_000 });
    // Resolve to actual <input> elements only — aria-labels on icons (e.g. antd's
    // user icon) must never win. Try candidates in priority order.
    const firstInput = async (candidates, what) => {
      for (const loc of candidates) if (await loc.count()) return loc.first();
      throw new Error(`login: no ${what} input found on ${project.auth.loginPath}`);
    };
    // project.yaml may pin exact selectors (auth.selectors: {user, pass, submit})
    // for apps the generic heuristics can't guess (non-English UI, custom forms).
    const sel = project.auth.selectors ?? {};
    const userField = await firstInput(
      [
        ...(sel.user ? [page.locator(sel.user)] : []),
        page.getByPlaceholder(/email|user/i),
        page.locator('input[type="email"]'),
        page.locator('input[name*="email" i], input[name*="user" i]'),
      ],
      'username/email',
    );
    const passField = await firstInput(
      [...(sel.pass ? [page.locator(sel.pass)] : []), page.getByPlaceholder(/password/i), page.locator('input[type="password"]')],
      'password',
    );
    await userField.fill(USER);
    await passField.fill(PASS);
    const submit = sel.submit
      ? page.locator(sel.submit)
      : page.getByRole('button', { name: /sign in|log ?in|submit/i });
    await submit.first().click();
    // Logged in = we left the configured login route.
    const loginPath = project.auth.loginPath;
    await page.waitForURL((u) => u.pathname !== loginPath, { timeout: 60_000 });
    await settle(page, 2500);
    console.log(`  ✓ landed on ${page.url()}`);
  } else {
    await page.goto(project.baseUrl);
  }

  const recordHere = async (via) => {
    const snap = await snapshotPage(page);
    if (seen.has(snap.url)) return;
    seen.add(snap.url);
    result.pages.push({ via, ...snap });
    console.log(`  • ${snap.url}  (${snap.headings[0] ?? snap.title})`);
  };
  await recordHere('post-login landing');

  /* ── Expand every collapsed submenu (repeat until none left) ───────────── */
  for (let round = 0; round < 10; round++) {
    const collapsed = page.locator('[role="menuitem"][aria-expanded="false"]');
    const n = await collapsed.count();
    if (!n) break;
    try {
      await collapsed.first().click({ timeout: 5000 });
      await page.waitForTimeout(700);
    } catch { break; }
  }

  /* ── Harvest the nav tree + every in-app route, then visit each route ──── */
  // Submenu container: nested [role="menu"] is the ARIA-standard shape; a
  // project can override for frameworks that don't nest their popups that way
  // (project.yaml discovery.submenuSelector).
  const submenuSelector = project.discovery?.submenuSelector ?? '[role="menu"] [role="menu"], .ant-menu-sub';
  result.nav = await page.evaluate((subSel) => {
    const items = [...document.querySelectorAll('nav a[href], aside a[href], [role="menu"] a[href], li[role="menuitem"]')];
    const seen = new Set();
    return items
      .map((e) => {
        const a = e.tagName === 'A' ? e : e.querySelector('a[href]');
        const label = e.textContent.trim().replace(/\s+/g, ' ');
        const href = a?.getAttribute('href') ?? null;
        const parent = e.closest(subSel)?.closest('li')?.querySelector(':scope > [role="menuitem"], :scope > div')?.textContent.trim().replace(/\s+/g, ' ') ?? null;
        return { label, href, parent };
      })
      .filter((m) => m.label && m.label.length < 60 && !(seen.has(m.label + m.href) || seen.add(m.label + m.href) === false));
  }, submenuSelector);
  const routes = [...new Set(result.nav.map((m) => m.href).filter((h) => h && h.startsWith('/')))];
  console.log(`▶ nav: ${result.nav.length} entries, ${routes.length} routes: ${routes.join(' ')}`);

  for (const route of routes.slice(0, maxPages)) {
    if (seen.has(route)) continue;
    try {
      await page.goto(project.baseUrl + route, { timeout: 30_000 });
      await settle(page);
      const label = result.nav.find((m) => m.href === route);
      await recordHere(label ? `${label.parent ? label.parent + ' → ' : ''}${label.label}` : route);
    } catch { console.log(`  (skip ${route})`); }
  }
} finally {
  await browser.close();
}

const out = path.join(projectDir, 'project-overview', 'discovery-raw.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`\n✅ ${result.pages.length} pages captured -> ${path.relative(repoRoot, out)}`);
