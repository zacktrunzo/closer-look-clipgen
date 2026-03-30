const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
const path = require('path');
const fs = require('fs');
const VideoProcessor    = require('./VideoProcessor');
const TranscriptionService = require('./TranscriptionService');
const ClipIntelligence  = require('./ClipIntelligence');
const CaptionGenerator         = require('./CaptionGenerator');
const SubjectTracker           = require('./SubjectTracker');
const HeliosOverlayGenerator   = require('./HeliosOverlayGenerator');
const { initUpdater }          = require('./updater');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    anthropicApiKey:  '',
    outputDir:        path.join(app.getPath('videos'), 'ClipGen'),
    backgroundMode:     'branded-overlay-1',
    customBgPath:       '',
    captionStyle:       'box-highlight',
    captionFontWeight:      'bold',
    captionHighlightColor:  '#2d2d2d',
    maxClips:         10,
    clipMinSeconds:   30,
    clipMaxSeconds:   60,
    heliosEnabled:    false,
  }
});

let mainWindow;

// ─── Session state (analyze → review → render) ────────────────────
let _session = null; // { videoProcessor, transcript, intelligence, outputDir }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#000000',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { frame: true }),
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^file:\/\/\//i.test(url) && /\.(mp4|mov|avi|mkv|webm)$/i.test(url)) {
      const filePath = decodeURIComponent(url.replace(/^file:\/\/\//i, '')).replace(/\//g, '\\');
      mainWindow.webContents.send('file-dropped', filePath);
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  initUpdater(mainWindow);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => store.store);

ipcMain.handle('set-settings', (_, settings) => {
  Object.entries(settings).forEach(([key, val]) => store.set(key, val));
  return store.store;
});

ipcMain.handle('choose-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose Output Directory',
  });
  if (!result.canceled && result.filePaths[0]) {
    store.set('outputDir', result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('choose-bg-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Choose Background Image',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (!result.canceled && result.filePaths[0]) {
    store.set('customBgPath', result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('check-helios', () => {
  const { isRendererInstalled, isChromiumInstalled } = require('./HeliosSetup');
  return {
    rendererInstalled: isRendererInstalled(),
    chromiumInstalled: isChromiumInstalled(),
    ready: isRendererInstalled() && isChromiumInstalled(),
  };
});

ipcMain.handle('open-folder', (_, folderPath) => {
  shell.openPath(folderPath);
});

// ─── Two-phase pipeline (analyze → review → render) ──────────────

ipcMain.handle('analyze-video', async (event, filePath, manualClips) => {
  const apiKey = store.get('anthropicApiKey');
  if (!apiKey && !(manualClips && manualClips.length > 0)) {
    throw new Error('Anthropic API key is not configured. Go to Settings to add it.');
  }

  const settings  = store.store;
  const outputDir = settings.outputDir;
  fs.mkdirSync(outputDir, { recursive: true });

  // Clean up previous session
  if (_session && _session.videoProcessor) {
    try { _session.videoProcessor.cleanup(); } catch { /* best-effort */ }
  }
  _session = null;

  const send = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  };

  try {
    // Step 1: Extract audio
    send('pipeline:step', { step: 'extracting', message: 'Extracting audio…' });
    const videoProcessor = new VideoProcessor(filePath, outputDir);
    const audioPath = await videoProcessor.extractAudio((pct) => {
      send('pipeline:progress', { step: 'extracting', percent: pct });
    });

    // Step 2: Transcribe
    send('pipeline:step', { step: 'transcribing', message: 'Transcribing… (first run downloads ~142 MB model)' });
    const transcription = new TranscriptionService();
    const transcript = await transcription.transcribe(audioPath, (pct) => {
      send('pipeline:progress', { step: 'transcribing', percent: pct });
    });

    // Step 3: Find clips (or use manual)
    // Compute transcript duration so Claude won't suggest clips past real content
    const transcriptDuration = transcript.segments.length > 0
      ? transcript.segments[transcript.segments.length - 1].end
      : null;

    let clips;
    let intelligence = null;
    if (manualClips && manualClips.length > 0) {
      send('pipeline:step', { step: 'analyzing', message: `Using ${manualClips.length} manual timecode${manualClips.length > 1 ? 's' : ''}…` });
      clips = manualClips;
    } else {
      send('pipeline:step', { step: 'analyzing', message: 'Finding viral moments…' });
      intelligence = new ClipIntelligence(apiKey);
      clips = await intelligence.findClips(transcript, {
        maxClips:    settings.maxClips,
        minSeconds:  settings.clipMinSeconds,
        maxSeconds:  settings.clipMaxSeconds,
        maxDuration: transcriptDuration,
      });
    }

    // Ensure intelligence is available for social metadata even when manual clips were used
    if (!intelligence && apiKey) {
      intelligence = new ClipIntelligence(apiKey);
    }

    // Cache session for the render phase
    _session = { videoProcessor, transcript, intelligence, outputDir };

    send('pipeline:step', { step: 'done', message: `Found ${clips.length} clip${clips.length !== 1 ? 's' : ''} — review below` });
    return clips;

  } catch (err) {
    console.error('[ClipGen analyze-video]', err);
    send('pipeline:step', { step: 'error', message: err.message });
    throw err;
  }
});

ipcMain.handle('render-clips', async (event, clips) => {
  if (!_session) throw new Error('No active session — please analyze a video first.');

  const { videoProcessor, transcript, intelligence, outputDir } = _session;
  if (!transcript || !Array.isArray(transcript.words)) {
    throw new Error('Session transcript is missing — please process the video again.');
  }
  const settings     = store.store;
  const bgMode       = settings.backgroundMode || 'blur-stack';
  const customBgPath = settings.customBgPath || '';
  const apiKey       = store.get('anthropicApiKey');

  const brandedDir = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'Branded Backgrounds')
    : path.join(__dirname, '..', '..', 'assets', 'Branded Backgrounds');

  const BRANDED = {
    'branded-bg':        path.join(brandedDir, 'CloserLook_Instagram_Reel_Background.jpg'),
    'branded-overlay-1': path.join(brandedDir, 'CloserLook_Instagram_Reel_Transparent_Overlay_1.png'),
    'branded-overlay-2': path.join(brandedDir, 'CloserLook_Instagram_Reel_Transparent_Overlay_2.png'),
  };

  const send = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  };

  try {
    // Step 3.5: Helios setup (if enabled)
    if (settings.heliosEnabled) {
      const { ensureHeliosReady } = require('./HeliosSetup');
      send('pipeline:step', { step: 'helios-setup', message: 'Setting up AI Graphics…' });
      try {
        await ensureHeliosReady((msg, pct) => {
          send('pipeline:progress', { step: 'helios-setup', ...(pct != null && { percent: pct }), detail: msg });
        });
      } catch (e) {
        console.warn('[HeliosSetup] Setup error (will fall back):', e.message);
        send('pipeline:progress', { step: 'helios-setup', detail: 'Setup failed — using blur-stack fallback.' });
      }
    }

    // Step 4: Render clips
    send('pipeline:step', { step: 'rendering', message: `Rendering ${clips.length} clips…` });

    // Probe video duration once so we can clamp clip endTimes
    let videoDuration = null;
    try {
      videoDuration = await videoProcessor.getDuration();
      console.log(`[ClipGen] Source video duration: ${videoDuration?.toFixed(1)}s`);
    } catch (e) {
      console.warn('[ClipGen] Could not probe video duration (will render without clamping):', e.message);
    }

    const tracker   = bgMode === 'ai-track'      ? new SubjectTracker() : null;
    const heliosGen = settings.heliosEnabled     ? new HeliosOverlayGenerator(apiKey) : null;

    const results = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];

      // Clamp endTime to video duration — prevents seeking past end of file
      let startTime = clip.start_time;
      let endTime   = clip.end_time;
      if (videoDuration != null) {
        if (startTime >= videoDuration - 1) {
          console.warn(`[ClipGen] Clip ${i}: startTime ${startTime.toFixed(1)}s is at or past video end (${videoDuration.toFixed(1)}s) — skipping`);
          send('pipeline:progress', { step: 'rendering', detail: `Clip ${i + 1}: start time past video end — skipped` });
          continue;
        }
        if (endTime > videoDuration) {
          console.warn(`[ClipGen] Clip ${i}: clamping endTime from ${endTime.toFixed(1)}s to ${videoDuration.toFixed(1)}s`);
          endTime = videoDuration - 0.1;
        }
      }
      const duration = endTime - startTime;
      if (duration < 2) {
        console.warn(`[ClipGen] Clip ${i}: effective duration ${duration.toFixed(1)}s too short — skipping`);
        send('pipeline:progress', { step: 'rendering', detail: `Clip ${i + 1}: duration too short after clamping — skipped` });
        continue;
      }

      console.log(`[ClipGen] Clip ${i}: ${startTime.toFixed(1)}s → ${endTime.toFixed(1)}s (${duration.toFixed(1)}s)`);

      // Per-clip try-catch: a single clip failure skips that clip instead of aborting the batch
      try {
        let bgImagePath = BRANDED[bgMode] || null;
        if (bgMode === 'custom-image') bgImagePath = customBgPath || null;

        send('pipeline:progress', {
          step:    'rendering',
          percent: Math.round((i / clips.length) * 100),
          detail:  `Clip ${i + 1}/${clips.length}: ${clip.headline}`,
        });

        // AI tracking
        let trackingCropExpr = null;
        if (tracker) {
          send('pipeline:progress', { step: 'rendering', detail: `Clip ${i + 1}/${clips.length}: Tracking subject…` });
          try {
            const td = await tracker.analyzeClip(
              videoProcessor.inputPath, startTime, duration,
              videoProcessor.tempDir,
              (pct) => send('pipeline:progress', {
                step:    'rendering',
                percent: Math.round((i / clips.length) * 100) + Math.round(pct / clips.length * 0.5),
                detail:  `Clip ${i + 1}/${clips.length}: Tracking… ${pct}%`,
              })
            );
            trackingCropExpr = td.cropXExpr;
          } catch (e) {
            console.warn('[SubjectTracker] Falling back to center crop:', e.message);
          }
        }

        // Helios AI graphics
        let helioBgPath = null;
        if (heliosGen) {
          send('pipeline:progress', { step: 'rendering', detail: `Clip ${i + 1}/${clips.length}: Generating AI graphics…` });
          try {
            helioBgPath = await heliosGen.generate(transcript, clip, videoProcessor.tempDir, i);
          } catch (e) {
            console.warn('[HeliosOverlay] Skipping clip', i, ':', e.message);
            send('pipeline:progress', { step: 'rendering', detail: `Clip ${i + 1}/${clips.length}: AI overlay unavailable, continuing.` });
          }
        }

        const words = (transcript && transcript.words) ? transcript.words : [];
        const matchedWords = words.filter(w => w.start >= startTime - 0.1 && w.end <= endTime + 0.1);
        console.log(`[Captions] Clip ${i}: ${startTime.toFixed(1)}s–${endTime.toFixed(1)}s | words: ${words.length} total, ${matchedWords.length} in range`);

        // Use clamped times for caption generation too
        const captionClip = { ...clip, start_time: startTime, end_time: endTime };
        const captionGen = new CaptionGenerator(transcript, captionClip, settings.captionStyle, settings.captionFontWeight || 'bold', settings.captionHighlightColor || '#2d2d2d');
        const assPath    = captionGen.generate(videoProcessor.tempDir, i);

        const clipPath = await videoProcessor.renderClip({
          index: i, startTime, endTime,
          backgroundMode: bgMode, assPath, headline: clip.headline,
          bgImagePath, trackingCropExpr, helioBgPath,
        });

        // Social metadata
        let socialMetadata = null;
        if (intelligence) {
          try {
            const clipText = transcript.segments
              .filter(s => s.end > startTime - 0.5 && s.start < endTime + 0.5)
              .map(s => s.text.trim())
              .join(' ');
            socialMetadata = await intelligence.generateSocialMetadata(clipText, clip);
            const metaFile = clipPath.replace(/\.mp4$/i, '_social.txt');
            fs.writeFileSync(metaFile, socialMetadata, 'utf-8');
          } catch (e) {
            console.warn('[Social metadata] Failed for clip', i, e.message);
          }
        }

        results.push({ index: i, headline: clip.headline, start_time: startTime, end_time: endTime, filePath: clipPath, duration, socialMetadata });
      } catch (clipErr) {
        console.error(`[ClipGen] Clip ${i + 1} failed:`, clipErr.message);
        send('pipeline:progress', {
          step:   'rendering',
          detail: `Clip ${i + 1}/${clips.length}: failed — ${clipErr.message}`,
        });
      }
    }

    const skippedOrFailed = clips.length - results.length;
    const doneMsg = skippedOrFailed > 0
      ? `${results.length} of ${clips.length} clips ready (${skippedOrFailed} failed)`
      : `All ${results.length} clips ready!`;
    send('pipeline:step', { step: 'done', message: doneMsg });
    return results;

  } catch (err) {
    console.error('[ClipGen render-clips]', err);
    send('pipeline:step', { step: 'error', message: err.message });
    throw err;
  }
});

