/**
 * 分层相似度方案 —— 规则快判 + 大模型兜底
 *
 * 【为什么不能用单一方案】
 * 纯规则（字符/词表）：快、免费、离线，但对「人名不同」「同义动词」无能为力。
 *   实测最好成绩仍是「我叫小王来」vs「叫王姐过来一下」= 0.13。
 * 纯大模型：准，但每次调用 2~5s、按量计费，**绝不能用在实时排序上** ——
 *   患者端一次表达就要排序 3~5 个候选，逐个调模型是不可接受的。
 *
 * 【分层设计】
 *   L1 规则快判（<1ms，免费）—— 处理绝大多数情况
 *       · 分数很高（>0.75）→ 直接判「是」
 *       · 分数很低（<0.30）→ 直接判「否」
 *       · 中间灰区 → 交给 L2
 *   L2 大模型精判（异步，仅灰区，可缓存）—— 处理规则无能为力的同义改写
 *
 * 【关键约束】
 *   L2 只用于「离线评测与家属端复核」，**不进入患者端实时路径**。
 *   患者端的候选去重仍用 L1 —— 宁可少去重，也不能让患者等模型。
 *   这是产品红线（WCAG 84px 触控目标背后的同一个立场：响应速度优先）。
 *
 * 本文件先建立 L1 的**灰区识别能力**，并量化「有多少比例需要 L2」。
 * 灰区比例越低，L2 的成本与延迟就越可控。
 */

import { normalizeClue, SYNONYM_MAP } from '../server/domain/normalize.js';

const STOP_WORDS = new Set([
  '的', '了', '着', '过', '地', '得', '是', '在', '有',
  '会', '能', '可', '可以', '请', '帮我', '给我',
  '一个', '一下', '一点', '一些', '稍微', '比较', '挺',
  '那个', '这个', '然后', '就是', '好像', '大概', '嗯', '呃', '啊', '哦', '呀',
  '吧', '呢', '吗', '嘛', '啦', '再', '又', '还', '就', '都', '也',
]);
const FIRST_PERSON = new Set(['我', '你', '他', '她', '它', '俺', '咱', '自己', '我们', '你们', '他们']);
const MODALS = new Set(['想', '要', '得', '需', '需要', '打算']);

const NEGATION = ['不', '别', '没', '不要', '不用', '不想', '不能', '无法', '拒绝'];
const HIGH_DEGREE = ['很', '非常', '特别', '太', '极了', '厉害', '严重', '受不了'];
const LOW_DEGREE = ['有点', '稍微', '一点', '些', '轻微', '略微'];

export function conceptSet(text) {
  const out = new Set();
  try { for (const w of normalizeClue(String(text || ''))) out.add(w); } catch { /* 降级 */ }
  const s = String(text || '');
  for (const [word, variants] of Object.entries(SYNONYM_MAP)) {
    if (s.includes(word)) out.add(word);
    for (const v of variants) if (s.includes(v)) out.add(word);
  }
  return out;
}

