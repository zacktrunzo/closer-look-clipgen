# Closer Look ClipGen

Automated **long-form → short-form** clip generator for the Closer Look podcast.

Drop a 16:9 episode → get 9:16 viral-ready clips with burned-in animated captions.

---

## How It Works

```
MP4 Drop → Extract Audio → Whisper Transcription → GPT-4o Viral Analysis → FFmpeg Render → Gallery
```

1. **Audio Extraction** — FFmpeg pulls 16kHz mono WAV for optimal Whisper input.
2. **Transcription** — OpenAI Whisper (via API) produces word-level timestamps.
3. **Clip Intelligence** — GPT-4o analyzes the transcript for high-engagement 30–60s segments based on hook power, emotional energy, controversial takes, and actionable value.
4. **Video Reframing** — Converts 16:9 → 1080×1920 using either blur-stack or center-crop.
5. **Dynamic Captions** — Generates `.ass` subtitle files with active-word highlighting, burned into the final clip.

---

## Prerequisites

### 1. Node.js ≥ 18

```bash
node --version   # should be 18+
```

### 2. FFmpeg

FFmpeg must be installed and available on your system PATH.

**macOS:**
```bash
brew install ffmpeg
```

**Windows:**
Download from https://ffmpeg.org/download.html and add to PATH, or use:
```bash
choco install ffmpeg
```

**Linux:**
```bash
sudo apt install ffmpeg
```

### 3. OpenAI API Key

You need an OpenAI API key with access to:
- `whisper-1` (audio transcription)
- `gpt-4o` (clip intelligence)

Get one at https://platform.openai.com/api-keys

---

## Setup

```bash
# Clone / download the project
cd closer-look-clipgen

# Install dependencies
npm install

# Run in development mode
npm start
```

On first launch, click the **⚙ Settings** gear icon and enter:
- Your **OpenAI API key**
- Your preferred **output directory** (defaults to ~/Videos/ClipGen)
- **Reframe mode** (blur-stack recommended)
- **Caption style** (bold-highlight recommended)

---

## Project Structure

```
closer-look-clipgen/
├── package.json              # Dependencies & electron-builder config
├── src/
│   ├── main/                 # Electron main process
│   │   ├── main.js           # App entry, window, IPC handlers
│   │   ├── preload.js        # Secure IPC bridge
│   │   ├── VideoProcessor.js # FFmpeg wrapper (extract, reframe, render)
│   │   ├── TranscriptionService.js  # Whisper API integration
│   │   ├── ClipIntelligence.js      # GPT-4o viral segment finder
│   │   └── CaptionGenerator.js      # .ass subtitle generation
│   └── renderer/             # Electron renderer (UI)
│       ├── index.html        # Single-page shell
│       ├── components/
│       │   └── app.js        # UI logic (vanilla JS, no build step)
│       └── styles/
│           └── app.css       # Dark theme, Closer Look branding
├── build/                    # Icons for electron-builder
├── scripts/                  # Build / utility scripts
└── ffmpeg/                   # (optional) Bundled FFmpeg for production
```

---

## Building for Distribution

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

Outputs appear in `dist/`. To bundle FFmpeg with the app, place the binaries in the `ffmpeg/` directory — electron-builder will include them as extraResources.

---

## Configuration Reference

| Setting         | Default            | Description                                    |
|-----------------|--------------------|------------------------------------------------|
| `openaiApiKey`  | —                  | Your OpenAI API key                            |
| `outputDir`     | ~/Videos/ClipGen   | Where rendered clips are saved                 |
| `reframeMode`   | `blur-stack`       | `blur-stack` or `center-crop`                  |
| `captionStyle`  | `bold-highlight`   | `bold-highlight`, `karaoke`, or `minimal`      |
| `maxClips`      | `5`                | Max clips per episode (1–10)                   |
| `clipMinSeconds`| `30`               | Minimum clip duration                          |
| `clipMaxSeconds`| `60`               | Maximum clip duration                          |

Settings are stored via `electron-store` and persist across sessions.

---

## Caption Styles

- **Bold Highlight** — Words appear in groups of 4, with the active word scaled up and colored yellow. The Instagram Reels look.
- **Karaoke** — Progressive fill effect using ASS karaoke tags.
- **Minimal** — Clean white text, no highlighting.

---

## Troubleshooting

**"FFmpeg not found"** — Make sure `ffmpeg` is on your system PATH. Run `ffmpeg -version` in terminal to verify.

**"OpenAI API key not configured"** — Click Settings (⚙) and paste your key.

**Whisper fails on long files** — Files over 25 MB are automatically chunked into 10-minute segments and stitched back together.

**Clips have no captions** — Ensure the Whisper response includes word-level timestamps. The app requests `timestamp_granularities: ['word', 'segment']`.

---

## License

Private / Internal Use — Closer Look Podcast
