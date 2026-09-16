import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared plumbing for the platform/scripts CLIs.
 * This file is 100% app-agnostic — never edit it per project or feature.
 */

/**
 * Plugin root — where the ENGINE lives (platform/scripts/lib -> three levels up).
 * Node resolves module realpaths, so this is the plugin's own directory even when
 * a project reaches these scripts through a symlink or junction.
 */
export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Absolute path to an engine asset inside the plugin, e.g. engine('tts', 'generate.py'). */
export const engine = (...parts) => path.join(pluginRoot, 'platform', ...parts);

/**
 * Content root — where projects live. This is the user's cwd when they invoke
 * a command; every child process is spawned with `cwd: repoRoot`, so the whole
 * chain agrees. WT_PROJECT_ROOT overrides it when invoking from somewhere
 * other than the content root.
 *
 * A "project" is any immediate subdirectory of this root that directly
 * contains a `project.yaml` — see `listProjectDirs()`. There is no fixed
 * wrapper folder (previously `walkthroughs/`); a project sits at
 * `<repoRoot>/<project-id>/` directly.
 */
export const repoRoot = path.resolve(process.env.WT_PROJECT_ROOT || process.cwd());

/**
 * Every immediate subdirectory of `repoRoot` that directly contains a
 * `project.yaml` — the sole rule for "this is a project," now that projects
 * are not confined to a fixed wrapper folder. Cheap (one existsSync per
 * top-level entry, no recursion), so every script that needs to enumerate
 * projects should use this instead of re-deriving its own discovery logic.
 */
export function listProjectDirs(root = repoRoot) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'project.yaml')));
}

/**
 * Split argv into `--flags`, `--key value` options, and positionals.
 * `valueFlags` names the flags that consume the NEXT token as their value
 * (e.g. ['--dest','--mode']); their value is removed from `positional` and
 * exposed via `opt(name)`. Boolean flags land in `flags`. Backward compatible:
 * with no valueFlags this behaves exactly as before.
 */
export function parseArgs(argv, valueFlags = []) {
  const takesValue = new Set(valueFlags);
  const flags = new Set();
  const options = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (takesValue.has(a)) options.set(a, argv[++i]);
      else flags.add(a);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional, options, opt: (name) => options.get(name) };
}

/**
 * Content hash of a generated spec — the staleness contract between
 * record-feature (stamps it into record-meta.json) and catalog (compares it).
 */
export function specHash(specPath) {
  return crypto.createHash('sha1').update(fs.readFileSync(specPath)).digest('hex');
}

/** sha1 of a string. */
export function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * Content hash of a parsed feature.yaml EXCLUDING `status` (which the tooling
 * itself stamps after generating/recording — including it would make every
 * stamp look like a content change). Embedded as a header in the generated
 * spec + narration so staleness is detectable by content, not mtimes (which
 * git clones do not preserve).
 */
export function featureContentHash(feature) {
  const { status, ...content } = feature ?? {};
  return sha1(JSON.stringify(content));
}

/** Extract a `feature-content-hash: <sha1>` header from generated file text. */
export function embeddedContentHash(text) {
  const m = /feature-content-hash:\s*([0-9a-f]{40})/.exec(text);
  return m ? m[1] : null;
}

/** Enumerate every feature dir as { project, module, feature, dir, yamlPath }. */
export function listFeatures() {
  const out = [];
  const list = (dir) =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [];
  for (const projectDir of listProjectDirs()) {
    const project = path.basename(projectDir);
    const modulesDir = path.join(projectDir, 'modules');
    for (const mod of list(modulesDir)) {
      const featuresDir = path.join(modulesDir, mod, 'features');
      for (const feat of list(featuresDir)) {
        const dir = path.join(featuresDir, feat);
        const yamlPath = path.join(dir, 'feature.yaml');
        if (fs.existsSync(yamlPath)) out.push({ project, module: mod, feature: feat, dir, yamlPath });
      }
    }
  }
  return out;
}

/**
 * Locate the TTS venv's python, or null. The venv belongs to the ENGINE, not to
 * any one project, so it resolves against pluginRoot. WALKTHROUGH_TTS_VENV
 * relocates it (setup-tts.sh/.ps1 honour the same variable) — point it at a
 * user-level cache so a plugin reinstall cannot destroy a multi-GB build.
 */
export function venvPython() {
  const venv = process.env.WALKTHROUGH_TTS_VENV || engine('tts', 'venv');
  for (const p of [
    path.join(venv, 'Scripts', 'python.exe'),
    path.join(venv, 'bin', 'python'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
