const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const { pathToFileURL } = require('url');

// ── Prompt ────────────────────────────────────────────────────────────────────

const MOMENTS_PROMPT = `You are a TikTok/Reels editor adding text overlays to a podcast clip to maximise engagement.

These overlays float OVER the existing footage — like captions, callouts, and hooks that stop the scroll.

CLIP DURATION: {dur}s
TRANSCRIPT (seconds from clip start):
{transcript}

Choose moments for these overlay types:

- "hook"       — REQUIRED, must appear at time=0. Bold provocative statement or teaser in ALL CAPS
                  (2–5 words, no punctuation except ?). Sets up why the viewer MUST keep watching.
                  Examples: "THIS CHANGES EVERYTHING", "WAIT FOR IT", "NOBODY TALKS ABOUT THIS"
                  Or pull a punchy word/phrase from early in the transcript.
                  duration: 2–3s

- "pull_quote" — A punchy phrase the speaker says (verbatim, 5–9 words). Shows in the bottom zone.
                  duration: 4–7s

- "keyword"    — A single high-impact word or 2-word phrase (uppercase). Big, bold, momentary.
                  duration: 2–4s

- "stat"       — A specific number/percentage/timeframe mentioned. text = number, subtext = short label.
                  duration: 4–6s

RULES:
- Always include exactly 1 hook at time=0, duration=2–3
- 1–3 additional moments after the hook, spaced ≥5s apart
- All times and (time + duration) must be ≤ {dur}
- Total: 2–4 moments

Return ONLY valid JSON — no markdown:
{"moments":[{"type":"hook","time":0,"duration":2.5,"text":"NOBODY TALKS ABOUT THIS"},{"type":"stat","time":18.5,"duration":5,"text":"66 days","subtext":"to build a new habit"},{"type":"pull_quote","time":30,"duration":6,"text":"motivation gets you started, discipline keeps you going"}]}`;

// ── Class ─────────────────────────────────────────────────────────────────────

