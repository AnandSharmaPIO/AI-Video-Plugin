import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared filesystem/env plumbing used by both the engine (walkthrough.ts,
 * playwright.config.ts) and the plain-Node scripts in platform/scripts.
 * Plain ESM (.mjs) so it is importable from TypeScript and .mjs alike.
 *
 * This file is 100% app-agnostic — never edit it per project or feature.
 */

/**
 * Framing gutter (px). The recorder captures a viewport this much TALLER than
 * the configured video size and shifts the whole page DOWN by the same amount
 * (cursor.ts injects `body { transform: translateY(FRAME_GUTTER) }`), leaving a
 * blank top band. The scan marker is painted in that band, and the mux crops
 * exactly this many pixels off the top — so the marker is removed WITHOUT eating
 * the app's real top bar (logo, header, actions). `build_narrated.py`'s
 * MARKER_CROP MUST equal this value.
 */
export const FRAME_GUTTER = 20;

/** Apply KEY=VALUE pairs from one .env file. Values already in the environment win. */
export function applyEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/**
 * Load `.env` files walking up from `startDir` to the repo root (the first
 * directory containing `.git`). Values already present in the environment
 * always win; closer .env files beat farther ones.
 */
export function loadEnvChain(startDir) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth++) {
    applyEnvFile(path.join(dir, '.env'));
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** Walk upward from a directory to the nearest file with this name, or null. */
export function findUp(name, from) {
  let dir = path.resolve(from);
  for (let depth = 0; depth < 12; depth++) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
