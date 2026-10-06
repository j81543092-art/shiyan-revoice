/**
 * 语音与图片链路验证 —— 重点验证「无凭证时优雅降级」
 *
 * 这不是单元测试，是答辩前的手动验证脚本。跑它确认：
 *   1. 没有任何华为云凭证时，服务仍能启动、语音接口不崩、核心链路照常
 *   2. 有凭证（哪怕假的）时，探测逻辑正确选中对应 provider
 *   3. 图片解析的图标优先策略与切分逻辑符合预期
 */

import { createSpeechRecognizer } from '../server/model/speech-index.js';
import { createVisualResolver, matchSymbols } from '../server/domain/visual.js';
import { splitFragments, stripDataUri, normalizeResult } from '../server/model/providers/speech.js';
import { buildImagePrompt, extractB64 } from '../server/model/providers/image.js';
import { createIamTokenManager } from '../server/model/providers/iam.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`); }
}

console.log('\n【1】语音切分：把断续的话切成线索碎片');
check('按标点切分', splitFragments('水，那个，喝'), ['水', '那个', '喝']);
// maxLen=12：短句不切（本身就是一句完整的话，切了反而丢语义）
check('短句不切分（8 字 < 12）', splitFragments('我想喝水然后吃饭'), ['我想喝水然后吃饭']);
// 超过 maxLen 才在停顿词处断开
check('长句在停顿词处切分', splitFragments('我想喝水然后吃饭然后我想睡觉了'), ['我想喝水', '吃饭', '我想睡觉了']);
check('空串返回空数组', splitFragments(''), []);
check('纯空格返回空数组', splitFragments('   '), []);

console.log('\n【2】base64 前缀剥离（带前缀会让 SIS 报错）');
check('剥离 mp3 前缀', stripDataUri('data:audio/mp3;base64,AAAA'), 'AAAA');
check('剥离 wav 前缀', stripDataUri('data:audio/wav;base64,BBBB'), 'BBBB');
check('裸 base64 原样返回', stripDataUri('CCCC'), 'CCCC');
check('空输入返回空串', stripDataUri(''), '');

console.log('\n【3】SIS 响应归一化');
check('正常响应', normalizeResult({ result: { words: '我想喝水' } })?.text, '我想喝水');
check('错误码返回 null', normalizeResult({ error_code: 'SIS.0005', error_msg: 'no' }), null);
check('空结果返回 null', normalizeResult({ result: { words: '  ' } }), null);
check('null 输入返回 null', normalizeResult(null), null);

console.log('\n【4】IAM 无凭证时不该崩，也不该假装可用');
delete process.env.HW_IAM_USERNAME;
delete process.env.HW_IAM_PASSWORD;
delete process.env.HW_IAM_DOMAIN;
const iam = createIamTokenManager();
check('无凭证 available=false', iam.available(), false);
check('无凭证 getToken 返回 null', await iam.getToken(), null);

console.log('\n【5】语音识别器：无凭证时优雅返回，不抛异常');
const stt = createSpeechRecognizer();
check('无凭证 available=false', stt.available(), false);
const r = await stt.transcribe({ audioBase64: 'AAAA', audioFormat: 'wav' });
check('无凭证 transcribe.ok=false', r.ok, false);
check('无凭证仍返回 fragments 空数组', r.fragments, []);
console.log(`      reason: ${r.reason}`);

console.log('\n【6】图标优先策略 —— 词表命中就不该调文生图');
check('「我想喝水」命中 水', matchSymbols('我想喝水', 'daily_life').length > 0, true);
check('「我饿了想吃饭」命中 吃饭', matchSymbols('我饿了想吃饭', 'food').some((s) => s.text.includes('饭')), true);
check('「量子力学」无命中（应走文生图）', matchSymbols('量子力学', 'daily_life').length, 0);

const vis = createVisualResolver();
const hit = await vis.resolve({ text: '我饿了想吃饭', scenarioKey: 'food' });
check('词表命中 → source=icon', hit.source, 'icon');
check('图标命中 → 不产生 prompt', hit.prompt, '');

const miss = await vis.resolve({ text: '想看看窗外的天气', scenarioKey: 'daily_life' });
// 无文生图凭证时应回退到 none，且不抛异常
check('无凭证时未命中 → source=none', miss.source, 'none');
check('无凭证时 symbols 为空', miss.symbols, []);

console.log('\n【7】文生图提示词与响应解析');
const p = buildImagePrompt({ text: '我想喝水', scenario: 'food', icons: ['水'] });
check('提示词含意图', p.includes('我想喝水'), true);
check('提示词含场景', p.includes('饮食用餐'), true);
check('提示词明令不出文字', p.includes('不要出现任何文字'), true);
check('提示词长度 < 760（上游限制 800）', p.length < 760, true);

check('解析 b64_json', extractB64({ data: [{ b64_json: 'ZZZ' }] }), 'ZZZ');
check('解析 data URI 前缀', extractB64({ data: [{ b64_json: 'data:image/png;base64,YYY' }] }), 'YYY');
check('无数据返回 null', extractB64({}), null);

console.log('\n【8】visual 统计信息（供 /api/health 展示）');
const stats = vis.stats();
console.log(`      图标索引词条数: ${stats.iconIndexSize}`);
console.log(`      文生图可用: ${stats.imageAvailable}`);
console.log(`      文生图 provider: ${stats.imageProvider}`);

console.log(`\n${'═'.repeat(60)}`);
console.log(`  通过 ${pass} ／ 失败 ${fail}`);
console.log(`  ${fail === 0 ? '✓ 语音与图片链路：降级行为符合预期' : '✗ 存在失败项，需排查'}`);
console.log(`${'═'.repeat(60)}\n`);

process.exit(fail === 0 ? 0 : 1);
