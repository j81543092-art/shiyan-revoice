/**
 * 真实模型失败归因 —— 把「失败」拆成三类，区分「引擎的错」与「评测集的错」
 *
 * 动机：真实模型 Top-3 只有 28.6%，低于规则引擎的 35.7%。
 * 但这个数字本身无法回答问题 —— 必须逐条看清到底错在哪一环：
 *
 *   A 类｜模型确实没理解     → 归 prompt，是真正要改的地方
 *   B 类｜模型理解对了、候选也对了，但被 R4 判定成澄清 → 引擎阈值与模型输出风格不匹配
 *   C 类｜模型答案不在 Top-3（排序问题）→ 归排序层
 *
 * 不做这一步归因就动手改 prompt，是盲人摸象。
 */

import { loadEnv } from '../server/data/env.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

import { EVAL_SET_V1 } from '../eval/eval-set-v1.js';
import { createIntentEngine } from '../server/domain/engine.js';
import { similarity } from '../server/domain/scoring.js';

const THRESHOLD = 0.42;
const isHit = (text, item) => [item.answer, ...(item.equivalents || [])]
  .filter(Boolean)
  .some((t) => similarity(text, t) >= THRESHOLD);

const engine = createIntentEngine({ model: { provider: 'huawei' } });

const report = [];

for (const item of EVAL_SET_V1) {
  if (item.expectEmergency) continue;

  const r = await engine.understand({
    clues: item.clues,
    scenario: item.scenarioKey,
    profile: item.profile || null,
    round: 0,
  });

  const cands = r.candidates || [];
  const hitIdx = cands.findIndex((c) => isHit(c.text, item));

  let cls = '';
  if (item.expectClarify) {
    const isClarifying = r.state === 'clarifying' || r.state === 'fallback_list';
    cls = isClarifying ? 'C-OK' : 'C-ERR(该澄清却出候选)';
  } else if (r.state === 'clarifying' || r.state === 'fallback_list') {
    // 澄清了，但看它「想澄清的那个答案」是否正确 —— 判断模型是否理解对了
    const opts = r.clarification?.options || [];
    const clarifyHit = opts.some((o) => isHit(o, item));
    cls = clarifyHit ? 'B-理解对但被澄清' : 'A-模型没理解对';
  } else if (hitIdx >= 0 && hitIdx < 3) {
    cls = 'OK';
  } else if (hitIdx >= 0) {
    cls = 'C-命中但掉出Top3';
  } else {
    cls = 'A-模型没理解对';
  }

  report.push({
    id: item.id,
    cls,
    state: r.state,
    answer: item.answer,
    got: cands.slice(0, 3).map((c) => `${c.text}(${c.confidence})`).join(' | '),
    clarifyQ: r.clarification?.question || '',
    clarifyType: r.clarification?.type || '',
    expectedType: item.expectClarifyType || '',
    gap: cands.length >= 2 ? (cands[0].confidence - cands[1].confidence).toFixed(4) : '-',
  });
  process.stderr.write('.');
}

console.log('\n');
for (const x of report) {
  console.log(`${x.id}  [${x.cls}]`);
  console.log(`    标准答案  ${x.answer}`);
  console.log(`    实际候选  ${x.got}`);
  if (x.clarifyQ) console.log(`    澄清      (${x.clarifyType}/${x.expectedType || '-'}) ${x.clarifyQ}`);
  console.log(`    前二差值  ${x.gap}`);
  console.log('');
}

const tally = {};
for (const x of report) tally[x.cls] = (tally[x.cls] || 0) + 1;
console.log('═'.repeat(70));
console.log('归因汇总');
console.log('═'.repeat(70));
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}
