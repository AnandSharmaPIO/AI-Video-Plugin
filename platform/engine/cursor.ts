import type { Page, Locator } from '@playwright/test';
import { FRAME_GUTTER } from './env.mjs';

/**
 * Virtual cursor for headless screen recordings.
 *
 * Headless Chromium does not render the OS mouse pointer into the captured
 * video, and Playwright's `mouse.move`/`click` jump instantly — so a viewer
 * can't tell what's being pressed. This module injects a visible cursor into
 * the page and moves it smoothly (eased) to each target before clicking, with
 * a "pulse" ring on press. Every interaction should go through these helpers
 * so the cursor and the real Playwright input stay in lockstep.
 *
 * This file is 100% app-agnostic — do not edit it per project.
 */

/**
 * Tracks where the virtual cursor currently sits (page coordinates).
 * null = not placed yet; installCursor starts it at the viewport center,
 * whatever the project's configured viewport is.
 */
let cursorX: number | null = null;
let cursorY: number | null = null;

/**
 * Inject the cursor element + styles. Idempotent, and re-runs itself on every
 * SPA navigation via an init script so the cursor survives route changes.
 */
export async function installCursor(page: Page): Promise<void> {
  const inject = (gutter: number) => {
    if (document.getElementById('__wt_cursor__')) return;

    // The recorder captures `gutter` px TALLER than the delivered size. To make
    // the whole page (top bar AND bottom bar) fit within the delivered frame,
    // scale the page down vertically by exactly the gutter's share of the
    // capture height, then translate it down into the gutter. After the mux
    // crops the top gutter, the full app height is visible — nothing clipped at
    // either edge. f is derived from the live viewport height so it needs no
    // per-project tuning. ~1.8% vertical scale at 1080p — imperceptible.
    const vh = window.innerHeight || 0;
    const f = vh > gutter ? (vh - gutter) / vh : 1;

    const style = document.createElement('style');
    style.setAttribute('data-wt-cursor', '');
    style.textContent = `
      /* Framing gutter: shift + squeeze the whole page (INCLUDING the app's own
         position:fixed header/footer) so the top scan marker sits in a blank band
         above the app and the mux can crop it without clipping either bar.
         transform-origin top-left anchors the scale at the top; the translate then
         drops it into the gutter. The transform on <body> makes the app's fixed
         descendants relative to it (so they move too); the injected cursor/marker
         live on <html> (outside <body>), staying at true viewport coordinates so
         clicks remain pixel-accurate. */
      body {
        transform-origin: top left !important;
        transform: translateY(${gutter}px) scaleY(${f}) !important;
      }
      #__wt_cursor__ {
        position: fixed;
        top: 0; left: 0;
        width: 22px; height: 22px;
        margin-left: -11px; margin-top: -11px;
        border-radius: 9999px;
        background: rgba(99, 102, 241, 0.35);
        border: 2px solid rgba(79, 70, 229, 0.9);
        box-shadow: 0 2px 10px rgba(49, 46, 129, 0.45);
        pointer-events: none;
        z-index: 2147483647;
        /* Off-canvas until the first paintCursor places it (viewport-agnostic). */
        transform: translate(-40px, -40px);
        transition: none;
      }
      #__wt_cursor__::after {
        content: '';
        position: absolute;
        top: 50%; left: 50%;
        width: 5px; height: 5px;
        margin-left: -2.5px; margin-top: -2.5px;
        border-radius: 9999px;
        background: rgba(49, 46, 129, 0.95);
      }
      #__wt_cursor__.__wt_click__ {
        animation: __wt_pulse__ 420ms ease-out;
      }
      @keyframes __wt_pulse__ {
        0%   { box-shadow: 0 0 0 0 rgba(79,70,229,0.55); }
        100% { box-shadow: 0 0 0 22px rgba(79,70,229,0); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    const el = document.createElement('div');
    el.id = '__wt_cursor__';
    // Append to <html>, NOT <body>: the body is transformed by the gutter, and a
    // fixed child of a transformed element is positioned relative to that element
    // — the cursor must stay in true viewport coordinates to track the real mouse.
    document.documentElement.appendChild(el);
  };

  // Run now (current document) and on every future navigation.
  await page.addInitScript(inject, FRAME_GUTTER);
  await page.evaluate(inject, FRAME_GUTTER).catch(() => {});
  if (cursorX === null || cursorY === null) {
    const vp = page.viewportSize();
    cursorX = vp ? vp.width / 2 : 960;
    cursorY = vp ? vp.height / 2 : 540;
  }
  await moveCursorTo(page, cursorX, cursorY, 0);
}

/** Instantly place the DOM cursor at (x, y) — used internally by the easing loop. */
async function paintCursor(page: Page, x: number, y: number): Promise<void> {
  await page
    .evaluate(
      ([px, py]) => {
        const el = document.getElementById('__wt_cursor__');
        if (el) el.style.transform = `translate(${px}px, ${py}px)`;
      },
      [x, y] as [number, number],
    )
    .catch(() => {});
}

/** easeInOutCubic — soft acceleration and deceleration for a natural glide. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Smoothly move both the real Playwright mouse and the visible cursor from the
 * current position to (x, y) over `durationMs`.
 */
export async function moveCursorTo(
  page: Page,
  x: number,
  y: number,
  durationMs = 650,
): Promise<void> {
  const startX = cursorX ?? x;
  const startY = cursorY ?? y;
  const dist = Math.hypot(x - startX, y - startY);

  if (durationMs === 0 || dist < 1) {
    cursorX = x;
    cursorY = y;
    await page.mouse.move(x, y);
    await paintCursor(page, x, y);
    return;
  }

  // Step count scales a little with distance for consistent smoothness; ~60fps.
  const steps = Math.max(1, Math.min(90, Math.round(durationMs / 16)));
  const frame = durationMs / steps;

  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const nx = startX + (x - startX) * t;
    const ny = startY + (y - startY) * t;
    await page.mouse.move(nx, ny);
    await paintCursor(page, nx, ny);
    await page.waitForTimeout(frame);
  }
  cursorX = x;
  cursorY = y;
}

/** Center of a locator in page coordinates (accounts for scroll position). */
async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('glide target has no bounding box (not visible?)');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Glide the cursor to a locator's center (no click). */
export async function glideTo(
  page: Page,
  locator: Locator,
  durationMs = 650,
): Promise<void> {
  const { x, y } = await centerOf(locator);
  await moveCursorTo(page, x, y, durationMs);
}

/**
 * Smoothly scroll the page so a locator is centered in the viewport — for
 * revealing long-page content (cards/charts/tables below the fold) slowly, the
 * way a real user reads down a page. The virtual cursor is position:fixed so it
 * stays visible and in place while the content scrolls beneath it. Eased and
 * slow by default; a no-op if the element is already roughly centered.
 */
export async function scrollToLocator(
  page: Page,
  locator: Locator,
  durationMs = 900,
): Promise<void> {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return;
  const vh = page.viewportSize()?.height ?? 1080;
  const delta = box.y + box.height / 2 - vh / 2; // scroll so the element centers
  if (Math.abs(delta) < 8) return;
  const startY = await page.evaluate(() => window.scrollY);
  const steps = Math.max(1, Math.min(90, Math.round(durationMs / 16)));
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await page.evaluate((y) => window.scrollTo(0, y), startY + delta * t);
    await page.waitForTimeout(durationMs / steps);
  }
}

/** Play the click pulse on the cursor element. */
async function pulse(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const el = document.getElementById('__wt_cursor__');
      if (!el) return;
      el.classList.remove('__wt_click__');
      // Force reflow so the animation restarts even on repeated clicks.
      void el.offsetWidth;
      el.classList.add('__wt_click__');
    })
    .catch(() => {});
}

/**
 * Glide to a locator, pulse, then perform the real click. Put this inside a
 * Promise.all([...]) alongside a waitForResponse when the click triggers a
 * network request you need to await.
 */
export async function moveAndClick(
  page: Page,
  locator: Locator,
  opts: { durationMs?: number; settleMs?: number } = {},
): Promise<void> {
  const { durationMs = 650, settleMs = 260 } = opts;
  await glideTo(page, locator, durationMs);
  await page.waitForTimeout(settleMs); // brief hover so the viewer registers the target
  await pulse(page);
  await locator.click();
}

/**
 * Reset the tracked cursor position (call once per test if reused). With no
 * args, the next installCursor re-centers on the project's actual viewport.
 */
export function resetCursor(x?: number, y?: number): void {
  cursorX = x ?? null;
  cursorY = y ?? null;
}
