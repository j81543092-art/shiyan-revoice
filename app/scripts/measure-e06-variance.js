/**
 * E06 候选数与置信度的分布统计 —— 区分「竞态」与「模型采样波动」。
 *
 * 背景：E06（toilet：厕所 + 换）在不同调用间得到
 *   候选数 = 1 或 3，top1 置信 = 0.5933 / 0.6623 / 0.7023 …
 * 且 1 个候选时跨过 0.6 → 由「正确澄清」变成「漏澄清」。
 *
 * 竞态已由 scripts/repro-normalize-race.js 证实并修复。
 * 本脚本回答剩下那个问题：**残余波动是否纯粹来自模型采样？**
 *
 * 做法：完全相同的输入重复 N 次，每次都新建引擎，统计
 *   · 候选数分布
 *   · top1 置信分布
 *   · state 分布（产品级后果）
 *
 * 用法：
 *   MODEL_PROVIDER=huawei node scripts/measure-e06-variance.js [次数]
 */
import { createIntentEngine } from '../server/domain/engine.js';
import { loadEnv } from '../server/data/env.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

const PROVIDER = process.env.MODEL_PROVIDER || 'huawei';
const N = Number(process.argv[2] || 8);

const PRE = [
  { id: 'E06', scenarioKey: 'toilet', clues: { icons: ['厕所', '换'], keywords: [], voiceFragments: [] } },
];

const line = '─'.repeat(80);
console.log(`\n${line}`);
console.log(`  候选数 / 置信度分布统计 ｜ provider = ${PROVIDER} ｜ 重复 ${N} 次`);
console.log(line);

for (const p of PRE) {
  const countDist = new Map();
  const stateDist = new Map();
  const confs = [];
  const rows = [];

  for (let i = 1; i <= N; i++) {
    const engine = createIntentEngine({ model: { provider: PROVIDER } });
    const r = await engine.understand({ scenarioKey: p.scenarioKey, clues: p.clues, patientId: 'var-probe' });
    const c = r.candidates || [];
    const t = c[0];
    countDist.set(c.length, (countDist.get(c.length) || 0) + 1);
    stateDist.set(r.state, (stateDist.get(r.state) || 0) + 1);
    if (t) confs.push(t.confidence);
    rows.push({ i, n: c.length, conf: t ? t.confidence : 0, state: r.state, text: t ? t.text : '--' });
  }

  console.log(`\n【${p.id}】线索 ${JSON.stringify(p.clues.icons)}`);
  console.log(`${'次'.padEnd(4)} ${'n'.padEnd(4)} ${'top1'.padEnd(9)} ${'state'.padEnd(11)} top1 文本`);
  console.log('─'.repeat(80));
  rows.forEach((x) => console.log(`${String(x.i).padEnd(4)} ${String(x.n).padEnd(4)} ${x.conf.toFixed(4).padEnd(9)} ${x.state.padEnd(11)} ${x.text}`));

  console.log('─'.repeat(80));
  console.log(`  候选数分布 : ${[...countDist.entries()].map(([k, v]) => `n=${k}×${v}`).join(', ')}`);
  console.log(`  state 分布 : ${[...stateDist.entries()].map(([k, v]) => `${k}×${v}`).join(', ')}`);
  const mn = Math.min(...confs); const mx = Math.max(...confs);
  console.log(`  置信区间   : [${mn.toFixed(4)}, ${mx.toFixed(4)}]  极差 = ${(mx - mn).toFixed(4)}`);
  console.log(`  跨 0.6 门槛 : ${mn < 0.6 && mx >= 0.6 ? '🔴 是 —— 同一输入会得到相反的产品行为' : '否'}`);

  if (stateDist.size > 1) {
    console.log(`\n  🔴 **state 不稳定**：同一组线索 ${N} 次里有 ${stateDist.size} 种结果。`);
    console.log(`     由于竞态已修复，残余波动来自**模型采样**（同一提示词返回的候选条数不定）。`);
  } else {
    console.log(`\n  ✓ state 稳定（${[...stateDist.keys()][0]}）`);
  }
}

console.log(`\n${line}\n`);