class HeliosOverlayGenerator {
  constructor(apiKey) {
    this.anthropic = new Anthropic({ apiKey });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generate a 1080×1920 black-background overlay video with animated text callouts.
   * FFmpeg composites this on top of the rendered clip using screen-blend mode,
   * making the black background transparent and leaving only the text/graphics.
   *
   * @param {Object} transcript  { segments: [{start,end,text}] }
   * @param {Object} clip        { start_time, end_time, headline }
   * @param {string} tempDir     Directory for intermediate files
   * @param {number} index       Clip index
   * @returns {Promise<string>}  Path to the overlay MP4
   */
  async generate(transcript, clip, tempDir, index) {
    const duration = clip.end_time - clip.start_time;
    const { moments } = await this._identifyMoments(transcript, clip, duration);
    const html = this._buildHtml(moments, duration);

    const htmlPath = path.join(tempDir, `helios_comp_${index}.html`);
    fs.writeFileSync(htmlPath, html, 'utf-8');

    const outputPath = path.join(tempDir, `helios_overlay_${index}.mp4`);
    await this._render(htmlPath, outputPath, duration);
    return outputPath;
  }

  // ── Claude analysis ────────────────────────────────────────────────────────

  async _identifyMoments(transcript, clip, duration) {
    const segs = transcript.segments
      .filter(s => s.start >= clip.start_time - 0.5 && s.end <= clip.end_time + 0.5)
      .map(s => `[${(s.start - clip.start_time).toFixed(1)}–${(s.end - clip.start_time).toFixed(1)}s] ${s.text.trim()}`)
      .join('\n');

    const prompt = MOMENTS_PROMPT
      .replace('{dur}', duration.toFixed(1))
      .replace('{dur}', duration.toFixed(1))  // second occurrence in rules
      .replace('{transcript}', segs);

    try {
      const resp = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });

      const json = resp.content[0].text.match(/\{[\s\S]*\}/);
      if (!json) return { moments: [] };

      const parsed  = JSON.parse(json[0]);
      const moments = (parsed.moments || []).filter(m =>
        typeof m.time === 'number' &&
        typeof m.duration === 'number' &&
        m.time >= 0 &&
        (m.time + m.duration) <= duration + 1
      );

      // Ensure hook is first and at t≤0.5
      const hook = moments.find(m => m.type === 'hook');
      const rest = moments.filter(m => m.type !== 'hook');
      const ordered = hook ? [{ ...hook, time: Math.min(hook.time, 0.5) }, ...rest] : moments;
      return { moments: ordered.slice(0, 4) };
    } catch (e) {
      console.warn('[HeliosOverlay] Moment identification failed:', e.message);
      return { moments: [] };
    }
  }

  // ── HTML composition builder ───────────────────────────────────────────────

  _buildHtml(moments, duration) {
    const animCSS  = moments.map((m, i) => this._momentCss(m, i)).join('\n\n');
    const elements = moments.map((m, i) => this._momentHtml(m, i)).join('\n');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,600;0,700;0,800;1,700&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/*
 * Black background = transparent when screen-blended over the clip.
 * Only white/gold elements will be visible in the final composite.
 * Do NOT use dark fills, grays, or backgrounds on text containers.
 */
body {
  width: 1080px;
  height: 1920px;
  background: #000;
  overflow: hidden;
  font-family: 'Open Sans', system-ui, sans-serif;
  position: relative;
}

/* ── All moments start invisible via animation fill-mode:both ── */
.moment { position: absolute; }

/* ── HOOK — top zone, y ≈ 80–380 ──────────────────────────── */
.m-hook {
  top: 80px;
  left: 64px; right: 64px;
  text-align: center;
}
.m-hook__text {
  font-size: 82px;
  font-weight: 800;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #ffffff;
  line-height: 1.15;
  /*
   * Screen-blend note: text-shadow black pixels become transparent.
   * Readability against bright video comes from the font weight alone.
   * Use a gold under-glow trick: a gold shadow adds warmth without adding
   * dark pixels that would fight the screen blend.
   */
}
.m-hook__accent {
  margin: 18px auto 0;
  width: 88px;
  height: 4px;
  background: #c8a96e;
  border-radius: 2px;
}

/* ── PULL QUOTE — bottom zone, y ≈ 1320–1680 ──────────────── */
.m-quote {
  top: 1340px;
  left: 64px; right: 64px;
}
.m-quote__mark {
  font-size: 80px;
  line-height: 0.5;
  color: #c8a96e;
  display: block;
  margin-bottom: 14px;
}
.m-quote__text {
  font-size: 48px;
  font-weight: 700;
  font-style: italic;
  color: #ffffff;
  line-height: 1.3;
}
.m-quote__bar {
  margin-top: 18px;
  width: 64px;
  height: 3px;
  background: #c8a96e;
  border-radius: 2px;
}

/* ── KEYWORD — bottom zone, centered, y ≈ 1380 ─────────────── */
.m-kw {
  top: 1380px;
  left: 0; right: 0;
  text-align: center;
}
.m-kw__word {
  font-size: 104px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #c8a96e;
  display: inline-block;
}

/* ── STAT — bottom zone, y ≈ 1340 ──────────────────────────── */
.m-stat {
  top: 1340px;
  left: 64px; right: 64px;
}
.m-stat__num {
  font-size: 98px;
  font-weight: 800;
  color: #c8a96e;
  line-height: 1;
  letter-spacing: -0.02em;
}
.m-stat__label {
  margin-top: 8px;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #ffffff;
}
.m-stat__bar {
  margin-top: 14px;
  width: 88px;
  height: 3px;
  background: #c8a96e;
  border-radius: 2px;
}

/* ── Generated animations ─── */
${animCSS}
</style>
</head>
<body>

${elements}

<script type="module">
import { Helios } from 'https://esm.sh/@helios-project/core@5';
const helios = new Helios({ duration: ${(Math.ceil(duration) + 1).toFixed(0)}, fps: 30, autoSyncAnimations: true });
window.helios = helios;
helios.bindToDocumentTimeline();
</script>

</body>
</html>`;
  }

  _momentHtml(m, i) {
    const id = `m${i}`;
    switch (m.type) {
      case 'hook':
        return `<div id="${id}" class="moment m-hook">
  <div class="m-hook__text">${this._esc(m.text)}</div>
  <div class="m-hook__accent"></div>
</div>`;

      case 'pull_quote':
        return `<div id="${id}" class="moment m-quote">
  <span class="m-quote__mark">"</span>
  <div class="m-quote__text">${this._esc(m.text)}</div>
  <div class="m-quote__bar"></div>
</div>`;

      case 'keyword':
        return `<div id="${id}" class="moment m-kw">
  <span class="m-kw__word">${this._esc(m.text)}</span>
</div>`;

      case 'stat':
        return `<div id="${id}" class="moment m-stat">
  <div class="m-stat__num">${this._esc(m.text)}</div>
  ${m.subtext ? `<div class="m-stat__label">${this._esc(m.subtext)}</div>` : ''}
  <div class="m-stat__bar"></div>
</div>`;

      default:
        return '';
    }
  }

  _momentCss(m, i) {
    const { type, time, duration: dur } = m;
    const id      = `m${i}`;
    const fadeIn  = type === 'hook' ? 0.25 : 0.40;
    const fadeOut = 0.35;
    const inPct   = ((fadeIn  / dur) * 100).toFixed(1);
    const outPct  = (((dur - fadeOut) / dur) * 100).toFixed(1);

    let kf;
    switch (type) {
      case 'hook':
        kf = `@keyframes kf${i} {
  0%        { opacity:0; transform:scale(0.82) translateY(-10px); }
  ${inPct}% { opacity:1; transform:scale(1.04) translateY(0); }
  18%       { opacity:1; transform:scale(1) translateY(0); }
  ${outPct}%{ opacity:1; transform:scale(1) translateY(0); }
  100%      { opacity:0; transform:scale(1.06) translateY(-6px); }
}`;
        break;

      case 'pull_quote':
        kf = `@keyframes kf${i} {
  0%        { opacity:0; transform:translateY(32px); }
  ${inPct}% { opacity:1; transform:translateY(0); }
  ${outPct}%{ opacity:1; transform:translateY(0); }
  100%      { opacity:0; transform:translateY(-10px); }
}`;
        break;

      case 'keyword': {
        const popPct = ((fadeIn * 1.4 / dur) * 100).toFixed(1);
        kf = `@keyframes kf${i} {
  0%        { opacity:0; transform:scale(0.5) skewX(-6deg); }
  ${inPct}% { opacity:1; transform:scale(1.08) skewX(0deg); }
  ${popPct}%{ opacity:1; transform:scale(1) skewX(0deg); }
  ${outPct}%{ opacity:1; transform:scale(1); }
  100%      { opacity:0; transform:scale(0.88); }
}`;
        break;
      }

      case 'stat':
        kf = `@keyframes kf${i} {
  0%        { opacity:0; transform:translateX(-30px); }
  ${inPct}% { opacity:1; transform:translateX(0); }
  ${outPct}%{ opacity:1; transform:translateX(0); }
  100%      { opacity:0; transform:translateX(10px); }
}`;
        break;

      default:
        kf = `@keyframes kf${i} {
  0%, 100%          { opacity:0; }
  ${inPct}%, ${outPct}% { opacity:1; }
}`;
    }

    return `${kf}
#${id} { animation: kf${i} ${dur.toFixed(2)}s ease-in-out ${time.toFixed(2)}s both; }`;
  }

  _esc(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Render HTML → MP4 via @helios-project/renderer ────────────────────────

  async _render(htmlPath, outputPath, duration) {
    let RendererClass;
    try {
      RendererClass = require('@helios-project/renderer').Renderer;
    } catch {
      throw new Error(
        'AI Graphics overlay requires additional packages (installed automatically on first use).'
      );
    }

    const compositionUrl = pathToFileURL(htmlPath).href;
    const renderer = new RendererClass({
      width:    1080,
      height:   1920,
      fps:      30,
      duration: Math.ceil(duration) + 1,
    });

    await renderer.render(compositionUrl, outputPath);
  }
}

module.exports = HeliosOverlayGenerator;
