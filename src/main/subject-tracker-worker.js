/**
 * Worker thread for AI subject tracking — keeps main thread unblocked.
 * Extracts frames at 1 fps, runs YOLO object detection, returns a
 * smooth FFmpeg crop-X expression that follows the detected speaker.
 */
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const MODEL_CACHE_DIR = path.join(os.homedir(), '.cache', 'clipgen-models');

async function run() {
  const { videoPath, startTime, duration, tempDir } = workerData;
  const ffmpeg = require('fluent-ffmpeg');

  parentPort.postMessage({ type: 'progress', percent: 2 });

  // ── 1. Probe video dimensions ─────────────────────────────────────
  const { width: vw, height: vh } = await probeVideo(ffmpeg, videoPath);
  // When scaled to height=1920, the new width is:
  const scaledWidth = Math.round((vw / vh) * 1920);

  parentPort.postMessage({ type: 'progress', percent: 5 });

  // ── 2. Extract frames at 1 fps ────────────────────────────────────
  const framesDir = path.join(tempDir, `track_${Date.now()}`);
  fs.mkdirSync(framesDir, { recursive: true });
  await extractFrames(ffmpeg, videoPath, startTime, duration, framesDir);

  parentPort.postMessage({ type: 'progress', percent: 20 });

  // ── 3. Load YOLO-tiny detection model ─────────────────────────────
  const { pipeline, env, RawImage } = await import('@xenova/transformers');
  env.cacheDir = MODEL_CACHE_DIR;

  const detector = await pipeline('object-detection', 'Xenova/yolos-tiny', {
    progress_callback: (p) => {
      if (p.status === 'downloading') {
        const pct = 20 + Math.round((p.loaded / (p.total || 1)) * 30);
        parentPort.postMessage({ type: 'progress', percent: pct });
      }
    },
  });

  parentPort.postMessage({ type: 'progress', percent: 50 });

  // ── 4. Detect person in each frame ────────────────────────────────
  const frames = fs.readdirSync(framesDir)
    .filter(f => f.endsWith('.jpg'))
    .sort();

  const rawCenterXs = [];

  for (let i = 0; i < frames.length; i++) {
    const framePath = path.join(framesDir, frames[i]);
    // Convert Windows path → file:// URL
    const fileUrl = 'file:///' + framePath.replace(/\\/g, '/').replace(/^\/+/, '');

    try {
      const img     = await RawImage.fromURL(fileUrl);
      const results = await detector(img, { threshold: 0.4 });
      const persons = results.filter(d => d.label === 'person');

      if (persons.length > 0) {
        // Best = highest confidence; box coords are pixel values on the original image
        const best = persons.sort((a, b) => b.score - a.score)[0];
        const cx = (best.box.xmin + best.box.xmax) / 2 / img.width;
        rawCenterXs.push(Math.max(0, Math.min(1, cx)));
      } else {
        rawCenterXs.push(0.5); // fallback: center
      }
    } catch {
      rawCenterXs.push(0.5);
    }

    parentPort.postMessage({
      type: 'progress',
      percent: 50 + Math.round(((i + 1) / frames.length) * 45),
    });
  }

  // ── 5. Smooth & build FFmpeg expression ───────────────────────────
  const smoothed  = smooth(rawCenterXs, 5);
  const positions = smoothed.map((cx, i) => ({ time: i, normalizedCenterX: cx }));
  const cropXExpr = buildCropXExpr(positions, scaledWidth);

  parentPort.postMessage({ type: 'result', data: { cropXExpr, scaledWidth } });
}

// ── Helpers ──────────────────────────────────────────────────────────

function probeVideo(ffmpeg, videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);
      const vs = meta.streams.find(s => s.codec_type === 'video');
      resolve({ width: vs?.width || 1920, height: vs?.height || 1080 });
    });
  });
}

function extractFrames(ffmpeg, videoPath, startTime, duration, framesDir) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .setStartTime(startTime)
      .duration(duration)
      .videoFilters('fps=1')
      .outputOptions(['-q:v', '4'])
      .output(path.join(framesDir, 'frame_%04d.jpg'))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function smooth(values, w = 5) {
  return values.map((_, i) => {
    const s = Math.max(0, i - Math.floor(w / 2));
    const e = Math.min(values.length, i + Math.ceil(w / 2));
    const sl = values.slice(s, e);
    return sl.reduce((a, b) => a + b, 0) / sl.length;
  });
}

function buildCropXExpr(positions, scaledWidth) {
  const maxCropX = Math.max(0, scaledWidth - 1080);
  const toCropX  = (normX) =>
    Math.round(Math.max(0, Math.min(maxCropX, normX * scaledWidth - 540)));

  if (positions.length === 0) return String(Math.floor(maxCropX / 2));
  if (positions.length === 1) return String(toCropX(positions[0].normalizedCenterX));

  const xs = positions.map(p => toCropX(p.normalizedCenterX));

  // Build nested: if(lt(t,t1), lerp(x0,x1,(t-t0)/dt), rest)
  let expr = String(xs[xs.length - 1]);
  for (let i = positions.length - 2; i >= 0; i--) {
    const t0 = positions[i].time;
    const t1 = positions[i + 1].time;
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const dt = t1 - t0;
    if (dt <= 0) continue;
    const lerpExpr = x0 === x1 ? String(x0) : `${x0}+${x1 - x0}*(t-${t0})/${dt}`;
    expr = `if(lt(t,${t1}),${lerpExpr},${expr})`;
  }
  return expr;
}

run().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
  process.exit(1);
});
