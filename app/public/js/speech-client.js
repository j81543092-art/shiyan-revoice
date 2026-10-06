/**
 * 拾言 ReVoice · 患者端语音采集客户端
 * ══════════════════════════════════════════════════════════════
 *
 * 职责单一：把麦克风里的声音，变成 clues.voiceFragments 能用的碎片。
 *
 * 三个关键设计决定（都不是随手写的）：
 *
 * 1. 不用 MediaRecorder，用 AudioContext 直取 PCM。
 *    原因：浏览器 MediaRecorder 录不出 wav（Chrome 给 webm/opus，
 *    Safari 给 mp4/aac），而华为云 SIS 一句话识别对 wav 支持最稳。
 *    自己封 WAV 头反而更可控，还省掉一次服务端转码。
 *
 * 2. 采 16kHz / 16bit / 单声道。
 *    原因：SIS 的 chinese_16k_general 就是吃这个格式；
 *    降采样到 16k 还能把 base64 体积压到 1/3，避开 4MB 上限。
 *
 * 3. 任何一步失败都不抛异常，只返回 { ok:false, reason }。
 *    原因：语音是「增强通道」，不是唯一通道。麦克风坏了、
 *    用户拒绝了权限、后端没配凭证 —— 都不该让患者卡在表达台上。
 *    图标点选永远能兜住。
 */

/** 目标采样率：与 SIS chinese_16k_general 对齐 */
const TARGET_SAMPLE_RATE = 16000;

/** 录音时长上限（ms）。SIS 一句话识别限 1 分钟，我们留足余量 */
const MAX_RECORD_MS = 30000;

/** 最短有效录音（ms）。低于这个基本是误触，不值得送去识别 */
const MIN_RECORD_MS = 350;

/** WAV 文件头固定 44 字节 */
const WAV_HEADER_BYTES = 44;

/**
 * 把 Float32 PCM 降采样到目标采样率。
 * 用简单线性插值而非重采样滤波器 —— 语音识别对这点误差不敏感，
 * 但省下的 CPU 在低端护理平板上是实打实的。
 */
function downsample(float32, srcRate, dstRate) {
  if (srcRate === dstRate) return float32;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, float32.length - 1);
    const frac = pos - left;
    out[i] = float32[left] * (1 - frac) + float32[right] * frac;
  }
  return out;
}

/** Float32 [-1,1] → 16bit 小端 PCM */
function floatTo16BitPCM(float32) {
  const out = new DataView(new ArrayBuffer(float32.length * 2));
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    // 负半轴是 -32768，正半轴是 32767 —— 不对称是 PCM 的规定
    out.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/**
 * 封装标准 WAV（RIFF）字节流。
 * 结构：RIFF头(12) + fmt块(24) + data块头(8) + PCM数据
 */
function encodeWav(pcm16, sampleRate) {
  const dataBytes = pcm16.byteLength;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buf);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);   // 后续字节数
  writeStr(8, 'WAVE');

  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);              // fmt 块长度
  view.setUint16(20, 1, true);               // 1 = PCM
  view.setUint16(22, 1, true);               // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // 字节率 = 采样率 × 声道 × 位深/8
  view.setUint16(32, 2, true);               // 块对齐
  view.setUint16(34, 16, true);              // 位深

  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  new Uint8Array(buf, WAV_HEADER_BYTES).set(new Uint8Array(pcm16.buffer));

  return buf;
}

/** ArrayBuffer → base64（分块处理，避免长音频爆栈） */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 创建一个语音采集器。
 *
 * @param {object} opts
 * @param {string} opts.endpoint  识别接口路径，默认 /api/patient/speech
 * @param {function} opts.onLevel 音量回调 (0~1)，供 UI 做波形反馈
 */
