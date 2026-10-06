/**
 * 相似度算法判别力验证 —— v1.3 新增，锁住核心度量
 *
 * 【为什么必须有这个测试】
 * similarity() 是全项目的判分基石，用在三处：
 *   ① 评测判中（阈值 0.35）② 候选去重（阈值 0.45）③ 模板对齐（阈值 0.2）
 * 它在 v1.2 及以前用的是字符 bigram Jaccard，**判别力趋近于零**：
 *   语义相同 → 0.00 ~ 0.40
 *   语义不同 → 0.00 ~ 0.25
 * 两区间完全重叠，导致「Top-3 命中率」这一核心参赛指标长期不可信，
 * 而且这个缺陷潜藏了很久都没被发现 —— 因为它不报错、不崩溃，
 * 只是安静地把分数算错。
 *
 * 本测试的作用就是让这种「安静的失效」变成「响亮的失败」：
 * 任何人若把算法改回退化版本，这里会立刻红。
 *
 * 运行：node eval/verify-similarity.js
 */

import { similarity, similarityLegacy, injectNormalize, normalizeReady } from '../server/domain/scoring.js';
import { normalizeClue } from '../server/domain/normalize.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${desc}`); }
  else { fail += 1; failures.push(desc); console.log(`  ✗ ${desc}  ${detail}`); }
}

function group(title) {
  console.log(`\n${'─'.repeat(62)}\n${title}\n${'─'.repeat(62)}`);
}

// ══════════════════════════════════════════════════════════════
group('[0] 时序确定性 —— 相似度不得依赖调用时机（v1.4 新增守卫）');

// 【这个守卫守的是什么】
// v1.3 曾把归一化做成「动态 import 惰性自初始化」，而 similarity() 是同步函数 ——
// 于是首次调用拿到空概念集、退化为纯字面比较，等 promise 落定后又走高精度路径。
// 实测同一进程内「我头疼 / 头很疼」0.2000 → 1.0000，4/4 对句子漂移。
// 产品后果：**患者按键的时机影响排序与是否澄清** —— 同一个人同一句话得到不同结果。
//
// 守卫做法：在模块刚加载、**尚未做任何 compare** 的瞬间就测一组分数，
// 等事件循环跑几圈后再测同一组，两次必须完全一致。
const RACE_PROBE = [
  ['我头疼', '头很疼'],
  ['我左腿麻', '我的左腿发麻'],
  ['我想喝水', '我要喝水'],
  ['我想上厕所', '我要上厕所，很急'],
];

const immediate = RACE_PROBE.map(([a, b]) => similarity(a, b));

// 让所有待处理的微任务/定时器跑完，确保任何「异步初始化」都已就绪
await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setImmediate(r));

const settled = RACE_PROBE.map(([a, b]) => similarity(a, b));

let raced = 0;
RACE_PROBE.forEach(([a, b], i) => {
  if (Math.abs(immediate[i] - settled[i]) > 1e-9) {
    raced += 1;
    console.log(`      🔴 「${a}」vs「${b}」：${immediate[i].toFixed(4)} → ${settled[i].toFixed(4)}`);
  }
});
check('模块加载瞬间的相似度 === 事件循环稳定后的相似度（无竞态）', raced === 0,
  `${raced}/${RACE_PROBE.length} 对句子漂移 —— 归一化可能又变回了异步加载`);

check('normalizeReady() 在模块加载瞬间即为 true', normalizeReady().ready,
  '归一化必须在第一行代码起就同步可用');

// injectNormalize 保留但已是幂等的测试钩子 —— 调用后结果不得改变
const beforeInject = similarity('我头疼', '头很疼');
injectNormalize({ normalizeClue });
const afterInject = similarity('我头疼', '头很疼');
check('injectNormalize 是幂等的（幂等注入不改变分数）',
  Math.abs(beforeInject - afterInject) < 1e-9,
  `${beforeInject} → ${afterInject}`);

// ══════════════════════════════════════════════════════════════
group('[1] 归一化能力必须就绪（否则相似度静默退化）');

const ready = normalizeReady();
check('归一化已就绪', ready.ready, ready.error);
check('normalizeClue 能识别词表概念', normalizeClue('我想喝水').includes('水'),
  JSON.stringify(normalizeClue('我想喝水')));

// ══════════════════════════════════════════════════════════════
group('[2] 语义相同的句子 —— 必须给出高分（旧算法在此全面失败）');

// 每项：[句子A, 句子B, 最低可接受分, 说明]
const SAME_CASES = [
  ['我头疼', '头很疼', 0.35, '旧算法 0.0000 —— 加一个「很」字就归零'],
  ['我左腿麻', '我的左腿发麻', 0.35, '旧算法 0.1429'],
  ['我想喝水', '我想喝点水', 0.35, '旧算法 0.4000'],
  ['我想看电视里的戏曲', '帮我打开电视看戏曲', 0.35, '旧算法 0.1429'],
  ['我饿了，想吃饭', '我要吃饭', 0.35, '旧算法 0.1250'],
  ['我要上厕所，很急', '我急着要上厕所', 0.35, '旧算法 0.3000'],
  ['我困了，想睡觉', '想睡觉', 0.35, '旧算法 0.3333'],
  ['我想儿子了', '我想我儿子了', 0.50, '旧算法 0.5000'],
  ['帮我给闺女打电话', '我想给闺女打电话', 0.50, '旧算法 0.5556'],
  ['我想上厕所', '我要去厕所', 0.50, '同义改写'],
  ['我头疼，有点难受', '我头疼', 0.50, '包含关系'],
  ['我要吃药，帮我倒点水', '我要吃药，喝点水', 0.50, '同义改写'],
];

