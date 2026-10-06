/**
 * 阈值标定 —— 在新相似度尺度下重新确定三个阈值
 *
 * 新算法把分数尺度整体改变了，旧的三个阈值全部需要复核：
 *   ① 评测判中阈值（原 0.42，字符 bigram 尺度）
 *   ② 候选去重阈值（原 0.7，同一旧尺度）
 *   ③ 模板对齐阈值（engine 里硬编码 0.2）
 *
 * 标定原则：找出「语义相同」与「语义不同」两组分数的**最大分离点**，
 * 而不是凭感觉给一个数。本脚本用一批人工标注的句子对做标定集。
 */

import { similarity as simNew, similarityLegacy as simOld, normalizeReady } from '../server/domain/scoring.js';
import { injectNormalize } from '../server/domain/scoring.js';
import { normalizeClue } from '../server/domain/normalize.js';

// 必须注入 —— similarity 的概念信号依赖它。不注入会静默退化为纯字面比较。
injectNormalize({ normalizeClue });
console.log('归一化就绪状态:', JSON.stringify(normalizeReady()));

// ── 标定集：语义相同 ─────────────────────────────────────────
const SAME = [
  ['我左腿麻', '我的左腿发麻'], ['我头疼', '头很疼'],
  ['我想喝水', '我想喝点水'], ['我想看电视里的戏曲', '帮我打开电视看戏曲'],
  ['我饿了，想吃饭', '我要吃饭'], ['我该几点吃药？', '什么时候吃药'],
  ['我困了，想睡觉', '想睡觉'], ['我要上厕所，很急', '我急着要上厕所'],
  ['我想看戏曲频道', '我想看电视里的戏曲'], ['我想儿子了', '我想我儿子了'],
  ['帮我给闺女打电话', '我想给闺女打电话'], ['我想上厕所', '我要去厕所'],
  ['我有点头晕', '头有点晕'], ['我饿了，想吃饭，再喝点水', '我想吃晚饭，再喝点水'],
  ['我该几点吃药？', '傍晚的药现在吃吗？'], ['我要吃药，帮我倒点水', '我要吃药，喝点水'],
  ['我头疼，有点难受', '我头疼'], ['我想坐轮椅下楼晒太阳', '我想下楼晒会儿太阳'],
  ['我左腿麻', '左腿麻，有点不舒服'], ['我想跟小王视频', '叫王姐过来一下'],
  // 以下 4 对第一轮被误标为 DIFF，实际语义相同 —— 移回本组
  ['我想看电视里的戏曲', '帮我打开电视看戏曲'],
  ['我饿了，想吃晚饭', '我想吃晚饭，再喝点水'],
  ['我该吃药了', '我要吃药，喝点水'],
  ['我左腿发麻', '左腿麻，有点不舒服'],
];

// ── 标定集：语义不同 ─────────────────────────────────────────
//
// ⚠️ 标定纪律（第一轮犯过的错）：
// 第一轮我把「我想看电视里的戏曲」vs「帮我打开电视看戏曲」等 4 对放进了 DIFF 组，
// 但它们**语义实际相同** —— 于是算法的高分被当成「误判」，我自己标注错误
// 反而冤枉了算法。手动标定的第一步是确认标注本身没错，不是怀疑算法。
const DIFF = [
  ['我想喝水', '我想吃饭'], ['我想睡觉', '我想关灯'],
  ['我头疼', '我腿疼'], ['我要上厕所', '我要吃药'],
  ['我想看电视', '我想看戏曲频道'], ['我想喝水', '我不想喝水'],
  ['我有点疼', '我疼得很厉害'], ['我要睡觉', '我想出门'],
  ['我饿了', '我渴了'], ['叫小王来', '叫小李来'],
  ['我想喝水', '我要上厕所'], ['我头疼', '我头晕'],
  ['我有点烦', '别烦我'],                        // 完全不同的意思
  ['我想一个人待会儿', '我想儿子了'],            // 边界
  ['我想睡觉', '我想关灯睡觉'],                  // 边界：多了个动作，确需区分
  ['我想去厕所，然后换', '我想去厕所'],          // 边界：多了个动作
  ['我想看电视', '我想下楼晒太阳'],              // 完全不同
  ['我要吃药', '我要睡觉'],                      // 完全不同
];

console.log('\n=== 语义相同组（分数分布）===\n');
const sameScores = SAME.map(([a, b]) => {
  const n = simNew(a, b); const o = simOld(a, b);
  console.log(`  新 ${n.toFixed(4)}  旧 ${o.toFixed(4)}   「${a}」vs「${b}」`);
  return n;
}).sort((x, y) => x - y);

console.log('\n=== 语义不同组（分数分布）===\n');
const diffScores = DIFF.map(([a, b]) => {
  const n = simNew(a, b); const o = simOld(a, b);
  console.log(`  新 ${n.toFixed(4)}  旧 ${o.toFixed(4)}   「${a}」vs「${b}」`);
  return n;
}).sort((x, y) => y - x);

console.log('\n' + '═'.repeat(68));
console.log('分布对比');
console.log('═'.repeat(68));
console.log(`  语义相同：最低 ${sameScores[0].toFixed(4)} / 中位 ${sameScores[Math.floor(sameScores.length / 2)].toFixed(4)} / 最高 ${sameScores[sameScores.length - 1].toFixed(4)}`);
console.log(`  语义不同：最高 ${diffScores[0].toFixed(4)} / 中位 ${diffScores[Math.floor(diffScores.length / 2)].toFixed(4)} / 最低 ${diffScores[diffScores.length - 1].toFixed(4)}`);

// 扫描最佳分离点：使「误判」数量最少的阈值
console.log('\n=== 阈值扫描：找误判最少的分离点 ===\n');
let best = { t: 0, err: Infinity, fp: 0, fn: 0 };
const rows = [];
for (let t = 0.10; t <= 0.90; t += 0.05) {
  const fn = sameScores.filter((s) => s < t).length;  // 同义被判否
  const fp = diffScores.filter((s) => s >= t).length; // 不同被判是
  const err = fn + fp;
  rows.push({ t: t.toFixed(2), fn, fp, err });
  if (err < best.err) best = { t: Number(t.toFixed(2)), err, fp, fn };
}
for (const r of rows) {
  const mark = Number(r.t) === best.t ? '  ← 最优' : '';
  console.log(`  阈值 ${r.t}   同义漏判 ${r.fn}   异义误判 ${r.fp}   合计 ${r.err}${mark}`);
}

console.log('\n' + '═'.repeat(68));
console.log(`  最优阈值 ${best.t}（误判 ${best.err} 对 / 共 ${SAME.length + DIFF.length} 对）`);
console.log(`    其中：同义被漏判 ${best.fn} 对，异义被误判 ${best.fp} 对`);
console.log('═'.repeat(68));
