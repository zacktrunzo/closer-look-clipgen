const fs = require('fs');
const path = require('path');

/** Convert #RRGGBB hex to ASS &HBBGGRR& colour string */
function hexToAss(hex) {
  const h = hex.replace('#', '').padEnd(6, '0');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return `&H${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}&`;
}

/**
 * Map a caption font-weight key to an ASS font name + bold flag.
 * Uses Arial (universally available on Windows/Mac) to ensure captions always render.
 */
function getFontStyle(weight) {
  switch (weight) {
    case 'extrabold': return { name: 'Arial', bold: -1 };
    case 'semibold':  return { name: 'Arial', bold: 0  };
    case 'regular':   return { name: 'Arial', bold: 0  };
    case 'bold':
    default:          return { name: 'Arial', bold: -1 };
  }
}

function buildAssHeader(fontWeight = 'bold', highlightAssColor = '&H2D2D2D&') {
  const { name, bold } = getFontStyle(fontWeight);
  // BackColour in style lines uses &H00BBGGRR (no trailing &, 00 = fully opaque alpha)
  const bgr = highlightAssColor.replace(/[^0-9A-Fa-f]/g, '');
  const backColour = `&H00${bgr}`;
  return `[Script Info]
Title: Closer Look ClipGen Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${name},72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,${bold},0,0,0,100,100,2,0,1,4,2,2,40,40,180,1
Style: Highlight,${name},76,&H00FFFFFF,${highlightAssColor},&H00000000,&H80000000,${bold},0,0,0,105,105,2,0,1,4,2,2,40,40,180,1
Style: BoxWord,${name},76,&H00FFFFFF,&H000000FF,&H00000000,${backColour},${bold},0,0,0,100,100,2,0,3,14,0,2,40,40,200,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

class CaptionGenerator {
  /**
   * @param {Object} transcript      Full transcript { words: [{ word, start, end }] }
   * @param {Object} clip            { start_time, end_time }
   * @param {string} style           'bold-highlight' | 'minimal' | 'karaoke'
   * @param {string} fontWeight      'bold' | 'extrabold' | 'semibold' | 'regular'
   * @param {string} highlightColor  Hex colour for the active word, e.g. '#2d2d2d'
   */
  constructor(transcript, clip, style = 'box-highlight', fontWeight = 'bold', highlightColor = '#2d2d2d') {
    this.transcript     = transcript;
    this.clip           = clip;
    this.style          = style;
    this.fontWeight     = fontWeight;
    this.highlightColor = hexToAss(highlightColor);
  }

  /**
   * Generate a .ass subtitle file for this clip.
   * @returns {string} path to the .ass file
   */
  generate(outputDir, index) {
    const clipWords = this.transcript.words.filter(
      (w) => w.start >= this.clip.start_time - 0.5 && w.start < this.clip.end_time
    );

    // Offset word timestamps to be relative to the clip start (0-based).
    // FFmpeg with input-side -ss normalizes output PTS to start at 0, so subtitle
    // events must also start at 0 rather than using the source video's absolute times.
    const offsetWords = clipWords.map((w) => ({
      word:  this._sanitizeAssText(w.word.trim()),
      start: Math.max(0, w.start - this.clip.start_time),
      end:   Math.max(0, w.end   - this.clip.start_time),
    })).filter((w) => w.end > w.start && w.word.length > 0);

    // Fallback: if Whisper returned no word-level timestamps for this clip's range,
    // distribute the segment text evenly across the clip duration.
    let groups;
    if (offsetWords.length > 0) {
      groups = this._groupWords(offsetWords, 4);
    } else {
      const clipDuration = this.clip.end_time - this.clip.start_time;
      const segText = (this.transcript.segments || [])
        .filter(s => s.end > this.clip.start_time - 0.5 && s.start < this.clip.end_time + 0.5)
        .map(s => s.text.trim())
        .join(' ');
      const fallbackWords = segText.split(/\s+/).filter(w => w.length > 0);
      if (fallbackWords.length > 0) {
        const timePerWord = clipDuration / fallbackWords.length;
        groups = this._groupWords(
          fallbackWords.map((w, i) => ({
            word:  this._sanitizeAssText(w),
            start: i * timePerWord,
            end:   (i + 1) * timePerWord,
          })),
          4
        );
      } else {
        groups = [];
      }
    }

    let events = '';
    if (this.style === 'karaoke') {
      events = this._buildKaraoke(groups);
    } else if (this.style === 'minimal') {
      events = this._buildMinimal(groups);
    } else if (this.style === 'bold-highlight') {
      events = this._buildBoldHighlight(groups);
    } else {
      events = this._buildBoxHighlight(groups); // box-highlight (default)
    }

    const content = buildAssHeader(this.fontWeight, this.highlightColor) + events;
    const outPath = path.join(outputDir, `captions_${index}.ass`);
    fs.writeFileSync(outPath, content, 'utf-8');
    return outPath;
  }

  /**
   * BOX HIGHLIGHT style:
   * One word at a time, centered, with an opaque rectangular box behind it.
   * Uses ASS BorderStyle: 3 (opaque box via BackColour) — a true rectangle,
   * not a glyph-shaped outline. Outline: 14 creates the padding inside the box.
   */
  _buildBoxHighlight(groups) {
    let events = '';
    for (const group of groups) {
      const groupEnd = group[group.length - 1].end;
      for (let i = 0; i < group.length; i++) {
        const word      = group[i];
        const wordStart = word.start;
        const wordEnd   = i < group.length - 1 ? group[i + 1].start : groupEnd;
        events += `Dialogue: 0,${this._ts(wordStart)},${this._ts(wordEnd)},BoxWord,,0,0,0,,${word.word}\n`;
      }
    }
    return events;
  }

  _buildBoldHighlight(groups) {
    let events = '';
    for (const group of groups) {
      const groupEnd = group[group.length - 1].end;
      for (let i = 0; i < group.length; i++) {
        const word     = group[i];
        const wordStart = word.start;
        const wordEnd   = i < group.length - 1 ? group[i + 1].start : groupEnd;
        const text = group
          .map((w, j) => j === i
            ? `{\\c${this.highlightColor}\\fscx110\\fscy110}${w.word}{\\c&HFFFFFF&\\fscx100\\fscy100}`
            : w.word)
          .join(' ');
        events += `Dialogue: 0,${this._ts(wordStart)},${this._ts(wordEnd)},Default,,0,0,0,,${text}\n`;
      }
    }
    return events;
  }

  _buildKaraoke(groups) {
    let events = '';
    for (const group of groups) {
      const groupStart   = group[0].start;
      const groupEnd     = group[group.length - 1].end;
      const karaokeText  = group
        .map((w) => `{\\kf${Math.round((w.end - w.start) * 100)}}${w.word}`)
        .join(' ');
      events += `Dialogue: 0,${this._ts(groupStart)},${this._ts(groupEnd)},Highlight,,0,0,0,,${karaokeText}\n`;
    }
    return events;
  }

  _buildMinimal(groups) {
    let events = '';
    for (const group of groups) {
      const text = group.map((w) => w.word).join(' ');
      events += `Dialogue: 0,${this._ts(group[0].start)},${this._ts(group[group.length - 1].end)},Default,,0,0,0,,${text}\n`;
    }
    return events;
  }

  _groupWords(words, max) {
    const groups = [];
    for (let i = 0; i < words.length; i += max) groups.push(words.slice(i, i + max));
    return groups;
  }

  /** Escape characters that have special meaning in ASS subtitle format */
  _sanitizeAssText(text) {
    return text
      .replace(/\\/g, '')     // backslash starts ASS override tags
      .replace(/\{/g, '')     // opening brace starts override block
      .replace(/\}/g, '')     // closing brace ends override block
      .replace(/\n/g, ' ')    // newlines break dialogue line format
      .replace(/\r/g, '');
  }

  _ts(seconds) {
    const h  = Math.floor(seconds / 3600);
    const m  = Math.floor((seconds % 3600) / 60);
    const s  = Math.floor(seconds % 60);
    const cs = Math.round((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
}

module.exports = CaptionGenerator;
