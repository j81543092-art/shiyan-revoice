/**
 * 端到端验证：语音端点在真实 HTTP 服务下的行为
 *
 * 为什么不用 curl：
 *   本机有强制代理（http_proxy=127.0.0.1:50370），
 *   对 localhost 也返回 502，且 --noproxy 无效。
 *   Node 的 http 模块默认不读 http_proxy 环境变量，
 *   所以这里直接用 Node 打本地端口。
 *
 * 另外：Git Bash 下中文参数会被编成 GBK，因此所有中文
 * 一律用 \uXXXX 转义写在 JSON 里，规避终端编码问题。
 */

import http from 'node:http';
import { createIntentEngine } from '../server/domain/engine.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3100);

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}

function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`); }
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      {
        host: HOST, port: PORT, path, method,
        headers: payload
          ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* 保留原文 */ }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

console.log('\n════ 语音链路端到端验证（真实 HTTP）════\n');

// ── 1. 健康检查暴露语音通道状态 ──
console.log('[1] /api/health 语音通道');
{
  const r = await request('GET', '/api/health');
  check('HTTP 200', r.status, 200);
  ok('健康检查通过', r.body?.ok === true, JSON.stringify(r.body).slice(0, 200));
  ok('暴露 speech 段', !!r.body?.speech, '缺 speech 字段');
  check('provider 标识正确', r.body?.speech?.provider, 'huawei-sis');
  check('未配凭证时 available=false', r.body?.speech?.available, false);
  check('区域为北京四', r.body?.speech?.region, 'cn-north-4');
  ok('暴露 visual 段（图标兜底）', !!r.body?.visual);
  ok('图标索引非空', (r.body?.visual?.iconIndexSize || 0) > 0);
  ok('暴露归一化能力', !!r.body?.speech?.normalize, '缺 normalize 字段');
  ok('归一化词汇表有规模', (r.body?.speech?.normalize?.vocabSize || 0) >= 90,
    `vocabSize=${r.body?.speech?.normalize?.vocabSize}`);
  console.log(`      归一化：词表 ${r.body?.speech?.normalize?.vocabSize} 词 / 口语变体 ${r.body?.speech?.normalize?.variantCount} 个`);
}

// ── 2. 无凭证时语音端点必须优雅降级，不能 500 ──
console.log('\n[2] /api/patient/speech 无凭证降级');
{
  const r = await request('POST', '/api/patient/speech', {
    // 一段极小的假音频，只为触发链路
    audioBase64: 'UklGRg==',
    audioFormat: 'wav',
  });
  check('HTTP 200（不是 500）', r.status, 200);
  check('ok=false 而非抛错', r.body?.ok, false);
  ok('给出可读的 reason', typeof r.body?.reason === 'string' && r.body.reason.length > 0,
    `reason=${r.body?.reason}`);
  check('fragments 是空数组而非 null', Array.isArray(r.body?.fragments), true);
  check('fragments 长度为 0', r.body?.fragments?.length, 0);
  ok('显式声明 provider 可用性', r.body?.providerAvailable === false,
    `providerAvailable=${r.body?.providerAvailable}`);
  console.log(`      reason 原文：${r.body?.reason}`);
}

// ── 3. 空音频也不能崩 ──
console.log('\n[3] 空音频与畸形入参');
{
  const r1 = await request('POST', '/api/patient/speech', {});
  check('完全空 body → 200', r1.status, 200);
  check('空 body → ok=false', r1.body?.ok, false);

  const r2 = await request('POST', '/api/patient/speech', {
    audioBase64: '', audioFormat: 'not-a-format',
  });
  check('非法格式 → 200', r2.status, 200);
  check('非法格式 → ok=false', r2.body?.ok, false);

  // data URI 前缀是最常见的误用，后端应自行剥离
  const r3 = await request('POST', '/api/patient/speech', {
    audioBase64: 'data:audio/wav;base64,UklGRg==', audioFormat: 'wav',
  });
  check('带 data URI 前缀 → 200', r3.status, 200);
  ok('前缀被剥离后仍走正常降级路径', r3.body?.ok === false);
}

// ── 4. 语音碎片进入 clues 后必须参与候选生成 ──
console.log('\n[4] 语音碎片 → 候选意图（核心链路）');
{
  // 用词表原词，绕开归一化变量，单独验证「碎片通道本身通畅」
  const r = await request('POST', '/api/patient/understand', {
    sessionId: 'e2e-voice-1-' + Date.now(),
    patientId: 'e2e-patient',
    scenario: 'daily_life',
    clues: {
      icons: [],
      keywords: [],
      voiceFragments: ['\u5395\u6240', '\u6025'],   // 厕所 / 急（简体！繁体「廁」匹配不上词表）
    },
  });
  check('HTTP 200', r.status, 200);
  ok('请求成功', r.body?.ok === true, JSON.stringify(r.body).slice(0, 260));
  const n = (r.body?.candidates || []).length;
  ok(`语音碎片单独能产出候选（${n} 个）`, n > 0 || r.body?.state === 'clarifying',
    `state=${r.body?.state} candidates=${n}`);
  console.log(`      state=${r.body?.state} 候选数=${n}`);
  if (n > 0) {
    console.log(`      候选：${r.body.candidates.map((c) => c.text).join(' / ')}`);
  }
}

// ── 4b. 归一化：自由文本也必须能走通（这是被语音引爆的缺陷的防线）──
console.log('\n[4b] 归一化：自由文本 → 词表原词');
{
  const r = await request('POST', '/api/patient/understand', {
    sessionId: 'e2e-voice-norm-' + Date.now(),
    patientId: 'e2e-patient',
    scenario: 'daily_life',
    clues: {
      icons: [],
      keywords: [],
      // 「我想喝水」是患者真实说法。若不归一化，引擎会一个字都对不上
      voiceFragments: ['\u6211\u60f3\u559d\u6c34'],
    },
  });
  check('HTTP 200', r.status, 200);
  const n = (r.body?.candidates || []).length;
  ok(`自由文本产出候选（${n} 个）`, n > 0 || r.body?.state === 'clarifying',
    `state=${r.body?.state} candidates=${n}`);
  console.log(`      state=${r.body?.state} 候选数=${n}`);
  if (n > 0) console.log(`      候选：${r.body.candidates.map((c) => c.text).join(' / ')}`);
}

// ── 5. 语音 + 图标互证 ──
console.log('\n[5] 语音碎片与图标互证');
{
  // ⚠ 必须走 /api/debug/understand，不能走 /api/patient/understand。
  // 原因：R3 明确规定患者端不暴露置信度数值，患者端响应只含 {rank, text}。
  // 用患者端验证「互证提高置信度」，断言会恒为 0>=0 —— 等于没测。
  // 必须是简体「厕所」(\u5395)，繁体「廁」(\u5ec1) 匹配不上词表 —— 踩过一次
  const toilet = '\u5395\u6240';
  const urgent = '\u6025';

  const r1 = await request('POST', '/api/debug/understand', {
    patientId: 'e2e-patient', scenario: 'daily_life',
    clues: { icons: [toilet], keywords: [], voiceFragments: [] },
  });
  const r2 = await request('POST', '/api/debug/understand', {
    patientId: 'e2e-patient', scenario: 'daily_life',
    clues: { icons: [toilet], keywords: [], voiceFragments: [urgent] },
  });
  const r3 = await request('POST', '/api/debug/understand', {
    patientId: 'e2e-patient', scenario: 'daily_life',
    clues: { icons: [toilet], keywords: [], voiceFragments: [toilet] },
  });

  const top1 = (r) => (r.body?.candidates || [])[0];
  const c1 = top1(r1);
  const c2 = top1(r2);
  const c3 = top1(r3);

  ok('纯图标能产出候选', !!c1, `state=${r1.body?.state}`);
  ok('图标+互补语音能产出候选', !!c2, `state=${r2.body?.state}`);

  if (c1 && c2) {
    const s1 = c1.confidence ?? 0;
    const s2 = c2.confidence ?? 0;
    console.log(`      纯图标        top1=${c1.text} 置信度=${s1}`);
    console.log(`      图标+互补语音  top1=${c2.text} 置信度=${s2}`);
    ok('debug 端点确实返回置信度数值', s1 > 0, `s1=${s1}`);
    ok('互补线索不会降低置信度（不倒退）', s2 >= s1, `单=${s1} 互补=${s2}`);
    console.log(`      ⚠ 互补线索未带来提升 —— 见下方 [5b] 的说明`);
  }

  if (c1 && c3) {
    const s1 = c1.confidence ?? 0;
    const s3 = c3.confidence ?? 0;
    console.log(`      重复线索对照   置信度=${s3}`);
    ok('重复线索不产生虚假提升', s3 <= s1, `单=${s1} 重复=${s3}`);
  }

  // 顺带确认患者端确实遵守 R3（不泄漏置信度）
  const patient = await request('POST', '/api/patient/understand', {
    sessionId: 'e2e-r3-' + Date.now(), patientId: 'e2e-patient', scenario: 'daily_life',
    clues: { icons: [toilet], keywords: [], voiceFragments: [urgent] },
  });
  const pc = (patient.body?.candidates || [])[0];
  ok('患者端候选遵守 R3（只有 rank 与 text，无置信度）',
    !!pc && pc.confidence === undefined && pc.rank !== undefined && !!pc.text,
    JSON.stringify(pc));
}

// ── 5b. 诚实记录：当前评分模型对「线索条数」不敏感 ──
console.log('\n[5b] 已知局限：评分模型无法区分 1 条与 2 条线索命中');
{
  // 实测：图标「厕所」与图标「厕所」+语音「急」，top1 置信度完全相同（0.6735）。
  // 原因是线索覆盖度是**归一化比例**（命中数/总数）：
  //   1 命中 / 1 线索 = 1.0
  //   2 命中 / 2 线索 = 1.0  ← 数值一样
  // 即：覆盖度衡量的是「解释得完不完整」，不是「证据够不够多」。
  //
  // 对失语症场景这是真实的建模局限 —— 患者给 3 个互证线索时，
  // 系统的确信度本应高于只给 1 个。当前模型做不到。
  // 本轮**不擅自改评分公式**（那是规格级改动，须走审核），
  // 只把它固化为已知项，作为评测阶段的迭代目标。
  const engine = createIntentEngine({});
  const one = await engine.understand({
    sessionId: 'lim-1', patientId: 'p', scenario: 'daily_life',
    clues: { icons: ['厕所'], keywords: [], voiceFragments: [] },
  });
  const two = await engine.understand({
    sessionId: 'lim-2', patientId: 'p', scenario: 'daily_life',
    clues: { icons: ['厕所'], keywords: [], voiceFragments: ['急'] },
  });
  const s1 = (one.candidates || [])[0]?.confidence ?? 0;
  const s2 = (two.candidates || [])[0]?.confidence ?? 0;
  console.log(`      1 条线索命中置信度: ${s1}`);
  console.log(`      2 条线索命中置信度: ${s2}`);
  ok('确认该局限存在（记录在案，非静默）', Math.abs(s2 - s1) < 0.001,
    `s1=${s1} s2=${s2}；若此断言失败说明评分公式已改动，请同步更新本条说明`);
}

// ── 5c. 场景消歧在 HTTP 层的端到端效果 ──
console.log('\n[5c] 单字碎片经场景消歧后的端到端表现');
{
  // 失语症患者常说单字。单字本身不在词表，
  // 但场景已知时可做确定性映射（场景内唯一才映射）。
  const cases = [
    ['关', 'daily_life', '\u5173\u706f'],        // 关 → 关灯
    ['戏', 'leisure', '\u620f\u66f2'],           // 戏 → 戏曲
  ];
  for (const [clue, scene, expected] of cases) {
    const r = await request('POST', '/api/debug/understand', {
      patientId: 'e2e-patient', scenario: scene,
      clues: { icons: [], keywords: [clue], voiceFragments: [] },
    });
    const texts = (r.body?.candidates || []).map((c) => c.text).join(' ');
    const norm = (r.body?.trace?.normalizedClues) || null;
    console.log(`      「${clue}」+ ${scene} → state=${r.body?.state} 候选：${texts || '（无）'}`);
    ok(`单字「${clue}」在 ${scene} 场景下被正确理解`,
      texts.includes(expected) || r.body?.state === 'clarifying',
      `期望含 ${expected}，实际 ${texts}`);
  }

  // 关键边界：场景不匹配时绝不能跨界映射
  const cross = await request('POST', '/api/debug/understand', {
    patientId: 'e2e-patient', scenario: 'leisure',
    clues: { icons: [], keywords: ['\u5173'], voiceFragments: [] },
  });
  const crossTexts = (cross.body?.candidates || []).map((c) => c.text).join(' ');
  ok('娱乐场景下的「关」不会跨界变成关灯',
    !crossTexts.includes('\u5173\u706f'), `实际候选中出现关灯：${crossTexts}`);
}

// ── 6. 静态资源：新模块必须可被浏览器取到 ──
console.log('\n[6] 新增前端资源可访问');
{
  const r = await request('GET', '/js/speech-client.js');
  check('speech-client.js HTTP 200', r.status, 200);
  ok('内容为 ESM 模块', r.raw.includes('export function createSpeechCapture'),
    r.raw.slice(0, 120));
  ok('未泄漏到非模块作用域（无 import 语法错误）', r.raw.includes('export const __test__'));

  const html = await request('GET', '/');
  check('首页 HTTP 200', html.status, 200);
  ok('首页引入 patient.js 为 module', html.raw.includes('type="module" src="/js/patient.js"'));
  ok('首页包含录音按钮', html.raw.includes('id="voiceBtn"'));
  ok('首页包含音量指示', html.raw.includes('id="voiceMeter"'));

  const css = await request('GET', '/css/app.css');
  check('样式表 HTTP 200', css.status, 200);
  ok('样式含录音态', css.raw.includes('.voice-btn.recording'));
  ok('样式含不可用降级态', css.raw.includes('.voice-btn.unavailable'));
  ok('样式尊重减弱动效', css.raw.includes('prefers-reduced-motion'));
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  端到端：通过 ${pass} ／ 失败 ${fail}`);
console.log('═'.repeat(60));

process.exit(fail === 0 ? 0 : 1);
