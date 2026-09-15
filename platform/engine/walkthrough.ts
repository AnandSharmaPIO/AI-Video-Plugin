import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Generic walkthrough runtime shared by every feature spec.
 *
 * A feature spec only contains its shots; everything reusable lives here:
 *   - beat()            cosmetic pacing so a shot lingers for narration
 *   - loadEnvChain()    credentials from .env files (feature -> project -> repo root)
 *   - ShotTimer         real per-shot start times -> generated/shot-timings.json
 *   - promoteRecording  newest raw WebM -> generated/walkthrough.webm
 *
 * This file is 100% app-agnostic — never edit it per feature.
 */

/** Credentials from .env files (feature -> project -> repo root). */
export { loadEnvChain } from './env.mjs';

/** Cosmetic pause so a shot lingers on screen long enough to narrate over. */
export async function beat(page: Page, ms = 1600): Promise<void> {
  await page.waitForTimeout(ms);
}

// Must match build_narrated.py PAD — the recorder holds each shot for
// clip + HOLD_PAD, and the mux leaves the same gap after the clip, so the
// on-screen dwell and the audio window agree.
const HOLD_PAD_MS = 600;

/** Clip length (ms) for a shot from the TTS manifest, or null if not generated yet. */
function readClipDurationMs(featureDir: string, shot: number): number | null {
  try {
    const manifest = path.join(featureDir, 'generated', 'clips', 'manifest.json');
    const arr = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { shot: number; duration: number }[];
    const m = arr.find((x) => x.shot === shot);
    return m && typeof m.duration === 'number' ? m.duration * 1000 : null;
  } catch {
    return null;
  }
}

