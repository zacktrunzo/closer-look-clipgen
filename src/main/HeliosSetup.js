'use strict';

/**
 * HeliosSetup — auto-installs @helios-project/renderer and the Playwright
 * Chromium browser the first time AI Graphics mode is used.
 *
 * Both operations are idempotent: if already installed they finish in seconds.
 */

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

// Root of the app (where package.json lives)
const APP_ROOT = path.join(__dirname, '..', '..');

// ── Detection helpers ──────────────────────────────────────────────────────

function isRendererInstalled() {
  try {
    require.resolve('@helios-project/renderer');
    return true;
  } catch {
    return false;
  }
}

/**
 * Playwright stores browser binaries in a platform-specific cache dir.
 * We check for the presence of any chromium directory there.
 */
function isChromiumInstalled() {
  try {
    // playwright exposes the executable path without launching a browser
    const { chromium } = require('playwright');
    const execPath = chromium.executablePath();
    return fs.existsSync(execPath);
  } catch {
    // playwright not installed yet, or path unavailable — treat as missing
    return false;
  }
}

// ── Command runner ─────────────────────────────────────────────────────────

/**
 * Spawn a shell command and stream its output to onOutput.
 * Resolves when the process exits with code 0, rejects otherwise.
 */
function runCommand(cmd, args, cwd, onOutput) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,                    // lets Windows find npm.cmd / npx.cmd
      env:   { ...process.env },
    });

    const handleData = (data) => {
      const line = data.toString().trim();
      if (line) onOutput(line);
    };

    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}

// ── Install steps ──────────────────────────────────────────────────────────

async function installRenderer(onProgress) {
  onProgress('Installing renderer package…', 5);

  await runCommand(
    'npm',
    ['install', '@helios-project/renderer', '--no-audit', '--no-fund', '--loglevel', 'error'],
    APP_ROOT,
    (line) => onProgress(line.substring(0, 90), null),
  );

  onProgress('Renderer package installed.', 30);
}

async function installChromium(onProgress) {
  onProgress('Checking rendering browser…', 35);

  await runCommand(
    'npx',
    ['playwright', 'install', 'chromium'],
    APP_ROOT,
    (line) => {
      if (!line) return;

      // Parse "Downloading Chromium … XX%" style lines for smooth progress
      const pctMatch = line.match(/(\d+(\.\d+)?)%/);
      if (pctMatch) {
        const dlPct = parseFloat(pctMatch[1]);
        // Map 0–100% download into the 40–95% overall range
        const overall = 40 + Math.round(dlPct * 0.55);
        onProgress(`Downloading browser… ${Math.round(dlPct)}%`, overall);
      } else {
        onProgress(line.substring(0, 90), null);
      }
    },
  );

  onProgress('Browser ready.', 98);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Ensure all Helios dependencies are present.
 * Installs anything missing, then resolves.
 *
 * @param {(message: string, percent: number|null) => void} onProgress
 */
async function ensureHeliosReady(onProgress) {
  if (!isRendererInstalled()) {
    await installRenderer(onProgress);
  } else {
    onProgress('Renderer already installed.', 30);
  }

  if (!isChromiumInstalled()) {
    await installChromium(onProgress);
  } else {
    onProgress('Browser already installed.', 98);
  }

  onProgress('AI Graphics ready.', 100);
}

module.exports = { ensureHeliosReady, isRendererInstalled, isChromiumInstalled };
