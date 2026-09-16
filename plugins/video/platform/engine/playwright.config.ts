import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { findUp, loadEnvChain, FRAME_GUTTER } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // platform/engine (ESM: no __dirname)

/**
 * Feature-driven Playwright config — one config serves EVERY feature of EVERY
 * project. Point it at a feature folder via the WT_FEATURE_DIR env var (the
 * record-feature script does this for you):
 *
 *   WT_FEATURE_DIR=<p>/modules/<m>/features/<f> \
 *     npx playwright test --config platform/engine/playwright.config.ts
 *
 * App-specific facts (baseUrl, viewport, headless, channel, optional start
 * command) come from the nearest project.yaml above the feature folder.
 * This file is generic — never edit it per project or feature.
 */

// When WT_FEATURE_DIR is absent (e.g. an IDE's Playwright extension loading
// this config for inspection), degrade to an inert no-tests config instead of
// throwing — only an EXPLICIT but invalid WT_FEATURE_DIR is a hard error.
const featureDirEnv = process.env.WT_FEATURE_DIR;
const featureDir = featureDirEnv ? path.resolve(featureDirEnv) : '';
const isFeature = !!featureDir && fs.existsSync(path.join(featureDir, 'walkthrough.spec.ts'));
if (featureDirEnv && !isFeature) {
  throw new Error(
    `WT_FEATURE_DIR does not point at a feature folder (no walkthrough.spec.ts): ${featureDir}`,
  );
}

interface StartCmd { command?: string; cwd?: string; readyUrl?: string }
interface EnvConfig { baseUrl?: string; start?: StartCmd | StartCmd[]; credentialsEnv?: string[] }
interface ProjectConfig {
  id: string;
  baseUrl: string;
  auth?: { credentialsEnv?: string[] };
  video?: {
    viewport?: { width: number; height: number };
    headless?: boolean;
    channel?: string;
    ignoreHTTPSErrors?: boolean;
  };
  start?: StartCmd | StartCmd[];
  defaultEnv?: string;
  environments?: Record<string, EnvConfig>;
}

let project: ProjectConfig = { id: 'none', baseUrl: 'http://localhost:3000' };
let projectDir = '.';
if (isFeature) {
  const projectFile = findUp('project.yaml', featureDir);
  if (!projectFile) {
    throw new Error(`No project.yaml found above ${featureDir} — every feature must live under a project.`);
  }
  projectDir = path.dirname(projectFile);
  project = parse(fs.readFileSync(projectFile, 'utf8')) as ProjectConfig;
  if (!project?.baseUrl) throw new Error(`${projectFile} must define baseUrl`);
}

// Pick the recording environment: --env / WT_ENV, else project.defaultEnv, else
// the top-level baseUrl/start (single-environment projects / back-compat).
const envs = project.environments ?? {};
const wtEnv = process.env.WT_ENV || project.defaultEnv || '';
let selectedBaseUrl = project.baseUrl;
let selectedStart: StartCmd | StartCmd[] | undefined = project.start;
if (wtEnv) {
  const env = envs[wtEnv];
  if (!env) {
    throw new Error(
      `environment "${wtEnv}" is not defined in project.yaml (have: ` +
        `${Object.keys(envs).join(', ') || 'none'}). Fix --env / WT_ENV / defaultEnv.`,
    );
  }
  selectedBaseUrl = env.baseUrl || project.baseUrl;
  selectedStart = env.start ?? project.start;
}
if (isFeature) console.log(`[walkthrough] environment: ${wtEnv || '(top-level)'} -> ${selectedBaseUrl}`);