/** Read a required credential; fail fast with a pointer at .env.example. */
export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing credential: set ${name} in the environment or a .env file ` +
        `(feature, project, or repo root — see .env.example). Never hardcode secrets in specs.`,
    );
  }
  return v;
}

/**
 * Captures real per-shot start times. Playwright starts recording at context
 * creation (just before the first navigation), so call `start()` right before
 * the first `page.goto`, then `mark(N)` as the FIRST line of each shot. For
 * guarded shots, call `mark` INSIDE the `if (await x.count())` block so a
 * skipped shot is never marked (the TTS mux then drops its clip automatically).
 */
export class ShotTimer {
  private timings: { shot: number; start: number }[] = [];
  private markedAt = new Map<number, number>(); // shot -> Date.now() at mark
  private t0 = Date.now();

  /** Set t0 ≈ first frame of the recording. Call right before the first goto. */
  start(): void {
    this.t0 = Date.now();
  }

  mark(shot: number): void {
    const now = Date.now();
    const start = (now - this.t0) / 1000;
    this.timings.push({ shot, start: Number(start.toFixed(2)) });
    this.markedAt.set(shot, now);
    console.log(`[walkthrough] shot ${shot} @ ${start.toFixed(2)}s`);
  }

  /**
   * Anchor this shot BOTH in wall-clock (a hint) AND with a screenshot of what's
   * actually on screen. The mux later scans the recorded video for the frame that
   * matches this screenshot and places the voice THERE — so the clip lands on the
   * real painted screen, not on the wall-clock mark. That's the only thing robust
   * to a heavy SPA (DOM changes seconds before it paints) and Playwright's
   * variable-frame-rate screencast (wall-clock ≠ video PTS).
   *
   * Waits for the current screen to actually paint first (bounded networkidle +
   * two animation frames), so the anchor image is the settled screen.
   */
  async markVisual(page: Page, featureDir: string, shot: number): Promise<void> {
    // Let the SPA finish loading + painting the current screen.
    try {
      await page.waitForLoadState('networkidle', { timeout: 2500 });
    } catch {
      /* polling apps never go idle — bounded wait is enough */
    }
    try {
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
    } catch {
      /* evaluate can fail across a navigation — non-fatal */
    }
    const anchorsDir = path.join(featureDir, 'generated', 'anchors');
    if (this.timings.length === 0) {
      // Fresh run — drop stale anchors from a previous recording.
      try {
        fs.rmSync(anchorsDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    const now = Date.now();
    const start = (now - this.t0) / 1000;
    this.timings.push({ shot, start: Number(start.toFixed(2)) });
    this.markedAt.set(shot, now);
    try {
      fs.mkdirSync(anchorsDir, { recursive: true });
      await page.screenshot({ path: path.join(anchorsDir, `shot-${String(shot).padStart(2, '0')}.png`) });
    } catch (e) {
      console.log(`[walkthrough] shot ${shot} anchor screenshot failed: ${(e as Error).message}`);
    }
    // Paint a scan MARKER — a thin magenta bar at the very top — that appears in
    // the recording at this shot's exact frame. The mux finds each marker (a
    // distinct flash, in order) to place the voice, which is unambiguous even
    // when consecutive shots share the same screen (form-fill) and is immune to
    // the screencast's continuous lag. The mux crops this strip off, so it never
    // shows in the final video.
    try {
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = '__wt_mark__';
        d.style.cssText =
          'position:fixed;top:0;left:0;width:100vw;height:16px;background:#ff00ff;z-index:2147483647;pointer-events:none';
        document.documentElement.appendChild(d);
      });
      await page.waitForTimeout(450); // ensure it's captured across VFR frames
      await page.evaluate(() => document.getElementById('__wt_mark__')?.remove());
    } catch {
      /* marker is best-effort; the mux falls back to screenshot matching */
    }
    console.log(`[walkthrough] shot ${shot} anchored @ ${start.toFixed(2)}s`);
  }

  /**
   * Voice-first pacing: hold the current shot on screen until its NARRATION
   * clip would finish (clip length + a small pad), measured from this shot's
   * mark(). So the cursor performs the action and the frame dwells for exactly
   * the voiceover's length — the voice lands ON the action, not before/after.
   *
   * Reads the clip length from generated/clips/manifest.json (produced by the
   * TTS step, which now runs BEFORE recording). If no clip exists yet
   * (record-only, before TTS), it falls back to `fallbackMs` so standalone
   * recording still works — just without tight sync.
   */
  async holdForNarration(
    page: Page,
    featureDir: string,
    shot: number,
    fallbackMs = 2200,
  ): Promise<void> {
    const clipMs = readClipDurationMs(featureDir, shot);
    const targetMs = clipMs != null ? clipMs + HOLD_PAD_MS : fallbackMs;
    const markedAt = this.markedAt.get(shot) ?? Date.now();
    const remaining = targetMs - (Date.now() - markedAt);
    if (remaining > 0) await page.waitForTimeout(remaining);
    console.log(
      `[walkthrough] shot ${shot} held for narration ` +
        `(${clipMs != null ? `voice ${(clipMs / 1000).toFixed(1)}s` : 'no clip — fallback'})`,
    );
  }

  /** Persist to <featureDir>/generated/shot-timings.json for the TTS mux step. */
  save(featureDir: string): void {
    const out = path.join(featureDir, 'generated', 'shot-timings.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(this.timings, null, 2));
    console.log(`[walkthrough] shot timings saved to ${out}`);
  }
}

/**
 * Full-viewport screenshot into <featureDir>/generated/frames/<slug>.png —
 * free training-doc stills + verification frames from the same recording run.
 * Optional; call after a shot's end state has rendered: `await snap(page, FEATURE_DIR, 'shot-05-pick-repository')`.
 */
export async function snap(page: Page, featureDir: string, slug: string): Promise<void> {
  const dir = path.join(featureDir, 'generated', 'frames');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${slug}.png`) });
}

// Anything in raw/ older than this run cannot be this run's recording —
// Playwright normally clears its outputDir, but a crash can leave leftovers.
const RUN_START_MS = Date.now() - 5_000;

/**
 * Promote the recorded WebM out of Playwright's per-test `generated/raw/**`
 * folder to a stable path: `<featureDir>/generated/walkthrough.webm`.
 * Call from a `test.afterAll` in the spec — the generated spec only calls it
 * when the test body completed, so a failed run never clobbers the previous
 * good recording (which would desync it from the untouched shot-timings.json).
 */
export function promoteRecording(featureDir: string): void {
  const rawDir = path.join(featureDir, 'generated', 'raw');
  const destDir = path.join(featureDir, 'generated');
  if (!fs.existsSync(rawDir)) return;

  const webms: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.webm')) webms.push(p);
    }
  };
  walk(rawDir);
  const fresh = webms.filter((p) => fs.statSync(p).mtimeMs >= RUN_START_MS);
  if (webms.length > fresh.length) {
    console.log(`[walkthrough] ignoring ${webms.length - fresh.length} stale .webm from an earlier run`);
  }
  if (fresh.length === 0) {
    console.log('[walkthrough] no fresh .webm found to promote');
    return;
  }
  fresh.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const dest = path.join(destDir, 'walkthrough.webm');
  fs.copyFileSync(fresh[0], dest);
  console.log(`[walkthrough] video saved to ${dest}`);
}
