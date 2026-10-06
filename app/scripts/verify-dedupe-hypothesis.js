/**
 * 验证推断：模型候选「同义不同说法」未被去重，导致前二差值过小触发澄清
 *
 * 如果推断成立，那么 dedupeCandidates 的阈值 0.7 对模型输出偏严 ——
 * 「我左腿麻」与「我的左腿发麻」语义几乎相同，但字符 bigram Jaccard 达不到 0.7。
 */

import { loadEnv } from '../server/data/env.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

import { similarity, dedupeCandidates } from '../server/domain/scoring.js';
import { decideClarification } from '../server/domain/clarify.js';

console.log('=== 第 1 步：真实模型产出的「同义候选」相似度实测 ===\n');

const PAIRS = [
  ['我左腿麻', '我的左腿发麻', 'E08 模型输出（应视为同义）'],
  ['我想喝水', '我想喝点水', 'E02 模型输出'],
  ['我要吃药，喝点水', '我该吃药了', 'E10 模型输出'],
  ['我头疼', '头很疼', 'E07 模型输出'],
  ['我想睡觉', '我想关灯睡觉', 'E04 模型输出（这条确实该区分）'],
  ['我想看电视里的戏曲', '帮我打开电视看戏曲', 'E13 模型输出'],
  ['我饿了，想吃晚饭', '我想吃晚饭，再喝点水', 'E01 模型输出'],
];

for (const [a, b, note] of PAIRS) {
  const s = similarity(a, b);
  console.log(`  ${s.toFixed(4)}  ${s >= 0.7 ? '[会被去重]' : '[不会去重]'}  「${a}」vs「${b}」`);
  console.log(`          ${note}`);
}

console.log('\n=== 第 2 步：这些候选进入排序后，R4 如何裁决 ===\n');

const SCENARIOS = [
  { id: 'E08', cands: [['我左腿麻', 0.718], ['我的左腿发麻', 0.702], ['左腿麻，有点不舒服', 0.642]] },
  { id: 'E02', cands: [['我想喝水', 0.6646], ['我想喝点水', 0.624], ['我渴了，想喝水', 0.5806]] },
  { id: 'E04', cands: [['我想睡觉', 0.6439], ['我想关灯睡觉', 0.6368], ['我想关灯', 0.5215]] },
];

for (const sc of SCENARIOS) {
  const raw = sc.cands.map(([text, confidence]) => ({ text, confidence }));
  const kept = dedupeCandidates(raw);
  console.log(`  ${sc.id}`);
  console.log(`    原始候选 ${raw.length} 个 → 去重后 ${kept.length} 个`);
  for (const k of kept) console.log(`      · ${k.text} (${k.confidence})`);

  const ranked = kept.map((c, i) => ({ ...c, rank: i + 1 }));
  const d = decideClarification(ranked, 0, { clueTypeCount: 2 });
  console.log(`    裁决 → state=${d.state}  type=${d.clarification?.type || '-'}`);
  console.log(`    理由 → ${d.reason || '-'}`);
  const gap = ranked.length >= 2 ? (ranked[0].confidence - ranked[1].confidence).toFixed(4) : '-';
  console.log(`    前二差值 → ${gap}\n`);
}

console.log('=== 第 3 步：若把同义候选合并，裁决会怎样变化 ===\n');
for (const sc of SCENARIOS) {
  // 假设理想去重：只保留"意思不同"的候选
  const ideal = [sc.cands[0], sc.cands[2]].map(([text, confidence]) => ({ text, confidence }));
  const ranked = ideal.map((c, i) => ({ ...c, rank: i + 1 }));
  const d = decideClarification(ranked, 0, { clueTypeCount: 2 });
  const gap = (ranked[0].confidence - ranked[1].confidence).toFixed(4);
  console.log(`  ${sc.id}  理想去重后 ${ranked.length} 个候选，前二差值 ${gap} → state=${d.state} ${d.clarification?.type || ''}`);
}