// Per-environment credentials. The generated spec reads fixed base names
// (project.auth.credentialsEnv, e.g. WALKTHROUGH_EMAIL/PASSWORD). When the
// selected environment names its OWN credentials (e.g. local uses a seeded-DB
// account), map those values onto the base names here — in the main process,
// before workers spawn, so the same spec authenticates against whichever
// environment is chosen. Config runs before the spec's own loadEnvChain, and
// applyEnvFile never overrides an already-set var, so these values win.
if (isFeature && wtEnv) {
  loadEnvChain(featureDir); // surface .env values (incl. this env's vars) here
  const envCreds = envs[wtEnv]?.credentialsEnv;
  const baseNames = project.auth?.credentialsEnv ?? ['WALKTHROUGH_EMAIL', 'WALKTHROUGH_PASSWORD'];
  if (envCreds?.length) {
    envCreds.forEach((srcName, i) => {
      const destName = baseNames[i];
      const value = process.env[srcName];
      if (destName && value !== undefined) process.env[destName] = value; // force-override
    });
    console.log(`[walkthrough] using ${wtEnv} credentials (${envCreds.join(', ')})`);
  }
}

const video = project.video ?? {};
const viewport = video.viewport ?? { width: 1920, height: 1080 };
// Capture a bit TALLER than the delivered size: the page is shifted down by
// FRAME_GUTTER (cursor.ts) so the top scan marker sits in a blank band, and the
// mux crops exactly that band back off — the final video is `viewport` sized with
// the full top bar intact (no clipping). Width is unchanged.
const captureViewport = { width: viewport.width, height: viewport.height + FRAME_GUTTER };

export default defineConfig({
  testDir: isFeature ? featureDir : HERE,
  testMatch: isFeature ? 'walkthrough.spec.ts' : '__no-feature-selected__.spec.ts',
  // Cold app start + slow feature requests can take a while.
  timeout: 5 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: selectedBaseUrl,
    // A local backend usually serves the API over https with a self-signed dev
    // cert (e.g. https://localhost:5001); the in-page fetch would fail cert
    // validation. Ignore cert errors by default — valid certs (live/deployed)
    // pass regardless, so this is a no-op there. Override with video.ignoreHTTPSErrors.
    ignoreHTTPSErrors: video.ignoreHTTPSErrors ?? true,
    // Headless by default (works on servers/CI with no display). Modern headless
    // Chromium still records video and renders CSS transitions fine.
    headless: video.headless ?? true,
    // Pacing is handled by the virtual cursor (eased glides + beat() pauses);
    // a large slowMo would make every glide step jerky.
    launchOptions: { slowMo: 0 },
    trace: 'off',
    screenshot: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        // Spread the device preset FIRST, then override — otherwise the preset's
        // own viewport (1280×720) and deviceScaleFactor win and the app fills only
        // part of the recorded frame, leaving blank margins.
        ...devices['Desktop Chrome'],
        ...(video.channel ? { channel: video.channel } : {}),
        // Viewport, DPR, and recorded video size must all match so the app
        // fills the entire frame with no dead space. captureViewport = the
        // delivered size + the framing gutter (cropped back off by the mux).
        viewport: captureViewport,
        deviceScaleFactor: 1,
        video: { mode: 'on', size: captureViewport },
      },
    },
  ],

  // Playwright drops raw recordings here; the spec's afterAll promotes the
  // newest WebM to <featureDir>/generated/walkthrough.webm.
  outputDir: isFeature ? path.join(featureDir, 'generated', 'raw') : path.join(HERE, '.no-feature'),

  // Optionally boot the app first (the selected environment's start). Empty/
  // absent = app already running/deployed. A list starts several servers
  // together (e.g. backend + frontend for a 'local' environment).
  webServer: (() => {
    const toServer = (s: StartCmd) => ({
      command: s.command as string,
      cwd: path.resolve(projectDir, s.cwd || '.'),
      url: s.readyUrl || selectedBaseUrl,
      reuseExistingServer: true,
      timeout: 3 * 60 * 1000,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    });
    if (Array.isArray(selectedStart)) {
      const servers = selectedStart.filter((s) => s?.command).map(toServer);
      return servers.length ? servers : undefined;
    }
    return selectedStart?.command ? toServer(selectedStart) : undefined;
  })(),
});
