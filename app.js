'use strict';

(() => {
  /* ---------- Configuração ---------- */
  const MAX_BYTES = 250 * 1024 * 1024;
  const MAX_SECONDS = 30 * 60;
  const MIN_SECONDS = 1;
  const MAX_CHANNELS = 8;

  // Fonte única de verdade: valores vêm daqui, nunca de atributos do DOM.
  const PROFILES = {
    streaming: { label: 'Streaming', sub: 'Spotify, YouTube, Tidal, Amazon', target: -14, ceiling: -1 },
    apple: { label: 'Apple Music / Podcast', sub: 'Apple Music, Apple Podcasts', target: -16, ceiling: -1 },
    ebu: { label: 'TV — EBU R128', sub: 'Broadcast −23 LUFS', target: -23, ceiling: -1 },
    atsc: { label: 'TV — ATSC A/85', sub: 'Broadcast EUA', target: -24, ceiling: -2 },
    custom: { label: 'Personalizado', sub: 'Parâmetros manuais', target: null, ceiling: null },
  };
  const PRESETS = {
    voice: { lookaheadMs: 3, releaseMs: 150 },
    modern: { lookaheadMs: 1.5, releaseMs: 60 },
    smooth: { lookaheadMs: 5, releaseMs: 250 },
  };
  const FORMAT_INFO = {
    wav24: { label: 'WAV 24-bit', ext: 'wav', suffix: '_24bit' },
    wav16: { label: 'WAV 16-bit', ext: 'wav', suffix: '_16bit' },
    mp3: { label: 'MP3 320', ext: 'mp3', suffix: '' },
  };

  /* ---------- Trusted Types: só permite criar o worker a partir de uma URL fixa ---------- */
  const WORKER_URL = 'worker.js';
  const tt = window.trustedTypes
    ? window.trustedTypes.createPolicy('loudness', {
        createScriptURL: (u) => {
          if (u === WORKER_URL) return u;
          throw new TypeError('URL de script não permitida');
        },
      })
    : null;

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    notice: $('notice'),
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    progress: $('progress'),
    progressLabel: $('progressLabel'),
    progressPct: $('progressPct'),
    progressBar: $('progressBar'),
    progressFill: $('progressFill'),
    workspace: $('workspace'),
    fileName: $('fileName'),
    fileMeta: $('fileMeta'),
    waveCanvas: $('waveCanvas'),
    mLufs: $('mLufs'),
    mTp: $('mTp'),
    mLra: $('mLra'),
    mSp: $('mSp'),
    scaleMarker: $('scaleMarker'),
    originalPlayer: $('originalPlayer'),
    changeFileBtn: $('changeFileBtn'),
    form: $('settingsForm'),
    characterField: $('characterField'),
    customControls: $('customControls'),
    customSummary: $('customSummary'),
    sliderLufs: $('sliderLufs'),
    sliderTp: $('sliderTp'),
    outLufs: $('outLufs'),
    outTp: $('outTp'),
    processBtn: $('processBtn'),
    results: $('results'),
    resultList: $('resultList'),
    zipBtn: $('zipBtn'),
    steps: document.querySelectorAll('.step'),
  };

  /* ---------- Estado ---------- */
  const state = {
    baseName: 'audio',
    sampleRate: 0,
    channels: 0,
    peaks: null,
    analysis: null,
    files: [], // { name, blob }
    urls: new Set(),
    busy: false,
    worker: null,
    jobSeq: 0,
  };

  /* ---------- Helpers ---------- */
  const fmtNum = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d).replace('-', '−') : '−∞');
  const fmtSigned = (v, d = 1) => (Number.isFinite(v) ? (v > 0 ? '+' : '') + fmtNum(v, d) : '—');
  const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtDuration = (s) => {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${String(ss).padStart(2, '0')}`;
  };

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children) if (c != null) node.append(c); // append(string) cria nó de texto: seguro contra XSS
    return node;
  }

  function trackUrl(blob) {
    const url = URL.createObjectURL(blob);
    state.urls.add(url);
    return url;
  }
  function revokeAll() {
    for (const u of state.urls) URL.revokeObjectURL(u);
    state.urls.clear();
  }

  // Remove caracteres de controle, separadores de caminho e reservados no Windows; limita o tamanho.
  function sanitizeBaseName(name) {
    const dot = name.lastIndexOf('.');
    let base = dot > 0 ? name.slice(0, dot) : name;
    base = base
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80);
    if (!base || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = 'audio';
    return base;
  }

  function notify(message, kind = 'info') {
    el.notice.textContent = message;
    el.notice.className = `notice${kind === 'info' ? '' : ` notice--${kind}`}`;
    el.notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.notice.hidden = false;
    clearTimeout(notify.t);
    if (kind !== 'error') notify.t = setTimeout(() => { el.notice.hidden = true; }, 6000);
  }
  const clearNotice = () => { el.notice.hidden = true; };

  function setStep(n) {
    el.steps.forEach((s) => {
      const i = Number(s.dataset.step);
      s.classList.toggle('is-active', i === n);
      s.classList.toggle('is-done', i < n);
      if (i === n) s.setAttribute('aria-current', 'step'); else s.removeAttribute('aria-current');
    });
  }

  function setProgress(value, label) {
    const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
    el.progressFill.style.width = `${pct}%`;
    el.progressPct.textContent = `${pct}%`;
    el.progressBar.setAttribute('aria-valuenow', String(pct));
    if (label) el.progressLabel.textContent = label;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.processBtn.disabled = busy;
    el.zipBtn.disabled = busy;
    el.changeFileBtn.disabled = busy;
    el.fileInput.disabled = busy;
    el.processBtn.textContent = busy ? 'Processando…' : 'Processar áudio';
  }

  /* ---------- Detecção de formato pelos bytes (não confia em extensão/MIME) ---------- */
  function sniff(b) {
    if (b.length < 12) return null;
    const s = (o, n) => String.fromCharCode.apply(null, b.subarray(o, o + n));
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

    if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') {
      let o = 12;
      while (o + 8 <= b.length && o < 1 << 20) {
        const id = s(o, 4);
        const size = dv.getUint32(o + 4, true);
        if (id === 'fmt ' && o + 16 <= b.length) return { format: 'WAV', sampleRate: dv.getUint32(o + 12, true) };
        o += 8 + size + (size & 1);
      }
      return { format: 'WAV', sampleRate: null };
    }
    if (s(0, 4) === 'fLaC' && b.length > 22) {
      const d = 8;
      return { format: 'FLAC', sampleRate: (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4) || null };
    }
    if (s(0, 4) === 'OggS') {
      const head = s(0, Math.min(b.length, 1024));
      if (head.includes('OpusHead')) return { format: 'Opus', sampleRate: 48000 };
      const vi = head.indexOf('\x01vorbis');
      if (vi >= 0 && vi + 16 <= b.length) return { format: 'OGG Vorbis', sampleRate: dv.getUint32(vi + 12, true) };
      return { format: 'OGG', sampleRate: null };
    }
    if (s(4, 4) === 'ftyp') return { format: 'M4A/AAC', sampleRate: null };
    if (s(0, 4) === 'FORM' && /^AIF[FC]$/.test(s(8, 4))) return { format: 'AIFF', sampleRate: null };

    let o = 0;
    if (s(0, 3) === 'ID3') o = 10 + (((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127));
    for (let i = o; i + 4 <= b.length && i < o + 8192; i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      const layer = (b[i + 1] >> 1) & 3;
      if (layer === 0) {
        const AAC = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        return { format: 'AAC', sampleRate: AAC[(b[i + 2] >> 2) & 15] || null };
      }
      const ver = (b[i + 1] >> 3) & 3;
      const sri = (b[i + 2] >> 2) & 3;
      if (ver === 1 || sri === 3) continue;
      const T = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
      return { format: 'MP3', sampleRate: T[ver][sri] };
    }
    return null;
  }

  // Decodifica na taxa original do arquivo (evita reamostragem silenciosa para a taxa da placa de som).
  async function decode(arrayBuffer, rate) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('Seu navegador não suporta Web Audio.');
    let ctx;
    try { ctx = new Ctx(1, 1, rate || 48000); } catch (_) { ctx = new Ctx(1, 1, 48000); }
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  /* ---------- Worker ---------- */
  function newWorker() {
    if (state.worker) state.worker.terminate(); // libera memória e cancela jobs antigos
    state.worker = new Worker(tt ? tt.createScriptURL(WORKER_URL) : WORKER_URL);
    return state.worker;
  }

  function runJob(msg, transfer, handlers) {
    const worker = state.worker;
    const id = ++state.jobSeq;
    return new Promise((resolve, reject) => {
      const onMessage = (e) => {
        const m = e.data;
        if (!m || m.id !== id) return;
        if (m.type === 'progress') handlers.progress && handlers.progress(m);
        else if (m.type === 'profile') handlers.profile && handlers.profile(m);
        else if (m.type === 'result') { cleanup(); resolve(m); }
        else if (m.type === 'error') { cleanup(); reject(new Error(m.message)); }
      };
      const onError = (e) => { cleanup(); reject(new Error(e.message || 'Falha no processamento.')); };
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(Object.assign({ id }, msg), transfer);
    });
  }

  /* ---------- Fluxo: arquivo ---------- */
  async function handleFile(file) {
    if (state.busy || !file) return;
    clearNotice();

    if (file.size === 0) return notify('O arquivo está vazio.', 'error');
    if (file.size > MAX_BYTES) return notify(`Arquivo muito grande (${fmtBytes(file.size)}). O limite é ${fmtBytes(MAX_BYTES)}.`, 'error');

    resetResults();
    revokeAll();
    setBusy(true);
    el.dropzone.hidden = true;
    el.workspace.hidden = true;
    el.progress.hidden = false;
    setProgress(0.02, 'Lendo arquivo…');

    try {
      const buf = await file.arrayBuffer();
      const info = sniff(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1 << 20)));
      if (!info) throw new Error('Formato não reconhecido. Envie WAV, FLAC, MP3, AAC/M4A, OGG/Opus ou AIFF.');

      setProgress(0.08, 'Decodificando áudio…');
      const audio = await decode(buf, info.sampleRate).catch(() => {
        throw new Error('Não foi possível decodificar este arquivo. Ele pode estar corrompido ou usar um codec não suportado pelo navegador.');
      });

      if (audio.duration < MIN_SECONDS) throw new Error('O áudio precisa ter pelo menos 1 segundo.');
      if (audio.duration > MAX_SECONDS) throw new Error(`Áudio muito longo (${fmtDuration(audio.duration)}). O limite é 30 minutos.`);
      if (audio.numberOfChannels > MAX_CHANNELS) throw new Error('Máximo de 8 canais.');

      const channels = [];
      for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c).slice());

      newWorker();
      const res = await runJob(
        { type: 'analyze', channels, sampleRate: audio.sampleRate },
        channels.map((c) => c.buffer),
        { progress: (m) => setProgress(0.1 + m.value * 0.9, m.label) }
      );

      if (!Number.isFinite(res.integrated)) throw new Error('O arquivo parece estar em silêncio (abaixo de −70 LUFS).');

      state.baseName = sanitizeBaseName(file.name);
      state.sampleRate = audio.sampleRate;
      state.channels = audio.numberOfChannels;
      state.analysis = res;
      state.peaks = res.peaks;

      el.fileName.textContent = file.name;
      el.fileName.title = file.name;
      const chLabel = audio.numberOfChannels === 1 ? 'Mono' : audio.numberOfChannels === 2 ? 'Estéreo' : `${audio.numberOfChannels} canais`;
      el.fileMeta.textContent = `${info.format} · ${(audio.sampleRate / 1000).toFixed(1)} kHz · ${chLabel} · ${fmtDuration(audio.duration)} · ${fmtBytes(file.size)}`;
      el.originalPlayer.src = trackUrl(file);
      renderAnalysis(res);

      el.progress.hidden = true;
      el.workspace.hidden = false;
      drawWave(el.waveCanvas, state.peaks);
      setStep(2);
    } catch (err) {
      el.progress.hidden = true;
      el.dropzone.hidden = false;
      setStep(1);
      notify(err.message || 'Erro ao ler o arquivo.', 'error');
    } finally {
      setBusy(false);
      el.fileInput.value = '';
    }
  }

  function renderAnalysis(a) {
    el.mLufs.textContent = fmtNum(a.integrated);
    el.mTp.textContent = fmtNum(a.truePeakDb);
    el.mLra.textContent = fmtNum(a.lra);
    el.mSp.textContent = fmtNum(a.samplePeakDb);
    el.mTp.parentElement.parentElement.classList.toggle('is-danger', a.truePeakDb > 0);
    el.mTp.parentElement.parentElement.classList.toggle('is-warn', a.truePeakDb > -1 && a.truePeakDb <= 0);
    const pos = Math.max(0, Math.min(100, ((a.integrated + 36) / 36) * 100));
    el.scaleMarker.style.left = `${pos}%`;
  }

  /* ---------- Waveform (nítida em telas HiDPI) ---------- */
  function drawWave(canvas, peaks, color) {
    if (!peaks || !canvas.isConnected) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);

    const mid = hgt / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, mid, w, 1);

    const n = peaks.length / 2;
    const bar = 2;
    const gap = 1;
    const cols = Math.floor(w / (bar + gap));
    ctx.fillStyle = color || '#7dd3fc';
    for (let i = 0; i < cols; i++) {
      const s = Math.floor((i / cols) * n);
      const e = Math.max(s + 1, Math.floor(((i + 1) / cols) * n));
      let mn = 0, mx = 0;
      for (let j = s; j < e; j++) {
        if (peaks[j * 2] < mn) mn = peaks[j * 2];
        if (peaks[j * 2 + 1] > mx) mx = peaks[j * 2 + 1];
      }
      const y1 = mid - Math.min(1, mx) * (mid - 2);
      const y2 = mid - Math.max(-1, mn) * (mid - 2);
      ctx.fillRect(i * (bar + gap), y1, bar, Math.max(1, y2 - y1));
    }
  }

  const waveObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const c = entry.target;
      if (c === el.waveCanvas) drawWave(c, state.peaks);
      else if (c._peaks) drawWave(c, c._peaks, '#4ade80');
    }
  });
  waveObserver.observe(el.waveCanvas);

  /* ---------- Fluxo: processamento ---------- */
  function readSettings() {
    const content = el.form.querySelector('input[name="content"]:checked').value;
    const character = el.form.querySelector('input[name="character"]:checked').value;
    const preset = content === 'music' ? PRESETS[character] || PRESETS.modern : PRESETS.voice;

    const profiles = [];
    el.form.querySelectorAll('input[name="profile"]:checked').forEach((input) => {
      const def = PROFILES[input.value];
      if (!def) return;
      if (input.value === 'custom') {
        const target = clampNum(el.sliderLufs.value, -30, -6, -12);
        const ceiling = clampNum(el.sliderTp.value, -3, 0, -1);
        profiles.push({ key: 'custom', label: def.label, target, ceiling });
      } else {
        profiles.push({ key: input.value, label: def.label, target: def.target, ceiling: def.ceiling });
      }
    });
    const formats = [...el.form.querySelectorAll('input[name="format"]:checked')]
      .map((i) => i.value)
      .filter((v) => Object.prototype.hasOwnProperty.call(FORMAT_INFO, v));
    return { preset, profiles, formats };
  }

  function clampNum(v, lo, hi, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }

  function resetResults() {
    for (const c of el.resultList.querySelectorAll('canvas')) waveObserver.unobserve(c);
    el.resultList.replaceChildren();
    el.results.hidden = true;
    for (const f of state.files) f.url && state.urls.delete(f.url) && URL.revokeObjectURL(f.url);
    state.files = [];
  }

  async function processAudio(e) {
    e.preventDefault();
    if (state.busy || !state.analysis) return;
    clearNotice();
    const { preset, profiles, formats } = readSettings();
    if (!profiles.length) return notify('Selecione pelo menos um perfil de entrega.', 'error');
    if (!formats.length) return notify('Selecione pelo menos um formato de saída.', 'error');

    resetResults();
    setBusy(true);
    el.progress.hidden = false;
    setProgress(0, 'Preparando…');

    try {
      await runJob({ type: 'process', profiles, formats, preset }, [], {
        progress: (m) => setProgress(m.value, m.label),
        profile: (m) => renderResult(m, profiles.find((p) => p.key === m.key)),
      });
      el.results.hidden = false;
      setStep(3);
      notify('Pronto! Ouça o resultado e baixe os arquivos.', 'success');
      el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      notify(err.message || 'Erro durante o processamento.', 'error');
    } finally {
      el.progress.hidden = true;
      setBusy(false);
    }
  }

  function renderResult(m, profile) {
    const label = profile ? profile.label : m.key;
    const targetTxt = `${fmtNum(m.target)} LUFS`;
    const ok = Math.abs(m.lufs - m.target) <= 0.5 && m.tpDb <= m.ceiling + 0.01;

    const files = m.files.map((f) => {
      const info = FORMAT_INFO[f.format];
      const blob = new Blob([f.buffer], { type: f.mime });
      const name = `${state.baseName}_${m.key}_${fmtNum(m.target).replace('−', '-')}LUFS${info.suffix}.${info.ext}`;
      const url = trackUrl(blob);
      const entry = { name, blob, url, format: f.format };
      state.files.push(entry);
      return entry;
    });

    const canvas = h('canvas', { class: 'result__wave', role: 'img', 'aria-label': `Forma de onda processada — ${label}` });
    canvas._peaks = m.peaks;

    const stat = (k, v) => h('div', null, h('dt', { text: k }), h('dd', { text: v }));
    const preview = files.find((f) => f.format === 'wav24') || files.find((f) => f.format === 'wav16') || files[0];

    const downloads = files.map((f) => {
      const a = h('a', { class: 'btn btn--secondary btn--sm', href: f.url },
        `${FORMAT_INFO[f.format].label} `, h('span', { class: 'size', text: `· ${fmtBytes(f.blob.size)}` }));
      a.download = f.name; // atribuído via propriedade: o nome nunca é interpretado como HTML
      return a;
    });

    const card = h('article', { class: 'result' },
      h('header', { class: 'result__head' },
        h('div', null,
          h('h3', { text: label }),
          h('p', { class: 'result__sub', text: `Alvo ${targetTxt} · teto ${fmtNum(m.ceiling)} dBTP` })),
        h('span', { class: `badge ${ok ? 'badge--ok' : 'badge--warn'}`, text: ok ? 'Dentro da especificação' : 'Verifique' })),
      h('div', { class: 'result__wave-box' }, canvas),
      h('dl', { class: 'result__stats' },
        stat('Saída', `${fmtNum(m.lufs)} LUFS`),
        stat('True Peak', `${fmtNum(m.tpDb)} dBTP`),
        stat('Ganho', `${fmtSigned(m.gainDb)} dB`),
        stat('Limiter (máx.)', `${fmtNum(-m.maxGrDb)} dB`)),
      m.warnings && m.warnings.length
        ? h('ul', { class: 'result__warnings' }, ...m.warnings.map((w) => h('li', { text: w })))
        : null,
      preview ? h('audio', { controls: true, preload: 'none', src: preview.url, class: 'result__player' }) : null,
      h('div', { class: 'result__downloads' }, ...downloads));

    el.resultList.append(card);
    el.results.hidden = false;
    waveObserver.observe(canvas);
  }

  async function downloadZip() {
    if (state.busy || !state.files.length) return;
    if (typeof JSZip === 'undefined') return notify('Não foi possível carregar o gerador de ZIP.', 'error');
    setBusy(true);
    try {
      const zip = new JSZip();
      const used = new Set();
      for (const f of state.files) {
        let name = f.name;
        for (let i = 2; used.has(name); i++) name = f.name.replace(/(\.\w+)$/, `_${i}$1`);
        used.add(name);
        zip.file(name, f.blob, { binary: true });
      }
      // STORE: áudio quase não comprime e gerar fica muito mais rápido
      const content = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const url = URL.createObjectURL(content);
      const a = h('a', { href: url });
      a.download = `${state.baseName}_loudness.zip`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (_) {
      notify('Erro ao gerar o ZIP.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function resetAll() {
    if (state.busy) return;
    resetResults();
    revokeAll();
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    el.originalPlayer.removeAttribute('src');
    el.originalPlayer.load();
    state.analysis = null;
    state.peaks = null;
    el.workspace.hidden = true;
    el.dropzone.hidden = false;
    clearNotice();
    setStep(1);
    el.fileInput.focus();
  }

  /* ---------- Eventos ---------- */
  el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files && el.fileInput.files[0]));

  ['dragenter', 'dragover'].forEach((t) => el.dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('is-dragover');
  }));
  ['dragleave', 'drop'].forEach((t) => el.dropzone.addEventListener(t, () => el.dropzone.classList.remove('is-dragover')));
  el.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) handleFile(files[0]);
  });
  // Evita que soltar um arquivo fora da área faça o navegador abrir/navegar para ele
  ['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => {
    if (!el.dropzone.contains(e.target)) e.preventDefault();
  }));

  el.changeFileBtn.addEventListener('click', resetAll);
  el.form.addEventListener('submit', processAudio);
  el.zipBtn.addEventListener('click', downloadZip);

  el.form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'content') el.characterField.hidden = t.value !== 'music';
    if (t.name === 'profile' && t.value === 'custom') el.customControls.hidden = !t.checked;
    if (t.name === 'profile' || t.name === 'format' || t.name === 'content' || t.name === 'character') {
      if (!el.results.hidden) setStep(2); // ajustes mudaram: resultado atual está desatualizado
    }
  });

  function updateCustomLabels() {
    const l = clampNum(el.sliderLufs.value, -30, -6, -12);
    const t = clampNum(el.sliderTp.value, -3, 0, -1);
    el.outLufs.textContent = `${fmtNum(l)} LUFS`;
    el.outTp.textContent = `${fmtNum(t)} dBTP`;
    el.customSummary.textContent = `${fmtNum(l)} LUFS · ${fmtNum(t)} dBTP`;
  }
  el.sliderLufs.addEventListener('input', updateCustomLabels);
  el.sliderTp.addEventListener('input', updateCustomLabels);
  updateCustomLabels();

  // Pausa os outros players quando um começa a tocar
  document.addEventListener('play', (e) => {
    document.querySelectorAll('audio').forEach((a) => { if (a !== e.target) a.pause(); });
  }, true);

  window.addEventListener('pagehide', revokeAll);
  const year = $('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
