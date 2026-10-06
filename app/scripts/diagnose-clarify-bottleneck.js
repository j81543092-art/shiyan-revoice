/**
 * 诊断最后的瓶颈：为什么模型答对了却被要求澄清
 *
 * 现象：v1.3 之后 E01/E03/E07/E08/E11/E13 全部是
 *   「你是想说『正确答案』吗？」—— 模型答对了，却走了 yes_no 澄清。
 *
 * 怀疑：R4① 的 top1 < 0.6 阈值。需确认这些用例的 top1 综合置信度到底多少，
 * 以及是它本身低于 0.6，还是被「单一线索」规则（CLARIFY_RULES.singleClueGap）拦下。
 */

import { loadEnv } from '../server/data/env.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

import { EVAL_SET_V1 } from '../eval/eval-set-v1.js';
import { createIntentEngine } from '../server/domain/engine.js';
import { CLARIFY_RULES } from '../server/domain/scoring.js';

console.log('澄清规则：', JSON.stringify(CLARIFY_RULES));
console.log('');

const engine = createIntentEngine({ model: { provider: 'huawei' } });

// 只关心「期望出候选、实际却澄清」的用例
const TARGETS = ['E01', 'E03', 'E04', 'E07', 'E08', 'E11', 'E13', 'E14'];

for (const item of EVAL_SET_V1) {
  if (!TARGETS.includes(item.id)) continue;

  const r = await engine.understand({
    clues: item.clues,
    scenario: item.scenarioKey,
    profile: item.profile || null,
    round: 0,
  });

  const c = (r.candidates || [])[0];
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${item.id}  线索=${JSON.stringify(item.clues)}`);
  console.log(`  标准答案    ${item.answer}`);
  console.log(`  state       ${r.state}`);
  console.log(`  裁决理由    ${r.decisionReason || '-'}`);
  if (c) {
    console.log(`  top1        「${c.text}」`);
    console.log(`              confidence = ${c.confidence}`);
    console.log(`              breakdown  = ${JSON.stringify(c.breakdown)}`);
  }
  if (r.clarification) {
    console.log(`  澄清类型    ${r.clarification.type}`);
    console.log(`  澄清问题    ${r.clarification.question}`);
  }
  console.log(`  线索类型数  ${r.trace?.clueTypeCount}`);
}
