/**
 * 语音采集客户端 · 纯逻辑验证
 * ══════════════════════════════════════════════════════════════
 *
 * 前端代码通常没法在 Node 里跑，但这个模块的核心
 * （WAV 封装 / 降采样 / PCM 转换 / base64）都是纯函数，
 * 而它们恰恰是最容易悄悄写错的地方 —— 字节序、头长度、
 * 负半轴截断，任何一个错了都会得到「服务端报格式错误」这种
 * 极难排查的症状。这里把它们钉死。
 *
 * 同时验一把：这些函数产出的真的是 SIS 能吃的 WAV。
 */

import { __test__ } from '../public/js/speech-client.js';

const {
  downsample,
  floatTo16BitPCM,
  encodeWav,
  bufferToBase64,
  TARGET_SAMPLE_RATE,
  WAV_HEADER_BYTES,
} = __test__;

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}

function ok(label, cond) { check(label, !!cond, true); }

console.log('\n[1] 降采样');
{
  const src = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]);
  const half = downsample(src, 16000, 8000);
  check('16k→8k 长度减半', half.length, 4);
  ok('降采样后值仍在 [-1,1]', [...half].every((v) => v >= -1 && v <= 1));

  // 同采样率应当原样返回（不复制、不误差）
  const same = downsample(src, 16000, 16000);
  ok('同采样率原样返回', same === src);

  // 48k→16k 是常见路径（很多手机默认 48k）
  const big = new Float32Array(48000);
  for (let i = 0; i < 48000; i++) big[i] = Math.sin(i / 30);
  const ds = downsample(big, 48000, 16000);
  check('48k→16k 长度 1/3', ds.length, 16000);
}

console.log('\n[2] Float32 → 16bit PCM');
{
  const pcm = floatTo16BitPCM(new Float32Array([0, 1, -1]));
  check('字节数 = 样本数×2', pcm.byteLength, 6);
  check('0 → 0', pcm.getInt16(0, true), 0);
  check('1 → 32767', pcm.getInt16(2, true), 32767);
  // PCM 负半轴是 -32768 而非 -32767，这是规范
  check('-1 → -32768', pcm.getInt16(4, true), -32768);

  // 超范围输入必须被夹住，不能回绕成反相信号
  const clipped = floatTo16BitPCM(new Float32Array([2.5, -3.7]));
  check('超范围正向被夹到 32767', clipped.getInt16(0, true), 32767);
  check('超范围负向被夹到 -32768', clipped.getInt16(2, true), -32768);
}

console.log('\n[3] WAV 封装（RIFF 结构）');
{
  const samples = new Float32Array(1600);   // 0.1s @16k
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 10) * 0.5;
  const pcm = floatTo16BitPCM(samples);
  const wav = encodeWav(pcm, TARGET_SAMPLE_RATE);
  const view = new DataView(wav);
  const bytes = new Uint8Array(wav);

  const str = (off, len) =>
    String.fromCharCode(...bytes.subarray(off, off + len));

  check('总长度 = 44 + PCM', wav.byteLength, WAV_HEADER_BYTES + pcm.byteLength);
  check('RIFF 标识', str(0, 4), 'RIFF');
  check('WAVE 标识', str(8, 4), 'WAVE');
  check('fmt 块标识', str(12, 4), 'fmt ');
  check('data 块标识', str(36, 4), 'data');

  check('RIFF 后续字节数正确', view.getUint32(4, true), 36 + pcm.byteLength);
  check('fmt 块长度 16', view.getUint32(16, true), 16);
  check('格式 = 1 (PCM)', view.getUint16(20, true), 1);
  check('声道 = 1 (单声道)', view.getUint16(22, true), 1);
  check('采样率 = 16000', view.getUint32(24, true), 16000);
  // 字节率 = 16000 × 1声道 × 16bit/8 = 32000
  check('字节率 = 32000', view.getUint32(28, true), 32000);
  check('块对齐 = 2', view.getUint16(32, true), 2);
  check('位深 = 16', view.getUint16(34, true), 16);
  check('data 长度 = PCM 字节数', view.getUint32(40, true), pcm.byteLength);

  // PCM 数据必须真的贴在 44 字节之后，不能覆盖头部
  let mismatch = 0;
  const pcmBytes = new Uint8Array(pcm.buffer);
  for (let i = 0; i < pcmBytes.length; i++) {
    if (bytes[WAV_HEADER_BYTES + i] !== pcmBytes[i]) mismatch++;
  }
  check('PCM 数据完整贴合在头部之后', mismatch, 0);
}

console.log('\n[4] base64 编码');
{
  const buf = new ArrayBuffer(4);
  new Uint8Array(buf).set([0x52, 0x49, 0x46, 0x46]);   // "RIFF"
  // 0x52 0x49 0x46 0x46 → UklGRg==
  check('已知字节序列编码正确', bufferToBase64(buf), 'UklGRg==');

  // 大 buffer 会走分块路径，必须与整体编码一致
  const big = new Uint8Array(200000);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  const b64 = bufferToBase64(big.buffer);
  ok('大 buffer 编码不抛栈溢出', typeof b64 === 'string' && b64.length > 0);
  // 解码回来核对前后各一段，确保没有分块错位
  const decoded = Buffer.from(b64, 'base64');
  check('大 buffer 往返长度一致', decoded.length, big.length);
  let diff = 0;
  for (let i = 0; i < big.length; i++) if (decoded[i] !== big[i]) diff++;
  check('大 buffer 往返内容零误差', diff, 0);
}

console.log('\n[5] 端到端：模拟一段 16k 音频走完全链路');
{
  // 模拟 0.5 秒、48kHz 采样的输入（真实手机常见情况）
  const n = 24000;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.6;

  const down = downsample(src, 48000, TARGET_SAMPLE_RATE);
  check('降采样到 0.5s @16k', down.length, 8000);

  const pcm = floatTo16BitPCM(down);
  const wav = encodeWav(pcm, TARGET_SAMPLE_RATE);
  const b64 = bufferToBase64(wav);

  // 0.5s × 16000 × 2字节 + 44 = 16044
  check('WAV 字节数符合预期', wav.byteLength, 16044);

  // 关键：base64 体积必须远低于 SIS 的 4MB 上限
  const kb = Math.round(b64.length / 1024);
  ok(`base64 体积 ${kb}KB 远低于 4MB 上限`, b64.length < 4 * 1024 * 1024);

  const head = Buffer.from(b64.slice(0, 16), 'base64');
  check('开头确实是 RIFF', head.subarray(0, 4).toString(), 'RIFF');
}

console.log('\n[6] 边界与健壮性');
{
  check('空输入不崩', downsample(new Float32Array(0), 48000, 16000).length, 0);

  const emptyPcm = floatTo16BitPCM(new Float32Array(0));
  const emptyWav = encodeWav(emptyPcm, 16000);
  check('空音频仍是合法 WAV 头', emptyWav.byteLength, WAV_HEADER_BYTES);
  const view = new DataView(emptyWav);
  check('空音频 data 长度为 0', view.getUint32(40, true), 0);

  const one = floatTo16BitPCM(new Float32Array([0.5]));
  check('单样本不崩', one.byteLength, 2);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`语音采集纯逻辑验证：${pass} 通过 / ${fail} 失败`);
console.log('─'.repeat(56));

process.exit(fail === 0 ? 0 : 1);