function contentChars(s) {
  const clean = String(s || '').replace(/[\s，。、！？,.!?；;：:'"（）()【】\[\]—-]/g, '');
  const cs = [...clean].filter((c) => !STOP_WORDS.has(c) && !FIRST_PERSON.has(c) && !MODALS.has(c));
  return cs.length ? cs : [...clean];
}

function bigrams(arr) {
  const out = new Set();
  if (arr.length === 0) return out;
  if (arr.length === 1) { out.add(arr[0]); return out; }
  for (let i = 0; i < arr.length - 1; i++) out.add(arr[i] + arr[i + 1]);
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function polarityPenalty(a, b) {
  const sA = String(a || ''); const sB = String(b || '');
  const has = (s, list) => list.some((w) => s.includes(w));
  let penalty = 1;
  if (has(sA, NEGATION) !== has(sB, NEGATION)) penalty *= 0.30;
  const hiA = has(sA, HIGH_DEGREE); const loA = has(sA, LOW_DEGREE);
  const hiB = has(sB, HIGH_DEGREE); const loB = has(sB, LOW_DEGREE);
  if ((hiA && loB) || (loA && hiB)) penalty *= 0.40;
  return penalty;
}

/** L1 规则相似度 —— 与 v3 一致 */
export function similarityL1(a, b) {
  const rawA = String(a || ''); const rawB = String(b || '');
  if (rawA === rawB) return 1;
  if (!rawA || !rawB) return 0;

  const cA = conceptSet(rawA); const cB = conceptSet(rawB);
  const conceptSig = (cA.size && cB.size) ? jaccard(cA, cB) : null;
  const skelA = contentChars(rawA); const skelB = contentChars(rawB);
  const s2 = jaccard(bigrams(skelA), bigrams(skelB));
  const s3 = jaccard(new Set(skelA), new Set(skelB));
  const s4 = jaccard(bigrams([...rawA]), bigrams([...rawB]));

  let score;
  if (conceptSig === null) score = (0.30 * s2 + 0.15 * s3 + 0.05 * s4) / 0.50;
  else {
    score = 0.50 * conceptSig + 0.30 * s2 + 0.15 * s3 + 0.05 * s4;
    if (conceptSig > 0) score = Math.max(score, conceptSig);
  }
  return Math.min(Math.max(score * polarityPenalty(rawA, rawB), 0), 1);
}

/** 灰区边界 —— 由实测数据标定 */
export const GRAY_ZONE = Object.freeze({ high: 0.75, low: 0.30 });

/**
 * L1 判定 + 灰区标记。
 * @returns {{score:number, verdict:'same'|'different'|'uncertain'}}
 */
export function judgeL1(a, b) {
  const score = similarityL1(a, b);
  if (score >= GRAY_ZONE.high) return { score, verdict: 'same' };
  if (score < GRAY_ZONE.low) return { score, verdict: 'different' };
  return { score, verdict: 'uncertain' };
}

// ══════════════════════════════════════════════════════════════
const SAME = [
  ['我左腿麻', '我的左腿发麻'], ['我头疼', '头很疼'],
  ['我想喝水', '我想喝点水'], ['我想看电视里的戏曲', '帮我打开电视看戏曲'],
  ['我饿了，想吃饭', '我要吃饭'], ['我该几点吃药？', '什么时候吃药'],
  ['我困了，想睡觉', '想睡觉'], ['我叫小王来', '叫王姐过来一下'],
  ['我要上厕所，很急', '我急着要上厕所'], ['我想看戏曲频道', '我想看电视里的戏曲'],
  ['我想儿子了', '我想我儿子了'], ['帮我给闺女打电话', '我想给闺女打电话'],
  ['我想上厕所', '我要去厕所'], ['我有点头晕', '头有点晕'],
];
const DIFF = [
  ['我想喝水', '我想吃饭'], ['我想睡觉', '我想关灯'],
  ['我头疼', '我腿疼'], ['我要上厕所', '我要吃药'],
  ['我想看电视', '我想看戏曲频道'], ['我想喝水', '我不想喝水'],
  ['我有点疼', '我疼得很厉害'], ['我要睡觉', '我想出门'],
  ['我饿了', '我渴了'], ['叫小王来', '叫小李来'],
  ['我想喝水', '我要上厕所'], ['我头疼', '我头晕'],
];

console.log('=== 灰区分析 ===\n');
console.log(`  判「是」阈值 ${GRAY_ZONE.high}   判「否」阈值 ${GRAY_ZONE.low}\n`);

let needL2Same = 0;
let needL2Diff = 0;

console.log('  ── 语义相同的句子对 ──');
for (const [a, b] of SAME) {
  const r = judgeL1(a, b);
  const tag = r.verdict === 'same' ? '✓直接判是' : r.verdict === 'different' ? '✗误判为否' : '?需L2';
  if (r.verdict === 'uncertain') needL2Same += 1;
  console.log(`   ${r.score.toFixed(4)}  ${tag.padEnd(8)} 「${a}」vs「${b}」`);
}

console.log('\n  ── 语义不同的句子对 ──');
for (const [a, b] of DIFF) {
  const r = judgeL1(a, b);
  const tag = r.verdict === 'different' ? '✓直接判否' : r.verdict === 'same' ? '✗误判为是' : '?需L2';
  if (r.verdict === 'uncertain') needL2Diff += 1;
  console.log(`   ${r.score.toFixed(4)}  ${tag.padEnd(8)} 「${a}」vs「${b}」`);
}

const total = SAME.length + DIFF.length;
const needL2 = needL2Same + needL2Diff;
console.log('\n' + '═'.repeat(64));
console.log(`  总对数 ${total}`);
console.log(`  需 L2 精判（灰区）${needL2} 对，占 ${(needL2 / total * 100).toFixed(1)}%`);
console.log(`  其中：语义相同 ${needL2Same} 对 / 语义不同 ${needL2Diff} 对`);
console.log(`  规则直接判定 ${total - needL2} 对，占 ${((total - needL2) / total * 100).toFixed(1)}%`);
console.log('═'.repeat(64));
