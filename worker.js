'use strict';
/*
 * Worker de DSP — roda fora da thread principal (a interface não trava).
 *  - Medição ITU-R BS.1770-4 / EBU R128: K-weighting, gating absoluto/relativo, LRA (EBU Tech 3342)
 *  - True Peak com oversampling 4x
 *  - Limiter true-peak com lookahead (sem clipping) + compensação iterativa de loudness
 *  - Encoders WAV 16/24-bit (com dither TPDF no 16-bit) e MP3 (lamejs)
 */

const LAME_URL = 'vendor/lame.min.js';
const ttPolicy = self.trustedTypes
  ? self.trustedTypes.createPolicy('loudness', {
      createScriptURL: (u) => {
        if (u === LAME_URL) return u;
        throw new TypeError('URL de script não permitida');
      },
    })
  : null;

let lameReady = false;
function ensureLame() {
  if (lameReady) return true;
  try {
    importScripts(ttPolicy ? ttPolicy.createScriptURL(LAME_URL) : LAME_URL);
    lameReady = typeof lamejs !== 'undefined' && typeof lamejs.Mp3Encoder === 'function';
  } catch (_) {
    lameReady = false;
  }
  return lameReady;
}

/* ---------- utilidades ---------- */
const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const energyToLufs = (e) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);
const ABS_GATE_ENERGY = Math.pow(10, (-70 + 0.691) / 10);

let state = null; // { channels, sampleRate, env, analysis }

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

/* ---------- K-weighting (coeficientes para qualquer taxa — mesma derivação do libebur128) ---------- */
function kFilterCoeffs(fs) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const pre = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const rlb = { a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }; // b = [1, -2, 1]
  return { pre, rlb };
}

function channelWeights(n) {
  if (n === 6) return [1, 1, 1, 0, 1.41, 1.41]; // L R C LFE Ls Rs
  if (n === 5) return [1, 1, 1, 1.41, 1.41]; // L R C Ls Rs
  return new Array(n).fill(1);
}

/* Energia K-weighted ponderada por segmentos de 100 ms (blocos de 400 ms = 4 segmentos, 75% overlap). */
function segmentEnergies(channels, fs) {
  const segLen = Math.max(1, Math.round(fs * 0.1));
  const len = channels[0].length;
  const nSeg = Math.floor(len / segLen);
  const seg = new Float64Array(nSeg);
  const w = channelWeights(channels.length);
  const { pre, rlb } = kFilterCoeffs(fs);
  const end = nSeg * segLen;

  for (let c = 0; c < channels.length; c++) {
    if (!w[c]) continue;
    const x = channels[c];
    const wc = w[c];
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    let acc = 0, cnt = 0, s = 0;
    for (let i = 0; i < end; i++) {
      const xi = x[i];
      const y = pre.b0 * xi + pre.b1 * x1 + pre.b2 * x2 - pre.a1 * y1 - pre.a2 * y2;
      const z = y - 2 * y1 + y2 - rlb.a1 * z1 - rlb.a2 * z2;
      x2 = x1; x1 = xi;
      y2 = y1; y1 = y;
      z2 = z1; z1 = z;
      acc += z * z;
      if (++cnt === segLen) {
        seg[s++] += wc * acc;
        acc = 0;
        cnt = 0;
      }
    }
  }
  return { seg, segLen };
}

function slidingBlocks(seg, segLen, nSegPerBlock) {
  const nb = seg.length - nSegPerBlock + 1;
  if (nb <= 0) return new Float64Array(0);
  const out = new Float64Array(nb);
  const norm = 1 / (nSegPerBlock * segLen);
  let s = 0;
  for (let i = 0; i < nSegPerBlock - 1; i++) s += seg[i];
  for (let b = 0; b < nb; b++) {
    s += seg[b + nSegPerBlock - 1];
    out[b] = s * norm;
    s -= seg[b];
  }
  return out;
}

