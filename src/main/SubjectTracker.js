const { Worker } = require('worker_threads');
const path = require('path');

class SubjectTracker {
  /**
   * Analyze a clip segment and return tracking data for AI reframing.
   * @param {string} videoPath
   * @param {number} startTime  seconds
   * @param {number} duration   seconds
   * @param {string} tempDir
   * @param {Function} onProgress callback(percent 0-100)
   * @returns {Promise<{cropXExpr: string, scaledWidth: number}>}
   */
  analyzeClip(videoPath, startTime, duration, tempDir, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        path.join(__dirname, 'subject-tracker-worker.js'),
        { workerData: { videoPath, startTime, duration, tempDir } }
      );

      worker.on('message', (msg) => {
        if (msg.type === 'progress' && onProgress) onProgress(msg.percent);
        else if (msg.type === 'result') resolve(msg.data);
        else if (msg.type === 'error') reject(new Error(msg.message));
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Subject tracker exited with code ${code}`));
      });
    });
  }
}

module.exports = SubjectTracker;
