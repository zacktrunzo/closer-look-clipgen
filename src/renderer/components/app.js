/**
 * Closer Look ClipGen — Renderer Application
 */

(function () {
  'use strict';

  // ── Platform class ───────────────────────────────
  if (window.clipgen.platform === 'darwin') document.body.classList.add('is-mac');

  // ── DOM refs ────────────────────────────────────
  const views = {
    drop:     document.getElementById('view-drop'),
    pipeline: document.getElementById('view-pipeline'),
    gallery:  document.getElementById('view-gallery'),
  };

  const dropZone         = document.getElementById('drop-zone');
  const btnBrowse        = document.getElementById('btn-browse');
  const btnSettings      = document.getElementById('btn-settings');
  const btnCloseSet      = document.getElementById('btn-close-settings');
  const btnSaveSet       = document.getElementById('btn-save-settings');
  const btnPickDir       = document.getElementById('btn-pick-dir');
  const btnPickBg        = document.getElementById('btn-pick-bg');
  const btnOpenFolder    = document.getElementById('btn-open-folder');
  const btnNew           = document.getElementById('btn-new');
  const settingsOverlay  = document.getElementById('settings-overlay');

  const pipelineFile     = document.getElementById('pipeline-filename');
  const pipelineStatus   = document.getElementById('pipeline-status');
  const pipelineBar      = document.getElementById('pipeline-bar');
  const pipelineDetail   = document.getElementById('pipeline-detail');
  const galleryGrid      = document.getElementById('gallery-grid');

  const inputApiKey      = document.getElementById('input-apikey');
  const inputOutDir      = document.getElementById('input-outdir');
  const inputCustomBg    = document.getElementById('input-custombg');
  const selectCaptions    = document.getElementById('select-captions');
  const selectFontWeight    = document.getElementById('select-fontweight');
  const inputHighlightColor = document.getElementById('input-highlight-color');
  const inputHighlightHex   = document.getElementById('input-highlight-hex');
  const inputMaxClips    = document.getElementById('input-maxclips');
  const toggleHelios     = document.getElementById('toggle-helios');
  const fieldCustomBg    = document.getElementById('field-custom-bg');

  let currentOutputDir = '';
  let cleanupFns = [];

  // ── View switching ──────────────────────────────
  function showView(name) {
    Object.entries(views).forEach(([key, el]) => {
      el.classList.toggle('active', key === name);
    });
  }

  // ── Toast notifications ─────────────────────────
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('visible');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('visible'), 4000);
  }

  // ── Background mode tile helpers ────────────────
  function getSelectedBgMode() {
    const checked = document.querySelector('input[name="bg-mode"]:checked');
    return checked ? checked.value : 'blur-stack';
  }

  function setSelectedBgMode(val) {
    const radio = document.querySelector(`input[name="bg-mode"][value="${val}"]`);
    if (radio) radio.checked = true;
    else {
      const fallback = document.querySelector('input[name="bg-mode"][value="blur-stack"]');
      if (fallback) fallback.checked = true;
    }
    updateCustomBgVisibility();
  }

  function updateCustomBgVisibility() {
    fieldCustomBg.style.display = getSelectedBgMode() === 'custom-image' ? 'block' : 'none';
  }

  document.querySelectorAll('input[name="bg-mode"]').forEach((radio) => {
    radio.addEventListener('change', updateCustomBgVisibility);
  });

  // ── Settings ────────────────────────────────────
  async function loadSettings() {
    const s = await window.clipgen.getSettings();
    inputApiKey.value       = s.anthropicApiKey || '';
    inputOutDir.value       = s.outputDir || '';
    inputCustomBg.value     = s.customBgPath || '';
    selectCaptions.value    = s.captionStyle || 'bold-highlight';
    selectFontWeight.value    = s.captionFontWeight || 'bold';
    const hlColor = s.captionHighlightColor || '#2d2d2d';
    inputHighlightColor.value = hlColor;
    inputHighlightHex.value   = hlColor;
    inputMaxClips.value     = s.maxClips || 5;
    toggleHelios.checked    = !!s.heliosEnabled;
    currentOutputDir        = s.outputDir || '';
    setSelectedBgMode(s.backgroundMode || 'blur-stack');
  }

  btnSettings.addEventListener('click', () => {
    loadSettings();
    settingsOverlay.classList.add('active');
    updateHeliosStatus();
  });
  btnCloseSet.addEventListener('click', () => settingsOverlay.classList.remove('active'));
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.remove('active');
  });

  // Keep color picker and hex text in sync
  inputHighlightColor.addEventListener('input', () => {
    inputHighlightHex.value = inputHighlightColor.value;
  });
  inputHighlightHex.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(inputHighlightHex.value)) {
      inputHighlightColor.value = inputHighlightHex.value;
    }
  });

  btnPickDir.addEventListener('click', async () => {
    const dir = await window.clipgen.chooseOutputDir();
    if (dir) { inputOutDir.value = dir; currentOutputDir = dir; }
  });

  btnPickBg.addEventListener('click', async () => {
    const imgPath = await window.clipgen.chooseBgImage();
    if (imgPath) inputCustomBg.value = imgPath;
  });

  btnSaveSet.addEventListener('click', async () => {
    await window.clipgen.setSettings({
      anthropicApiKey: inputApiKey.value.trim(),
      outputDir:       inputOutDir.value.trim(),
      backgroundMode:  getSelectedBgMode(),
      customBgPath:    inputCustomBg.value.trim(),
      captionStyle:       selectCaptions.value,
      captionFontWeight:      selectFontWeight.value,
      captionHighlightColor:  inputHighlightHex.value || '#2d2d2d',
      maxClips:        parseInt(inputMaxClips.value, 10) || 5,
      heliosEnabled:   toggleHelios.checked,
    });
    settingsOverlay.classList.remove('active');
    toast('Settings saved');
  });

  // ── File drop via will-navigate interception ────
  window.clipgen.onFileDropped((filePath) => {
    const name = filePath.split('\\').pop();
    handleFile({ path: filePath, name });
  });

  // ── Drag & Drop (DOM fallback) ───────────────────
  const dropView = document.getElementById('view-drop');

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, true);
  window.addEventListener('drop', (e) => { e.preventDefault(); }, true);

  dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'));
  dropZone.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
  });

  dropView.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0) handleFile(files[0]);
  });

  dropZone.addEventListener('click', () => btnBrowse.click());

  btnBrowse.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/mp4,video/quicktime,.mp4,.MP4,.mov,.MOV';
    input.onchange = () => { if (input.files.length > 0) handleFile(input.files[0]); };
    input.click();
  });

  // ── Pipeline ────────────────────────────────────
  const stepOrder = ['extracting', 'transcribing', 'analyzing', 'rendering'];

  function updateStepper(currentStep) {
    const currentIdx = stepOrder.indexOf(currentStep);
    const steps = document.querySelectorAll('.step');
    const lines = document.querySelectorAll('.step__line');
    steps.forEach((el, i) => {
      el.classList.remove('active', 'done');
      if (i < currentIdx) el.classList.add('done');
      else if (i === currentIdx) el.classList.add('active');
    });
    lines.forEach((el, i) => { el.classList.toggle('done', i < currentIdx); });
  }

  async function handleFile(file) {
    if (!/\.(mp4|mov)$/i.test(file.name)) {
      toast('Please drop an MP4 or MOV file');
      return;
    }

    showView('pipeline');
    pipelineFile.textContent = file.name;
    pipelineStatus.textContent = 'Starting…';
    pipelineBar.style.width = '0%';
    pipelineDetail.textContent = '';

    document.querySelectorAll('.step').forEach((el) => el.classList.remove('active', 'done'));
    document.querySelectorAll('.step__line').forEach((el) => el.classList.remove('done'));

    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];

    cleanupFns.push(window.clipgen.onStep((data) => {
      if (data.step === 'error') {
        pipelineStatus.textContent = 'Error';
        pipelineDetail.textContent = data.message;
        toast(data.message);
        return;
      }
      if (data.step === 'done') {
        pipelineStatus.textContent = data.message;
        pipelineBar.style.width = '100%';
        return;
      }
      pipelineStatus.textContent = data.message;
      updateStepper(data.step);
      pipelineBar.style.width = '0%';
    }));

    cleanupFns.push(window.clipgen.onProgress((data) => {
      pipelineBar.style.width = data.percent + '%';
      if (data.detail) pipelineDetail.textContent = data.detail;
    }));

    try {
      const filePath = file.path;
      const clips = await window.clipgen.processVideo(filePath);
      renderGallery(clips);
    } catch (err) {
      pipelineStatus.textContent = 'Error';
      pipelineDetail.textContent = err.message || 'Processing failed';
      toast(err.message || 'Processing failed');
    }
  }

  // ── Gallery ─────────────────────────────────────
  function renderGallery(clips) {
    showView('gallery');
    galleryGrid.innerHTML = '';

    clips.forEach((clip) => {
      const card = document.createElement('div');
      card.className = 'clip-card';
      const dur      = Math.round(clip.duration);
      const startFmt = fmtTime(clip.start_time);
      const endFmt   = fmtTime(clip.end_time);

      card.innerHTML = `
        <div class="clip-card__preview">
          <video src="file:///${clip.filePath.replace(/\\/g, '/')}" preload="none" muted></video>
          <button class="clip-card__play">▶</button>
        </div>
        <div class="clip-card__info">
          <div class="clip-card__headline">${escapeHtml(clip.headline)}</div>
          <div class="clip-card__meta">${startFmt} → ${endFmt} · ${dur}s</div>
        </div>
      `;

      const video   = card.querySelector('video');
      const playBtn = card.querySelector('.clip-card__play');

      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (video.paused) {
          document.querySelectorAll('.clip-card video').forEach((v) => {
            v.pause(); v.currentTime = 0;
          });
          video.muted = false;
          video.play();
          playBtn.textContent = '⏸';
        } else {
          video.pause();
          playBtn.textContent = '▶';
        }
      });

      video.addEventListener('ended', () => { playBtn.textContent = '▶'; });

      // Social metadata panel
      if (clip.socialMetadata) {
        const social = parseSocialMetadata(clip.socialMetadata);
        if (social) card.appendChild(buildSocialPanel(social));
      }

      galleryGrid.appendChild(card);
    });
  }

  // ── Helios status indicator ──────────────────────
  async function updateHeliosStatus() {
    const el = document.getElementById('helios-status-desc');
    if (!el) return;
    try {
      const status = await window.clipgen.checkHelios();
      if (status.ready) {
        el.textContent = 'Generates animated brand graphics synced to your content · Ready';
        el.style.color = 'var(--success)';
      } else if (status.rendererInstalled && !status.chromiumInstalled) {
        el.textContent = 'Renderer installed · Browser will download on first use (~150 MB)';
        el.style.color = 'var(--warning)';
      } else {
        el.textContent = 'Generates animated brand graphics · Will auto-install on first use (~150 MB download)';
        el.style.color = '';
      }
    } catch {
      el.textContent = 'Generates animated brand graphics synced to your content';
      el.style.color = '';
    }
  }

  // ── Social metadata helpers ──────────────────────
  function parseSocialMetadata(text) {
    if (!text) return null;
    const get = (section, key, multiline = false) => {
      const secMatch = text.match(new RegExp(`--- ${section} ---([\\s\\S]*?)(?=---|$)`));
      if (!secMatch) return '';
      if (multiline) {
        const m = secMatch[1].match(new RegExp(`${key}:\\n?([\\s\\S]+)`));
        return m ? m[1].trim() : '';
      }
      const m = secMatch[1].match(new RegExp(`${key}:\\s*(.+)`));
      return m ? m[1].trim() : '';
    };
    return {
      youtube: {
        title:       get('YOUTUBE SHORTS', 'Title'),
        description: get('YOUTUBE SHORTS', 'Description'),
        hashtags:    get('YOUTUBE SHORTS', 'Hashtags'),
      },
      tiktok: {
        caption: get('TIKTOK', 'Caption'),
      },
      instagram: {
        caption:  get('INSTAGRAM REELS', 'Caption'),
        hashtags: get('INSTAGRAM REELS', 'Hashtags'),
      },
    };
  }

  function buildSocialPanel(social) {
    const LIMITS = {
      'YT Title': 60, 'YT Description': 160, 'TT Caption': 150, 'IG Caption': 125,
    };

    const wrap = document.createElement('div');
    wrap.className = 'social-wrap';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'social-toggle-btn';
    toggleBtn.innerHTML = '<span>Social Content</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>';
    wrap.appendChild(toggleBtn);

    const panel = document.createElement('div');
    panel.className = 'social-panel';
    wrap.appendChild(panel);

    toggleBtn.addEventListener('click', () => {
      const open = wrap.classList.toggle('social-open');
      if (open) panel.style.display = 'block';
      else panel.style.display = 'none';
    });
    panel.style.display = 'none';

    // Tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'social-tabs';

    const panes = [];
    const tabs  = [];
    const platforms = [
      {
        key: 'yt', label: 'YouTube',
        fields: [
          { label: 'Title',       text: social.youtube.title,       limit: 60  },
          { label: 'Description', text: social.youtube.description,  limit: 160 },
          { label: 'Hashtags',    text: social.youtube.hashtags                },
        ],
      },
      {
        key: 'tt', label: 'TikTok',
        fields: [
          { label: 'Caption', text: social.tiktok.caption, limit: 150 },
        ],
      },
      {
        key: 'ig', label: 'Instagram',
        fields: [
          { label: 'Caption',  text: social.instagram.caption,  limit: 125 },
          { label: 'Hashtags', text: social.instagram.hashtags             },
        ],
      },
    ];

    platforms.forEach(({ key, label, fields }, i) => {
      const tab = document.createElement('button');
      tab.className = 'social-tab' + (i === 0 ? ' active' : '');
      tab.textContent = label;
      tabBar.appendChild(tab);
      tabs.push(tab);

      const pane = document.createElement('div');
      pane.className = 'social-pane' + (i === 0 ? ' active' : '');

      fields.forEach(({ label: fLabel, text, limit }) => {
        if (!text) return;
        const field = document.createElement('div');
        field.className = 'social-field';

        const hdr = document.createElement('div');
        hdr.className = 'social-field__hdr';

        const lbl = document.createElement('span');
        lbl.className = 'social-field__label';
        lbl.textContent = fLabel;

        if (limit) {
          const cnt = document.createElement('span');
          cnt.className = 'social-charcount' + (text.length > limit ? ' over' : '');
          cnt.textContent = ` ${text.length}/${limit}`;
          lbl.appendChild(cnt);
        }

        const copyBtn = document.createElement('button');
        copyBtn.className = 'social-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(text);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });

        hdr.appendChild(lbl);
        hdr.appendChild(copyBtn);

        const txt = document.createElement('div');
        txt.className = 'social-field__text';
        txt.textContent = text;

        field.appendChild(hdr);
        field.appendChild(txt);
        pane.appendChild(field);
      });

      panes.push(pane);
      panel.appendChild(pane);

      tab.addEventListener('click', () => {
        tabs.forEach(t  => t.classList.remove('active'));
        panes.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        pane.classList.add('active');
      });
    });

    panel.insertBefore(tabBar, panel.firstChild);
    return wrap;
  }

  btnOpenFolder.addEventListener('click', () => {
    if (currentOutputDir) window.clipgen.openFolder(currentOutputDir);
  });

  btnNew.addEventListener('click', () => { showView('drop'); });

  // ── Utilities ───────────────────────────────────
  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Auto-updater UI ──────────────────────────────
  const updateBanner      = document.getElementById('update-banner');
  const updateMsg         = document.getElementById('update-banner__msg');
  const updateProgressBar = document.getElementById('update-progress-bar');
  const updateProgressFill= document.getElementById('update-progress-fill');
  const updateInstallBtn  = document.getElementById('update-install-btn');

  function showUpdateBanner(message, showProgress = false, showInstall = false) {
    updateMsg.textContent = message;
    updateProgressBar.style.display = showProgress ? 'block' : 'none';
    updateInstallBtn.style.display  = showInstall  ? 'block' : 'none';
    updateBanner.classList.add('visible');
  }

  if (window.clipgen.onUpdateStatus) {
    window.clipgen.onUpdateStatus((data) => {
      if (data.status === 'available') {
        showUpdateBanner(`Update v${data.version} available — downloading…`, true, false);
      } else if (data.status === 'ready') {
        updateProgressBar.style.display = 'none';
        showUpdateBanner(`v${data.version} ready — restart to apply.`, false, true);
      }
    });

    window.clipgen.onUpdateProgress((data) => {
      updateProgressFill.style.width = data.percent + '%';
    });

    updateInstallBtn.addEventListener('click', () => {
      window.clipgen.installUpdate();
    });
  }

  // ── Init ────────────────────────────────────────
  loadSettings();
  showView('drop');
})();