for (const [a, b, min, note] of SAME_CASES) {
  const s = similarity(a, b);
  check(`「${a}」≈「${b}」 得 ${s.toFixed(4)} ≥ ${min}`, s >= min, note);
}

// ══════════════════════════════════════════════════════════════
group('[3] 语义不同的句子 —— 必须给出低分（不能被字面相似度骗到）');

const DIFF_CASES = [
  ['我想喝水', '我想吃饭', 0.35],
  ['我想睡觉', '我想关灯', 0.35],
  ['我头疼', '我腿疼', 0.35],
  ['我要上厕所', '我要吃药', 0.35],
  ['我想看电视', '我想看戏曲频道', 0.35],
  ['我要睡觉', '我想出门', 0.35],
  ['我饿了', '我渴了', 0.35],
  ['我想喝水', '我要上厕所', 0.35],
  ['我头疼', '我头晕', 0.35],
  ['我想看电视', '我想下楼晒太阳', 0.35],
  ['我要吃药', '我要睡觉', 0.35],
];

for (const [a, b, max] of DIFF_CASES) {
  const s = similarity(a, b);
  check(`「${a}」≉「${b}」 得 ${s.toFixed(4)} < ${max}`, s < max);
}

// ══════════════════════════════════════════════════════════════
group('[4] 方向性语义必须被守住（否定 / 程度）');

// 这三条是护理场景下的安全底线，语义相反绝不能被判成相似
const POLARITY_CASES = [
  ['我想喝水', '我不想喝水', '否定必须显著降低相似度'],
  ['我有点疼', '我疼得很厉害', '程度悬殊 —— 一个可忍、一个要立即处理'],
];
for (const [a, b, note] of POLARITY_CASES) {
  const s = similarity(a, b);
  check(`「${a}」vs「${b}」 得 ${s.toFixed(4)} < 0.45`, s < 0.45, note);
}

// ══════════════════════════════════════════════════════════════
group('[5] 分离度总检 —— 两组区间必须可分');

const sameScores = SAME_CASES.map(([a, b]) => similarity(a, b));
const diffScores = DIFF_CASES.map(([a, b]) => similarity(a, b));
const minSame = Math.min(...sameScores);
const maxDiff = Math.max(...diffScores);

check(`同义最低分 ${minSame.toFixed(4)} > 异义最高分 ${maxDiff.toFixed(4)}`,
  minSame > maxDiff,
  `间隙 ${(minSame - maxDiff).toFixed(4)}`);
check('判中阈值 0.35 落在可分区间内',
  maxDiff < 0.35 && 0.35 <= minSame,
  `异义最高 ${maxDiff.toFixed(4)} / 同义最低 ${minSame.toFixed(4)}`);

// ══════════════════════════════════════════════════════════════
group('[6] 回归护栏 —— 旧算法必须在这些用例上失败');

// 若有人把实现改回字符 bigram，本组会通过而 [2] 组会失败 —— 双重保险
let legacyWouldFail = 0;
for (const [a, b, min] of SAME_CASES) {
  if (similarityLegacy(a, b) < min) legacyWouldFail += 1;
}
check(`旧算法在 ${legacyWouldFail}/${SAME_CASES.length} 条同义用例上不达标`,
  legacyWouldFail > SAME_CASES.length / 2,
  '若此条失败，说明用例集本身失去了区分力');

// ══════════════════════════════════════════════════════════════
group('[7] 边界与健壮性');

check('空串对空串 → 1', similarity('', '') === 1);
check('空串对非空 → 0', similarity('', '我头疼') === 0);
check('完全相同 → 1', similarity('我头疼', '我头疼') === 1);
check('单字对单字相同 → 1', similarity('水', '水') === 1);
check('单字对单字不同 → 0', similarity('水', '饭') === 0);
check('结果恒在 [0,1]', (() => {
  const samples = [['a', 'b'], ['我头疼', '头很疼'], ['我想喝水', '我不想喝水']];
  return samples.every(([a, b]) => {
    const s = similarity(a, b);
    return s >= 0 && s <= 1;
  });
})());
check('null / undefined 不抛异常', (() => {
  try { similarity(null, '水'); similarity(undefined, undefined); return true; }
  catch { return false; }
})());

// ══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(62)}`);
console.log(`  相似度判别力：通过 ${pass} ／ 失败 ${fail}`);
if (fail) {
  console.log('\n  失败项：');
  for (const f of failures) console.log(`    · ${f}`);
  console.log('\n  ⚠️ similarity 是评测判中 / 候选去重 / 模板对齐的共同依据，');
  console.log('     此处失败意味着评测数字不可信，不可忽略。');
}
console.log(`${'═'.repeat(62)}\n`);

process.exit(fail ? 1 : 0);