export function createSpeechCapture(opts = {}) {
  const endpoint = opts.endpoint || '/api/patient/speech';
  const onLevel = typeof opts.onLevel === 'function' ? opts.onLevel : () => {};

  let stream = null;
  let ctx = null;
  let analyser = null;
  let source = null;
  let chunks = [];
  let sampleRate = TARGET_SAMPLE_RATE;
  let startedAt = 0;
  let polling = false;
  let recording = false;

  /** 探测浏览器是否具备录音能力。老设备/非 HTTPS 场景会返回 false */
  function supported() {
    return typeof navigator !== 'undefined'
      && !!navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function'
      && typeof (window.AudioContext || window.webkitAudioContext) === 'function';
  }

  /** 拿麦克风。只在第一次真正申请权限 */
  async function ensureStream() {
    if (stream) return stream;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return stream;
  }

  /** 开始录音。失败返回 { ok:false, reason } */
  async function start() {
    if (recording) return { ok: true };
    if (!supported()) {
      return { ok: false, reason: '这个浏览器不支持录音' };
    }
    try {
      const s = await ensureStream();
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      // 部分浏览器（尤其 Safari）建好后是 suspended，需要显式唤醒
      if (ctx.state === 'suspended') await ctx.resume();

      source = ctx.createMediaStreamSource(s);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      sampleRate = ctx.sampleRate;
      chunks = [];
      startedAt = Date.now();
      recording = true;

      const buf = new Float32Array(analyser.fftSize);
      const pull = () => {
        if (!recording) return;
        analyser.getFloatTimeDomainData(buf);
        chunks.push(new Float32Array(buf));
        // 顺带算个 RMS 给 UI 画波形
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        if (Date.now() - startedAt > MAX_RECORD_MS) {
          recording = false;   // 触顶自动停，交给调用方决定是否上传
          return;
        }
        requestAnimationFrame(pull);
      };
      requestAnimationFrame(pull);

      return { ok: true };
    } catch (err) {
      recording = false;
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return { ok: false, reason: '没拿到麦克风权限' };
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return { ok: false, reason: '没检测到麦克风' };
      }
      return { ok: false, reason: '录音启动失败' };
    }
  }

  /**
   * 停止录音并编码。
   * @returns {{ok:boolean, audioBase64?:string, audioFormat?:string, durationMs?:number, reason?:string}}
   */
  function stop() {
    if (!recording && chunks.length === 0) {
      return { ok: false, reason: '还没开始录' };
    }
    recording = false;
    const durationMs = Date.now() - startedAt;

    if (durationMs < MIN_RECORD_MS) {
      chunks = [];
      return { ok: false, reason: '说得太短了' };
    }

    // 把所有帧拼成一条连续波形
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    chunks = [];

    const down = downsample(merged, sampleRate, TARGET_SAMPLE_RATE);
    const pcm = floatTo16BitPCM(down);
    const wav = encodeWav(pcm, TARGET_SAMPLE_RATE);

    // 关闭音频上下文，别让麦克风指示灯一直亮着 —— 患者会因此不安
    teardown();

    return {
      ok: true,
      audioBase64: bufferToBase64(wav),
      audioFormat: 'wav',
      durationMs,
    };
  }

  /** 释放音频资源（不释放 stream，下次复用以免二次弹权限） */
  function teardown() {
    try { if (source) source.disconnect(); } catch { /* 忽略 */ }
    try { if (analyser) analyser.disconnect(); } catch { /* 忽略 */ }
    try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch { /* 忽略 */ }
    source = null; analyser = null; ctx = null;
  }

  /** 彻底释放，包括停止麦克风轨道 */
  function dispose() {
    recording = false;
    teardown();
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
      stream = null;
    }
  }

  /**
   * 上传音频并取回碎片。
   * 永远不抛异常 —— 失败就返回 { ok:false, reason }。
   */
  async function transcribe(payload) {
    const body = {
      audioBase64: payload?.audioBase64 || '',
      audioFormat: payload?.audioFormat || 'wav',
    };
    if (!body.audioBase64) return { ok: false, reason: '没有音频数据', fragments: [] };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return { ok: false, reason: `识别服务返回 ${res.status}`, fragments: [] };
      }
      const data = await res.json();
      return {
        ok: !!data.ok,
        text: data.text || '',
        // 归一化后的词表原词 —— 可直接作为 clues.voiceFragments
        fragments: Array.isArray(data.fragments) ? data.fragments : [],
        // 原始切分结果。归一化可能全部落空（说了词表外的内容），
        // 这时原文仍要展示给患者看 ——「听成什么」本身就是反馈
        rawFragments: Array.isArray(data.rawFragments) ? data.rawFragments : [],
        reason: data.reason || null,
      };
    } catch {
      return { ok: false, reason: '网络不通，稍后再试', fragments: [] };
    }
  }

  return {
    supported,
    start,
    stop,
    dispose,
    transcribe,
    get recording() { return recording; },
  };
}

export const __test__ = {
  downsample,
  floatTo16BitPCM,
  encodeWav,
  bufferToBase64,
  TARGET_SAMPLE_RATE,
  WAV_HEADER_BYTES,
  MIN_RECORD_MS,
  MAX_RECORD_MS,
};
