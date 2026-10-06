/**
 * 验证 similarity() 的可靠性 —— 这是全项目的判分基石
 *
 * similarity() 被用在三处关键位置：
 *   1. dedupeCandidates  —— 判断候选是否同义重复（阈值 0.7）
 *   2. run-eval 判中口径  —— 判断候选是否命中标准答案（阈值 0.42）
 *   3. alignTemplate     —— 候选对齐到意图模板
 *
 * 如果它对中文近义句失效，那么这三处**全部不可靠**，
 * 包括「Top-3 命中率」这个核心参赛数字本身。
 * 必须实测清楚它到底在什么情况下有效、什么情况下失效。
 */

import { similarity } from '../server/domain/scoring.js';

console.log('=== A 组：语义相同，测试算法能否识别 ===\n');
const SAME_MEANING = [
  ['我左腿麻', '我的左腿发麻'],
  ['我头疼', '头很疼'],
  ['我想喝水', '我想喝点水'],
  ['我想看电视里的戏曲', '帮我打开电视看戏曲'],
  ['我饿了，想吃饭', '我要吃饭'],
  ['我该几点吃药？', '什么时候吃药'],
  ['我困了，想睡觉', '想睡觉'],
  ['我叫小王来', '叫王姐过来一下'],
];

for (const [a, b] of SAME_MEANING) {
  const s = similarity(a, b);
  console.log(`  ${s.toFixed(4)}  「${a}」vs「${b}」`);
}

console.log('\n=== B 组：语义不同，测试算法是否误判 ===\n');
const DIFF_MEANING = [
  ['我想喝水', '我想吃饭'],
  ['我想睡觉', '我想关灯'],
  ['我头疼', '我腿疼'],
  ['我要上厕所', '我要吃药'],
  ['我想看电视', '我想看戏曲频道'],
];

for (const [a, b] of DIFF_MEANING) {
  const s = similarity(a, b);
  console.log(`  ${s.toFixed(4)}  「${a}」vs「${b}」`);
}

console.log('\n=== C 组：判中阈值 0.42 的实际表现 ===\n');
console.log('  标准答案与模型候选的相似度（决定是否记为命中）：\n');
const JUDGE = [
  ['我头疼', '我头疼', '✓ 完全一致'],
  ['我头疼', '头很疼', '✓ 语义相同'],
  ['我要上厕所，很急', '我急着要上厕所', '✓ 语义相同'],
  ['我想看戏曲频道', '我想看电视里的戏曲', '✓ 语义相同'],
  ['我想坐轮椅下楼晒太阳', '我想坐轮椅下楼晒太阳', '✓ 完全一致'],
  ['我想儿子了', '我想我儿子了', '✓ 语义相同'],
];

for (const [answer, cand, note] of JUDGE) {
  const s = similarity(cand, answer);
  const pass = s >= 0.42;
  console.log(`  ${s.toFixed(4)}  ${pass ? '[判中]' : '[判定未命中]'}  「${cand}」 vs 答案「${answer}」  ${note}`);
}

console.log('\n=== 结论 ===');
console.log('  若「语义相同」的相似度普遍低于 0.42，则判中口径会系统性地漏判 ——');
console.log('  即：模型答对了，但评测认为它没答对。分数被低估，且低估幅度无法估量。');
