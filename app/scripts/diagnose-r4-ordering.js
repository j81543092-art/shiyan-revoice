/**
 * R4 判定顺序修复的**副作用审查**。
 *
 * 背景：v1.4 把「候选数 < 2」的无条件短路改成了先看 top1 置信度。
 * 这个改动修好了 4 条（E03/E07/E11/E13），但真实模型下 E06
 * 从「误澄清」变成了「漏澄清」—— 说明可能矫枉过正。
 *
 * 本脚本的目的：**不满足于「分数没掉」**，而是逐条打开四条「应澄清」
 * 用例的内部状态，看清 R4 的四条分支各自的实际走向，
 * 判断问题出在「判定顺序」还是「置信度本身算得偏高」。
 *
 * 用法：
 *   node scripts/diagnose-r4-ordering.js            # 规则引擎
 *   MODEL_PROVIDER=huawei node scripts/diagnose-r4-ordering.js
 */
import { createIntentEngine } from '../server/domain/engine.js';
import { EVAL_SET_V1 } from '../eval/eval-set-v1.js';
import { loadEnv } from '../server/data/env.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

const PROVIDER = process.env.MODEL_PROVIDER || 'rule';
const engine = createIntentEngine({ model: { provider: PROVIDER } });

const CLEARIFY_IDS = ['E06', 'E12', 'E19', 'E20'];

const line = '─'.repeat(78);
console.log(`\n${line}`);
console.log(`  R4 判定顺序副作用审查 ｜ provider = ${engine.provider.id}`);
console.log(line);

const cases = EVAL_SET_V1.filter((c) => CLEARIFY_IDS.includes(c.id));

for (const c of cases) {
  const r = await engine.understand({
    scenarioKey: c.scenarioKey,
    clues: c.clues,
    patientId: 'diag-r4',
  });

  const cands = r.candidates || [];
  const top1 = cands[0];
  const top2 = cands[1];

  console.log(`\n【${c.id}】${c.scenarioName} ｜ ${c.focus}`);
  console.log(`  线索：icons=${JSON.stringify(c.clues.icons)} kw=${JSON.stringify(c.clues.keywords)} voice=${JSON.stringify(c.clues.voiceFragments)}`);
  console.log(`  期望：应澄清`);
  console.log(`  实际：state=${r.state}` + (r.clarification ? ` ｜ type=${r.clarification.type}` : ''));
  console.log(`  候选数 = ${cands.length}` + (cands.length ? ` ｜ top1 置信 = ${top1.confidence.toFixed(4)}` : ''));
  if (top1 && top2) {
    console.log(`  top2 置信 = ${top2.confidence.toFixed(4)} ｜ 差值 = ${(top1.confidence - top2.confidence).toFixed(4)}`);
  }

  // 判定 R4 四条分支各自是否被触发
  const conf = top1 ? top1.confidence : 0;
  const gap = top1 && top2 ? top1.confidence - top2.confidence : null;
  console.log(`  ── R4 分支体检 ──`);
  console.log(`     ① lowConfidence (top1 < 0.6)      → ${conf < 0.6 ? '触发' : '未触发'}（top1=${conf.toFixed(4)}）`);
  if (gap !== null) {
    console.log(`     ② closeGap      (差值 < 0.1)      → ${gap < 0.1 ? '触发' : '未触发'}（差=${gap.toFixed(4)}）`);
  }
  console.log(`     ③ 候选数 < 2 的分支               → ${cands.length < 2 ? '进入' : '未进入'}（候选数=${cands.length}）`);
  console.log(`     ⚠️  关键：本次修复后，候选数<2 时改为「置信 ≥0.6 直接输出」`);

  // 结论倾向
  let verdict;
  if (r.state === 'clarifying') {
    verdict = '✓ 按期望澄清了';
  } else if (cands.length < 2 && conf >= 0.6) {
    verdict = '✗ 漏澄清 —— 且是**被本次 R4 修复放行的**（候选数<2 且置信≥0.6）';
  } else if (cands.length < 2 && conf < 0.6) {
    verdict = '✗ 漏澄清 —— 候选数<2 但置信<0.6，不该被放行，属于另一个 bug';
  } else if (gap !== null && gap >= 0.1 && conf >= 0.6) {
    verdict = '✗ 漏澄清 —— 但并非 R4 放行：候选数≥2、置信≥0.6、差值≥0.1 → R4 判定为「本来就够确信」';
  } else {
    verdict = '✗ 漏澄清 —— 需人工判断';
  }
  console.log(`  ⇒ ${verdict}`);
}

console.log(`\n${line}\n`);