function gatedLoudness(blocks, relativeLU) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] > ABS_GATE_ENERGY) { sum += blocks[i]; cnt++; }
  }
  if (!cnt) return -Infinity;
  const relThr = (sum / cnt) * Math.pow(10, relativeLU / 10);
  sum = 0; cnt = 0;
  for (let i = 0; i < blocks.length; i++) {
    const e = blocks[i];
    if (e > ABS_GATE_ENERGY && e > relThr) { sum += e; cnt++; }
  }
  return cnt ? energyToLufs(sum / cnt) : -Infinity;
}

function loudnessRange(stBlocks) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < stBlocks.length; i++) {
    if (stBlocks[i] > ABS_GATE_ENERGY) { sum += stBlocks[i]; cnt++; }
  }
  if (cnt < 2) return 0;
  const relThr = (sum / cnt) * Math.pow(10, -20 / 10);
  const vals = [];
  for (let i = 0; i < stBlocks.length; i++) {
    const e = stBlocks[i];
    if (e > ABS_GATE_ENERGY && e > relThr) vals.push(energyToLufs(e));
  }
  if (vals.length < 2) return 0;
  vals.sort((a, b) => a - b);
  const pct = (p) => vals[Math.round((vals.length - 1) * p)];
  return Math.max(0, pct(0.95) - pct(0.1));
}

function measureLoudness(channels, fs, withLra) {
  const { seg, segLen } = segmentEnergies(channels, fs);
  const integrated = gatedLoudness(slidingBlocks(seg, segLen, 4), -10);
  const lra = withLra ? loudnessRange(slidingBlocks(seg, segLen, 30)) : null;
  return { integrated, lra };
}

/* ---------- True Peak (oversampling 4x, interpolador polifásico windowed-sinc, 12 taps/fase) ---------- */
const OS = 4;
const HALF = 6;
const TAPS = HALF * 2;
const PHASES = (() => {
  const phases = [];
  for (let p = 1; p < OS; p++) {
    const f = p / OS;
    const c = new Float64Array(TAPS);
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const t = j - (HALF - 1) - f;
      const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
      const win = 0.5 * (1 + Math.cos((Math.PI * t) / HALF));
      c[j] = sinc * win;
      sum += c[j];
    }
    for (let j = 0; j < TAPS; j++) c[j] /= sum;
    phases.push(c);
  }
  return phases;
})();

/* Retorna o true peak; se `env` for passado, grava nele o pico (linkado entre canais) por amostra. */
function truePeak(channels, env) {
  const len = channels[0].length;
  const [c1, c2, c3] = PHASES;
  let tp = 0, sp = 0;
  for (const x of channels) {
    for (let n = 0; n < len; n++) {
      const a = x[n] < 0 ? -x[n] : x[n];
      if (a > sp) sp = a;
      let s1 = 0, s2 = 0, s3 = 0;
      const base = n - (HALF - 1);
      if (base >= 0 && base + TAPS <= len) {
        for (let j = 0; j < TAPS; j++) {
          const v = x[base + j];
          s1 += c1[j] * v; s2 += c2[j] * v; s3 += c3[j] * v;
        }
      } else {
        for (let j = 0; j < TAPS; j++) {
          const idx = base + j;
          if (idx < 0 || idx >= len) continue;
          const v = x[idx];
          s1 += c1[j] * v; s2 += c2[j] * v; s3 += c3[j] * v;
        }
      }
      let pk = a;
      if (s1 < 0) s1 = -s1; if (s1 > pk) pk = s1;
      if (s2 < 0) s2 = -s2; if (s2 > pk) pk = s2;
      if (s3 < 0) s3 = -s3; if (s3 > pk) pk = s3;
      if (pk > tp) tp = pk;
      if (env && pk > env[n]) env[n] = pk;
    }
  }
  if (env) {
    // o pico inter-amostra entre n-1 e n depende das duas amostras
    for (let n = len - 1; n > 0; n--) if (env[n - 1] > env[n]) env[n] = env[n - 1];
  }
  return { tp, sp };
}

