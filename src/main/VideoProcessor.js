const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');

function resolveFfmpegPath() {
  const bundledDir = path.join(process.resourcesPath || '', 'ffmpeg');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const bundledBin = path.join(bundledDir, `ffmpeg${ext}`);
  if (fs.existsSync(bundledBin)) {
    ffmpeg.setFfmpegPath(bundledBin);
    const probeBin = path.join(bundledDir, `ffprobe${ext}`);
    if (fs.existsSync(probeBin)) ffmpeg.setFfprobePath(probeBin);
  }
}

resolveFfmpegPath();

class VideoProcessor {
  constructor(inputPath, outputDir) {
    this.inputPath = inputPath;
    this.outputDir = outputDir;
    this.tempDir   = path.join(os.tmpdir(), 'clipgen-' + Date.now());
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  extractAudio(onProgress) {
    const outPath = path.join(this.tempDir, 'audio.wav');
    return new Promise((resolve, reject) => {
      ffmpeg(this.inputPath)
        .noVideo()
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .audioFilters('loudnorm')
        .output(outPath)
        .on('progress', (p) => { if (onProgress && p.percent) onProgress(Math.round(p.percent)); })
        .on('end', () => resolve(outPath))
        .on('error', (err) => reject(new Error(`Audio extraction failed: ${err.message}`)))
        .run();
    });
  }

  /**
   * Render a single 9:16 short-form clip with burned-in captions.
   *
   * @param {Object} opts
   * @param {number}  opts.index           Clip ordinal
   * @param {number}  opts.startTime       seconds
   * @param {number}  opts.endTime         seconds
   * @param {string}  opts.backgroundMode  One of: blur-stack | center-crop |
   *                                       branded-bg | branded-overlay-1 |
   *                                       branded-overlay-2 | custom-image | ai-track
   * @param {string}  opts.assPath         Path to .ass subtitle file
   * @param {string}  opts.headline        Clip title (for filename)
   * @param {string}  [opts.bgImagePath]   Absolute path to background/overlay image
   * @param {string}  [opts.trackingCropExpr] FFmpeg expression for AI-track crop X
   * @param {number}  [opts.trackingScaledWidth] Pre-scaled video width for AI-track
   */
  async renderClip({
    index, startTime, endTime, backgroundMode, assPath, headline,
    bgImagePath, trackingCropExpr, helioBgPath,
  }) {
    const safeName  = headline.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_').substring(0, 40);
    const outFile   = `clip_${String(index + 1).padStart(2, '0')}_${safeName}.mp4`;
    const finalPath = path.join(this.outputDir, outFile);
    const tempOut   = path.join(this.tempDir, `clip_${index}.mp4`);
    const duration  = endTime - startTime;

    const hasBg = bgImagePath && fs.existsSync(bgImagePath);

    let filterComplex;
    switch (backgroundMode) {
      case 'center-crop':
        filterComplex = this._centerCropFilter(assPath);
        break;
      case 'branded-bg':
      case 'custom-image':
        filterComplex = hasBg
          ? this._imageBgFilter(assPath)
          : this._blurStackFilter(assPath);
        break;
      case 'branded-overlay-1':
      case 'branded-overlay-2':
        filterComplex = hasBg
          ? this._overlayBrandFilter(assPath)
          : this._blurStackFilter(assPath);
        break;
      case 'ai-track':
        filterComplex = this._aiTrackFilter(assPath, trackingCropExpr);
        break;
      case 'blur-stack':
      default:
        filterComplex = this._blurStackFilter(assPath);
    }

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(this.inputPath)
        .setStartTime(startTime)
        .duration(duration);

      // Second input for modes that use an external image
      if (hasBg && ['branded-bg', 'custom-image', 'branded-overlay-1', 'branded-overlay-2'].includes(backgroundMode)) {
        cmd = cmd.input(bgImagePath);
      }

      cmd
        .complexFilter(filterComplex, ['outv', 'outa'])
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '20',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-r', '30',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
        ])
        .output(tempOut)
        .on('end', resolve)
        .on('error', (err) => reject(new Error(`Clip render failed: ${err.message}`)))
        .run();
    });

    // Optional second pass: screen-blend Helios overlay on top
    if (helioBgPath && fs.existsSync(helioBgPath)) {
      await this._applyHeliosOverlay(tempOut, helioBgPath, finalPath);
    } else {
      fs.renameSync(tempOut, finalPath);
    }
    return finalPath;
  }

  // ── Filter Builders ───────────────────────────────────────────────

  _escapeAss(assPath) {
    return assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/ /g, '\\ ');
  }

  /** Blurred video background + sharp centered video */
  _blurStackFilter(assPath) {
    const esc = this._escapeAss(assPath);
    return [
      '[0:v]split[v1][v2]',
      '[v1]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=25:luma_power=2[bg]',
      '[v2]scale=1080:-2[fg]',
      '[bg][fg]overlay=(W-w)/2:(H-h)/2[composed]',
      `[composed]ass='${esc}'[outv]`,
      '[0:a]acopy[outa]',
    ].join(';');
  }

  /** Crop the center 9:16 region directly */
  _centerCropFilter(assPath) {
    const esc = this._escapeAss(assPath);
    return [
      '[0:v]scale=-1:1920,crop=1080:1920[cropped]',
      `[cropped]ass='${esc}'[outv]`,
      '[0:a]acopy[outa]',
    ].join(';');
  }

  /** Static image (input 1) as background, video centered on top */
  _imageBgFilter(assPath) {
    const esc = this._escapeAss(assPath);
    return [
      '[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg]',
      '[0:v]scale=1080:-2[fg]',
      '[bg][fg]overlay=(W-w)/2:(H-h)/2[composed]',
      `[composed]ass='${esc}'[outv]`,
      '[0:a]acopy[outa]',
    ].join(';');
  }

  /** Blur-stack base with transparent overlay image (input 1) on top */
  _overlayBrandFilter(assPath) {
    const esc = this._escapeAss(assPath);
    return [
      '[0:v]split[v1][v2]',
      '[v1]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=25:luma_power=2[bg]',
      '[v2]scale=1080:-2[fg]',
      '[bg][fg]overlay=(W-w)/2:(H-h)/2[composed]',
      `[composed]ass='${esc}'[captioned]`,
      '[1:v]scale=1080:1920[brand]',
      '[captioned][brand]overlay=0:0[outv]',
      '[0:a]acopy[outa]',
    ].join(';');
  }

  /**
   * Second-pass screen-blend: composites a Helios overlay MP4 on top of the
   * rendered clip. Black pixels in the overlay become transparent via screen blend,
   * leaving only the white/gold text and graphic elements visible.
   */
  _applyHeliosOverlay(basePath, overlayPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(basePath)
        .input(overlayPath)
        .complexFilter([
          '[0:v][1:v]blend=all_mode=screen[outv]',
          '[0:a]acopy[outa]',
        ], ['outv', 'outa'])
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '20',
          '-c:a', 'copy',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', (e) => reject(new Error(`Helios overlay blend failed: ${e.message}`)))
        .run();
    });
  }

  /** AI subject tracking — dynamic crop following the speaker */
  _aiTrackFilter(assPath, cropXExpr) {
    const esc    = this._escapeAss(assPath);
    const cropX  = cropXExpr || 'iw/2-540'; // fallback: center
    return [
      '[0:v]scale=-1:1920[scaled]',
      `[scaled]crop=1080:1920:${cropX}:0[cropped]`,
      `[cropped]ass='${esc}'[outv]`,
      '[0:a]acopy[outa]',
    ].join(';');
  }

  cleanup() {
    try { fs.rmSync(this.tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

module.exports = VideoProcessor;