ipcMain.handle('process-video', async (event, filePath, manualClips) => {
  const apiKey = store.get('anthropicApiKey');
  if (!apiKey) throw new Error('Anthropic API key is not configured. Go to Settings to add it.');

  const settings   = store.store;
  const outputDir  = settings.outputDir;
  const bgMode     = settings.backgroundMode || 'blur-stack';
  const customBgPath = settings.customBgPath || '';

  // Resolve branded asset paths
  const brandedDir = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'Branded Backgrounds')
    : path.join(__dirname, '..', '..', 'assets', 'Branded Backgrounds');

  const BRANDED = {
    'branded-bg':        path.join(brandedDir, 'CloserLook_Instagram_Reel_Background.jpg'),
    'branded-overlay-1': path.join(brandedDir, 'CloserLook_Instagram_Reel_Transparent_Overlay_1.png'),
    'branded-overlay-2': path.join(brandedDir, 'CloserLook_Instagram_Reel_Transparent_Overlay_2.png'),
  };

  fs.mkdirSync(outputDir, { recursive: true });

  const send = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  };

  try {
    // ── Step 1: Extract audio ────────────────────────────────────
    send('pipeline:step', { step: 'extracting', message: 'Extracting audio…' });
    const videoProcessor = new VideoProcessor(filePath, outputDir);
    const audioPath = await videoProcessor.extractAudio((pct) => {
      send('pipeline:progress', { step: 'extracting', percent: pct });
    });

    // ── Step 2: Transcribe ───────────────────────────────────────
    send('pipeline:step', { step: 'transcribing', message: 'Transcribing… (first run downloads ~142 MB model)' });
    const transcription = new TranscriptionService();
    const transcript = await transcription.transcribe(audioPath, (pct) => {
      send('pipeline:progress', { step: 'transcribing', percent: pct });
    });

    // ── Step 3: Find viral moments (or use manual timecodes) ────
    let clips;
    let intelligence = null;
    if (manualClips && manualClips.length > 0) {
      send('pipeline:step', { step: 'analyzing', message: `Using ${manualClips.length} manual timecode${manualClips.length > 1 ? 's' : ''}…` });
      clips = manualClips;
    } else {
      send('pipeline:step', { step: 'analyzing', message: 'Finding viral moments…' });
      intelligence = new ClipIntelligence(apiKey);
      clips = await intelligence.findClips(transcript, {
        maxClips:   settings.maxClips,
        minSeconds: settings.clipMinSeconds,
        maxSeconds: settings.clipMaxSeconds,
      });
    }

    // ── Step 3.5: Helios one-time setup (AI Graphics overlay enabled) ────
    if (settings.heliosEnabled) {
      const { ensureHeliosReady } = require('./HeliosSetup');
      send('pipeline:step', { step: 'helios-setup', message: 'Setting up AI Graphics…' });
      try {
        await ensureHeliosReady((msg, pct) => {
          send('pipeline:progress', {
            step:    'helios-setup',
            ...(pct != null && { percent: pct }),
            detail:  msg,
          });
        });
      } catch (e) {
        // Non-fatal: per-clip helios.generate() will also catch and fall back
        console.warn('[HeliosSetup] Setup error (will fall back to blur-stack):', e.message);
        send('pipeline:progress', { step: 'helios-setup', detail: 'Setup failed — using blur-stack fallback.' });
      }
    }

    // ── Step 4: Render each clip ─────────────────────────────────
    send('pipeline:step', { step: 'rendering', message: `Rendering ${clips.length} clips…` });

    // Lazy-init subject tracker / helios generator if needed
    const tracker   = bgMode === 'ai-track'      ? new SubjectTracker() : null;
    const heliosGen = settings.heliosEnabled     ? new HeliosOverlayGenerator(apiKey) : null;

    const results = [];
    for (let i = 0; i < clips.length; i++) {
      const clip     = clips[i];
      const duration = clip.end_time - clip.start_time;

      // Resolve background image path for this clip
      let bgImagePath = BRANDED[bgMode] || null;
      if (bgMode === 'custom-image') bgImagePath = customBgPath || null;

      send('pipeline:progress', {
        step:    'rendering',
        percent: Math.round((i / clips.length) * 100),
        detail:  `Clip ${i + 1}/${clips.length}: ${clip.headline}`,
      });

      // AI tracking: analyze clip before rendering
      let trackingCropExpr = null;
      if (tracker) {
        send('pipeline:progress', {
          step:   'rendering',
          detail: `Clip ${i + 1}/${clips.length}: Tracking subject…`,
        });
        try {
          const td = await tracker.analyzeClip(
            filePath, clip.start_time, duration,
            videoProcessor.tempDir,
            (pct) => send('pipeline:progress', {
              step: 'rendering',
              percent: Math.round((i / clips.length) * 100) + Math.round(pct / clips.length * 0.5),
              detail: `Clip ${i + 1}/${clips.length}: Tracking… ${pct}%`,
            })
          );
          trackingCropExpr = td.cropXExpr;
        } catch (e) {
          console.warn('[SubjectTracker] Falling back to center crop:', e.message);
        }
      }

      // AI Graphics (BETA): generate Helios animated background
      let helioBgPath = null;
      if (heliosGen) {
        send('pipeline:progress', {
          step:   'rendering',
          detail: `Clip ${i + 1}/${clips.length}: Generating AI graphics…`,
        });
        try {
          helioBgPath = await heliosGen.generate(transcript, clip, videoProcessor.tempDir, i);
        } catch (e) {
          console.warn('[HeliosOverlay] Skipping AI overlay for clip', i, ':', e.message);
          send('pipeline:progress', {
            step:   'rendering',
            detail: `Clip ${i + 1}/${clips.length}: AI overlay unavailable, continuing without it.`,
          });
        }
      }

      const captionGen = new CaptionGenerator(transcript, clip, settings.captionStyle, settings.captionFontWeight || 'bold', settings.captionHighlightColor || '#2d2d2d');
      const assPath    = captionGen.generate(videoProcessor.tempDir, i);

      const clipPath = await videoProcessor.renderClip({
        index:            i,
        startTime:        clip.start_time,
        endTime:          clip.end_time,
        backgroundMode:   bgMode,
        assPath,
        headline:         clip.headline,
        bgImagePath,
        trackingCropExpr,
        helioBgPath,
      });

      // Generate social metadata
      let socialMetadata = null;
      try {
        const clipText = transcript.segments
          .filter(s => s.end > clip.start_time - 0.5 && s.start < clip.end_time + 0.5)
          .map(s => s.text.trim())
          .join(' ');
        socialMetadata = await intelligence.generateSocialMetadata(clipText, clip);
        const metaFile = clipPath.replace(/\.mp4$/i, '_social.txt');
        fs.writeFileSync(metaFile, socialMetadata, 'utf-8');
      } catch (e) {
        console.warn('[Social metadata] Failed for clip', i, e.message);
      }

      results.push({
        index:          i,
        headline:       clip.headline,
        start_time:     clip.start_time,
        end_time:       clip.end_time,
        filePath:       clipPath,
        duration,
        socialMetadata,
      });
    }

    send('pipeline:step', { step: 'done', message: 'All clips ready!' });
    return results;

  } catch (err) {
    console.error('[ClipGen Error]', err);
    send('pipeline:step', { step: 'error', message: err.message });
    throw err;
  }
});
