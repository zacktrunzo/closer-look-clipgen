'use strict';

/**
 * Auto-updater — checks GitHub Releases for new versions.
 * Uses electron-updater, which reads the publish config from package.json.
 *
 * Only runs in packaged (production) builds. In development (npm start) it
 * exits early so no errors appear during local development.
 */

const { app, ipcMain } = require('electron');

function initUpdater(mainWindow) {
  // Skip entirely in dev — electron-updater throws if the app isn't packaged
  if (!app.isPackaged) {
    console.log('[Updater] Development mode — skipping auto-update check.');
    return;
  }

  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch {
    console.warn('[Updater] electron-updater not available.');
    return;
  }

  // Silence the internal logger (errors still surface via the 'error' event)
  autoUpdater.logger = null;
  autoUpdater.autoDownload        = true;   // download silently in background
  autoUpdater.autoInstallOnAppQuit = true;  // install when user quits normally

  const send = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  };

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for update…');
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: v${info.version}`);
    send('update:status', { status: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] App is up to date.');
  });

  autoUpdater.on('download-progress', (progress) => {
    send('update:progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update downloaded: v${info.version}`);
    send('update:status', { status: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.warn('[Updater] Error:', err.message);
    // Don't surface network/update errors to the user — fail silently
  });

  // IPC: renderer requests install (quit and install)
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
  });

  // Check for updates 8 seconds after launch (let the window settle first)
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[Updater] Check failed:', err.message);
    });
  }, 8000);
}

module.exports = { initUpdater };
