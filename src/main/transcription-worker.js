/**
 * Worker thread for transcription — keeps the Electron main thread unblocked.
 */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL_CACHE_DIR = path.join(os.homedir(), '.cache', 'clipgen-models');

async function run() {
  const { audioPath } = workerData;

  parentPort.postMessage({ type: 'progress', percent: 5 });

  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = MODEL_CACHE_DIR;

  const pipe = await pipeline(
    'automatic-speech-recognition',
    'Xenova/whisper-small.en',
    {
      progress_callback: (p) => {
        if (p.status === 'downloading') {
          const pct = 5 + Math.round((p.loaded / (p.total || 1)) * 40);
          parentPort.postMessage({ type: 'progress', percent: pct });
        }
      },
    }
  );

  parentPort.postMessage({ type: 'progress', percent: 50 });

  // Read 16-bit PCM WAV → Float32Array
  const buf = fs.readFileSync(audioPath);
  let offset = 12; // skip RIFF/WAVE header
  while (offset < buf.length - 8) {
    const chunkId = buf.slice(offset, offset + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') { offset += 8; break; }
    offset += 8 + chunkSize;
  }

  const numSamples = (buf.length - offset) / 2;
  const int16 = new Int16Array(buf.buffer, buf.byteOffset + offset, numSamples);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    float32[i] = int16[i] / 32768.0;
  }

  parentPort.postMessage({ type: 'progress', percent: 55 });

  // Manually chunk the audio — @xenova/transformers doesn't reliably handle
  // very long Float32Arrays in one call; process 30s chunks and stitch.
  const SAMPLE_RATE = 16000;
  const CHUNK_SAMPLES = 30 * SAMPLE_RATE; // 480,000 samples per chunk
  const totalChunks = Math.ceil(float32.length / CHUNK_SAMPLES);

  const allWords = [];
  const allSegments = [];
  let fullText = '';

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SAMPLES;
    const end = Math.min(start + CHUNK_SAMPLES, float32.length);
    const chunk = float32.slice(start, end);
    const chunkStartSec = start / SAMPLE_RATE;
    const chunkEndSec = end / SAMPLE_RATE;

    const result = await pipe(chunk, {
      language: 'english',
      task: 'transcribe',
      return_timestamps: 'word',
    });

    const text = (result.text || '').trim();

    // Segment = one per 30s chunk — guaranteed timestamps, used by ClipIntelligence
    if (text) {
      allSegments.push({ start: chunkStartSec, end: chunkEndSec, text });
    }

    // Words = best-effort word-level timestamps, used by CaptionGenerator
    const chunkWords = (result.chunks || [])
      .filter((c) => c.timestamp && c.timestamp[0] != null)
      .map((c) => ({
        word: c.text,
        start: chunkStartSec + c.timestamp[0],
        end: chunkStartSec + (c.timestamp[1] != null ? c.timestamp[1] : c.timestamp[0] + 0.5),
      }));
    allWords.push(...chunkWords);

    fullText += result.text || '';

    const percent = 55 + Math.round(((i + 1) / totalChunks) * 40);
    parentPort.postMessage({ type: 'progress', percent: Math.min(percent, 95) });
  }


  parentPort.postMessage({ type: 'result', data: { text: fullText, segments: allSegments, words: allWords } });
}


run().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
  process.exit(1);
});
