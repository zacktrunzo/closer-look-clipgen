const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are a viral content strategist specializing in short-form video.
You analyze podcast transcripts to find the most engaging 30-60 second segments
that will perform well as TikTok / YouTube Shorts / Instagram Reels clips.

SELECTION CRITERIA (in priority order):
1. HOOK POWER — Does the first sentence grab attention instantly?
2. EMOTIONAL ENERGY — Strong opinions, passion, surprise, humor, outrage.
3. CONTROVERSIAL TAKES — Bold or polarizing statements that drive comments.
4. ACTIONABLE VALUE — "How-to" moments, practical tips, life advice.
5. STORY ARC — A mini-narrative with setup → tension → payoff within the clip.
6. QUOTABILITY — Sentences people would screenshot and share.

RULES:
- Each clip must be self-contained — a viewer with ZERO context should follow it.
- Avoid segments that start mid-sentence or end awkwardly.
- Prefer segments where the speaker builds to a crescendo or delivers a clear punchline.
- Clips should be between {min}–{max} seconds.
- Return UP TO {count} clips (fewer is fine if the transcript doesn't support more), ranked by viral potential.
- If you cannot find any suitable clips, return: {"clips": []}

RESPOND WITH ONLY valid JSON — no markdown, no commentary, no backticks.`;

const USER_PROMPT_TEMPLATE = `Here is the full transcript of a Closer Look podcast episode.
Timestamps are in seconds.

TRANSCRIPT:
{transcript}

Find the {count} most viral-worthy segments ({min}–{max} seconds each).

Respond with this exact JSON structure:
{
  "clips": [
    {
      "start_time": <number — seconds>,
      "end_time": <number — seconds>,
      "headline": "<catchy 5-8 word headline for this clip>",
      "hook": "<the opening line that grabs attention>",
      "why_viral": "<one sentence explaining why this will perform>"
    }
  ]
}`;

class ClipIntelligence {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Analyze transcript and return top viral clip candidates.
   *
   * @param {Object} transcript — { text, segments: [{ start, end, text }] }
   * @param {Object} opts
   * @param {number} opts.maxClips    — how many clips to find (default 5)
   * @param {number} opts.minSeconds  — minimum clip length (default 30)
   * @param {number} opts.maxSeconds  — maximum clip length (default 60)
   * @returns {Promise<Array>} Array of clip objects
   */
  async findClips(transcript, { maxClips = 5, minSeconds = 30, maxSeconds = 60 } = {}) {
    const formattedTranscript = transcript.segments
      .map((s) => `[${this._fmtTime(s.start)} → ${this._fmtTime(s.end)}] ${s.text.trim()}`)
      .join('\n');


    const systemMsg = SYSTEM_PROMPT
      .replace('{min}', minSeconds)
      .replace('{max}', maxSeconds)
      .replace('{count}', maxClips);

    const userMsg = USER_PROMPT_TEMPLATE
      .replace('{transcript}', formattedTranscript)
      .replace('{count}', maxClips)
      .replace('{min}', minSeconds)
      .replace('{max}', maxSeconds);

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemMsg,
      messages: [{ role: 'user', content: userMsg }],
    });

    const raw = response.content[0].text;

    // Extract JSON — Claude may occasionally wrap in markdown fences
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Claude returned an unexpected response: "${raw.substring(0, 200)}"`);

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error('Claude returned invalid JSON. Try again.');
    }

    const clips = parsed.clips || parsed.segments || [];

    return clips
      .filter((c) => {
        const dur = c.end_time - c.start_time;
        return (
          typeof c.start_time === 'number' &&
          typeof c.end_time === 'number' &&
          c.end_time > c.start_time &&
          dur >= minSeconds - 5 &&
          dur <= maxSeconds + 5
        );
      })
      .slice(0, maxClips);
  }

  /**
   * Generate SEO-optimised social metadata for a single clip.
   *
   * @param {string} clipText   The transcript text for this clip
   * @param {Object} clip       { headline, start_time, end_time, hook, why_viral }
   * @returns {Promise<string>} Formatted text ready to save as .txt
   */
  async generateSocialMetadata(clipText, clip) {
    const prompt = `You are an expert social media strategist and SEO copywriter.
Given this short-form video clip from the Closer Look podcast, write platform-optimised metadata.

CLIP HEADLINE: ${clip.headline}
CLIP HOOK: ${clip.hook || ''}
TRANSCRIPT:
${clipText}

STRICT CHARACTER LIMITS — count carefully before responding:
- YouTube title: HARD MAX 60 characters (including spaces)
- YouTube description: HARD MAX 160 characters — one punchy paragraph, keywords front-loaded
- YouTube hashtags: 3-5 tags, space-separated, on one line
- TikTok caption: HARD MAX 150 characters TOTAL (caption text + hashtags combined)
- Instagram caption: HARD MAX 125 characters for the main caption text (before hashtags), then hashtags on a NEW LINE
- Instagram hashtags: 20-25 tags on their own line after the caption

Additional rules:
- Hashtags: mix large (#podcast, #motivation), mid (#closerlookpodcast), and niche topic tags
- Include @closerlookpodcast as a mention where natural
- SEO-optimised for discoverability and engagement in 2025
- No emojis unless they genuinely add value

Respond in this exact format (keep the section headers exactly as written):

--- YOUTUBE SHORTS ---
Title: <max 60 chars>
Description: <max 160 chars>
Hashtags: <3-5 tags>

--- TIKTOK ---
Caption: <max 150 chars total including hashtags>

--- INSTAGRAM REELS ---
Caption: <max 125 chars>
Hashtags: <20-25 tags on this line>`;

    const response = await this.client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    });

    return response.content[0].text.trim();
  }

  _fmtTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}

module.exports = ClipIntelligence;