/*
 * Limiter com lookahead (offline). Garante que o ganho já atingiu o valor necessário quando o pico chega:
 * mínimo deslizante (hold) → release exponencial → média móvel do mesmo tamanho do lookahead.
 */
function limit(channels, env, gain, ceil, L, relCoeff, out) {
  const len = channels[0].length;
  const nch = channels.length;
  const cap = L + 1;
  const dqIdx = new Int32Array(cap);
  const dqVal = new Float64Array(cap);
  let head = 0, size = 0;
  const ring = new Float64Array(L);
  let sum = 0, rel = 1, minG = 1;
  const total = len + L - 1;
  const invL = 1 / L;

  for (let k = 0; k < total; k++) {
    let req = 1;
    if (k < len) {
      const p = env[k] * gain;
      if (p > ceil) req = ceil / p;
    }
    while (size > 0 && dqVal[(head + size - 1) % cap] >= req) size--;
    const pos = (head + size) % cap;
    dqIdx[pos] = k; dqVal[pos] = req; size++;
    while (dqIdx[head] <= k - L) { head = (head + 1) % cap; size--; }
    const hold = dqVal[head];

    rel = hold < rel ? hold : hold + (rel - hold) * relCoeff;

    const r = k % L;
    sum += rel - ring[r];
    ring[r] = rel;

    if (k >= L - 1) {
      const t = k - L + 1;
      const g = Math.min(1, sum * invL);
      if (g < minG) minG = g;
      const gg = g * gain;
      for (let c = 0; c < nch; c++) out[c][t] = channels[c][t] * gg;
    }
  }
  return minG;
}

function waveformPeaks(channels, buckets) {
  const len = channels[0].length;
  const n = Math.min(buckets, len);
  const out = new Float32Array(n * 2);
  const step = len / n;
  for (let b = 0; b < n; b++) {
    const s = Math.floor(b * step);
    const e = Math.min(len, Math.floor((b + 1) * step));
    let mn = 0, mx = 0;
    for (const x of channels) {
      for (let i = s; i < e; i++) {
        const v = x[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    out[b * 2] = mn;
    out[b * 2 + 1] = mx;
  }
  return out;
}

/* ---------- Encoders ---------- */
function makeRng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function toInt16(channels) {
  const rnd = makeRng(0x1234567);
  return channels.map((x) => {
    const out = new Int16Array(x.length);
    for (let i = 0; i < x.length; i++) {
      // dither TPDF de ±1 LSB antes de truncar para 16 bits
      let v = Math.round(x[i] * 32767 + (rnd() - rnd()));
      if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
      out[i] = v;
    }
    return out;
  });
}

function writeWavHeader(view, nch, fs, bits, dataSize) {
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  const blockAlign = nch * (bits / 8);
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, nch, true);
  view.setUint32(24, fs, true);
  view.setUint32(28, fs * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);
}

function encodeWav16(int16, fs) {
  const nch = int16.length, len = int16[0].length;
  const dataSize = len * nch * 2;
  if (44 + dataSize > 0xffffffff) throw new Error('Arquivo grande demais para WAV (limite de 4 GB).');
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  writeWavHeader(view, nch, fs, 16, dataSize);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) { view.setInt16(o, int16[c][i], true); o += 2; }
  }
  return buf;
}

