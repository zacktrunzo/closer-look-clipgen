const { Worker } = require('worker_threads');
const path = require('path');

class TranscriptionService {
  /**
   * Transcribes audio in a Worker Thread so the Electron main thread stays responsive.
   */
  constructor() {}

  /**
   * @param {string} audioPath — Path to WAV file (16 kHz mono PCM)
   * @param {Function} onProgress — callback(percentInteger)
   * @returns {Promise<Object>} { text, segments: [{ start, end, text }], words: [{ word, start, end }] }
   */
  transcribe(audioPath, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        path.join(__dirname, 'transcription-worker.js'),
        { workerData: { audioPath } }
      );

      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          if (onProgress) onProgress(msg.percent);
        } else if (msg.type === 'result') {
          resolve(msg.data);
        } else if (msg.type === 'error') {
          reject(new Error(msg.message));
        }
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Transcription worker exited with code ${code}`));
      });
    });
  }
}

module.exports = TranscriptionService;