function encodeWav24(channels, fs) {
  const nch = channels.length, len = channels[0].length;
  const dataSize = len * nch * 3;
  if (44 + dataSize > 0xffffffff) throw new Error('Arquivo grande demais para WAV (limite de 4 GB).');
  const buf = new ArrayBuffer(44 + dataSize);
  writeWavHeader(new DataView(buf), nch, fs, 24, dataSize);
  const u8 = new Uint8Array(buf);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      let v = Math.round(channels[c][i] * 8388607);
      if (v > 8388607) v = 8388607; else if (v < -8388608) v = -8388608;
      u8[o] = v & 255; u8[o + 1] = (v >> 8) & 255; u8[o + 2] = (v >> 16) & 255;
      o += 3;
    }
  }
  return buf;
}

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
function encodeMp3(int16, fs) {
  if (!ensureLame()) throw new Error('Encoder MP3 indisponível.');
  if (!MP3_RATES.includes(fs)) throw new Error(`MP3 não suporta ${fs} Hz (máx. 48 kHz).`);
  if (int16.length > 2) throw new Error('MP3 suporta apenas mono ou estéreo.');
  const stereo = int16.length === 2;
  const kbps = fs >= 32000 ? 320 : 160;
  const enc = new lamejs.Mp3Encoder(int16.length, fs, kbps);
  const chunks = [];
  let total = 0;
  const push = (b) => { if (b.length) { const u = new Uint8Array(b.buffer, b.byteOffset, b.length); chunks.push(u); total += u.length; } };
  const len = int16[0].length;
  for (let i = 0; i < len; i += 1152) {
    const l = int16[0].subarray(i, i + 1152);
    push(stereo ? enc.encodeBuffer(l, int16[1].subarray(i, i + 1152)) : enc.encodeBuffer(l));
  }
  push(enc.flush());
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

/* ---------- Jobs ---------- */
function analyze(msg) {
  const { channels, sampleRate } = msg;
  if (!Array.isArray(channels) || !channels.length || channels.length > 8) throw new Error('Número de canais inválido.');
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new Error('Taxa de amostragem inválida.');
  const len = channels[0].length;
  if (!channels.every((c) => c instanceof Float32Array && c.length === len)) throw new Error('Dados de áudio inválidos.');

  post({ type: 'progress', id: msg.id, value: 0.2, label: 'Medindo loudness (BS.1770-4)…' });
  const { integrated, lra } = measureLoudness(channels, sampleRate, true);
  post({ type: 'progress', id: msg.id, value: 0.55, label: 'Calculando true peak (oversampling 4x)…' });
  const env = new Float32Array(len);
  const { tp, sp } = truePeak(channels, env);
  const peaks = waveformPeaks(channels, 1600);

  state = { channels, sampleRate, env, analysis: { integrated, lra, tp, sp } };
  post(
    { type: 'result', id: msg.id, integrated, lra, truePeakDb: linToDb(tp), samplePeakDb: linToDb(sp), peaks },
    [peaks.buffer]
  );
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const FORMATS = new Set(['wav24', 'wav16', 'mp3']);

function renderProfile(target, ceilingDb, preset, onStep) {
  const { channels, sampleRate: fs, env, analysis } = state;
  const ceilLin = dbToLin(ceilingDb);
  const L = Math.max(1, Math.round((fs * preset.lookaheadMs) / 1000));
  const relCoeff = Math.exp(-1 / ((fs * preset.releaseMs) / 1000));
  const initialGain = target - analysis.integrated;
  const maxGain = initialGain + 6; // limite de compensação extra quando o limiter trabalha muito
  let gainDb = initialGain;
  let limCeil = ceilLin * dbToLin(-0.05);
  const out = channels.map((c) => new Float32Array(c.length));
  let minG = 1, tp = 0, lufs = -Infinity;

  for (let iter = 0; iter < 6; iter++) {
    onStep(iter);
    minG = limit(channels, env, dbToLin(gainDb), limCeil, L, relCoeff, out);
    tp = truePeak(out).tp;
    lufs = measureLoudness(out, fs, false).integrated;
    if (tp > ceilLin) { limCeil *= (ceilLin / tp) * dbToLin(-0.02); continue; }
    const delta = target - lufs;
    if (Math.abs(delta) <= 0.05 || gainDb >= maxGain) break;
    gainDb = Math.min(gainDb + delta, maxGain);
  }

  if (tp > ceilLin) { // salvaguarda final: nunca entregar acima do teto
    const trim = ceilLin / tp;
    for (const x of out) for (let i = 0; i < x.length; i++) x[i] *= trim;
    tp = truePeak(out).tp;
    lufs = measureLoudness(out, fs, false).integrated;
  }
  return { out, gainDb, lufs, tpDb: linToDb(tp), maxGrDb: -linToDb(minG) };
}

function processJob(msg) {
  if (!state) throw new Error('Nenhum áudio carregado.');
  const profiles = Array.isArray(msg.profiles) ? msg.profiles.slice(0, 8) : [];
  const formats = (Array.isArray(msg.formats) ? msg.formats : []).filter((f) => FORMATS.has(f));
  if (!profiles.length || !formats.length) throw new Error('Selecione perfis e formatos.');
  const preset = {
    lookaheadMs: clamp(Number(msg.preset && msg.preset.lookaheadMs) || 3, 0.5, 10),
    releaseMs: clamp(Number(msg.preset && msg.preset.releaseMs) || 150, 10, 1000),
  };
  const fs = state.sampleRate;
  const total = profiles.length;

  profiles.forEach((p, idx) => {
    const target = clamp(Number(p.target), -40, -5);
    const ceiling = clamp(Number(p.ceiling), -6, 0);
    if (!Number.isFinite(target) || !Number.isFinite(ceiling)) throw new Error('Parâmetros inválidos.');
    const base = idx / total;
    const span = 1 / total;
    const progress = (f, label) => post({ type: 'progress', id: msg.id, value: base + span * f, label });

    const r = renderProfile(target, ceiling, preset, (iter) =>
      progress(0.1 + iter * 0.1, `${p.label}: ajustando loudness e limiter${iter ? ` (passo ${iter + 1})` : ''}…`)
    );

    const files = [];
    const transfer = [];
    let int16 = null;
    const need16 = () => (int16 || (int16 = toInt16(r.out)));

    if (formats.includes('wav24')) {
      progress(0.75, `${p.label}: gerando WAV 24-bit…`);
      const buf = encodeWav24(r.out, fs);
      files.push({ format: 'wav24', mime: 'audio/wav', buffer: buf });
      transfer.push(buf);
    }
    if (formats.includes('wav16')) {
      progress(0.82, `${p.label}: gerando WAV 16-bit…`);
      const buf = encodeWav16(need16(), fs);
      files.push({ format: 'wav16', mime: 'audio/wav', buffer: buf });
      transfer.push(buf);
    }
    const warnings = [];
    if (formats.includes('mp3')) {
      progress(0.9, `${p.label}: codificando MP3…`);
      try {
        const buf = encodeMp3(need16(), fs);
        files.push({ format: 'mp3', mime: 'audio/mpeg', buffer: buf });
        transfer.push(buf);
      } catch (e) {
        warnings.push(e.message);
      }
    }
    if (r.gainDb > 20) warnings.push(`Ganho alto (+${r.gainDb.toFixed(1)} dB): ruído de fundo também foi amplificado.`);
    if (Math.abs(r.lufs - target) > 0.5) warnings.push('Alvo agressivo para este teto: o limiter não conseguiu atingir o loudness sem distorção excessiva.');

    const peaks = waveformPeaks(r.out, 800);
    transfer.push(peaks.buffer);
    post({
      type: 'profile',
      id: msg.id,
      key: p.key,
      target,
      ceiling,
      lufs: r.lufs,
      tpDb: r.tpDb,
      gainDb: r.gainDb,
      maxGrDb: r.maxGrDb,
      files,
      warnings,
      peaks,
    }, transfer);
  });
  post({ type: 'result', id: msg.id });
}

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'analyze') analyze(msg);
    else if (msg.type === 'process') processJob(msg);
    else throw new Error('Mensagem desconhecida.');
  } catch (err) {
    post({ type: 'error', id: msg.id, message: (err && err.message) || 'Erro desconhecido.' });
  }
};
