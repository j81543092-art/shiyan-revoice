/**
 * 🔴 竞态复现：normalize 惰性自初始化与同步 similarity 的时序冲突。
 *
 * 怀疑（待证实）：
 *   scoring.js 的 _normalizeImpl 由**动态 import** 异步填充，
 *   但 similarity() 是**同步**函数，且第一对比较时会拿到空概念集
 *   （conceptSet 里 `if (!_normalizeImpl) { ensureNormalize(); return out; }`）。
 *
 *   如果为真，则：
 *     · 模块首次被使用后的**头几次** compare 会退化为纯字面比较 → 分数偏低
 *     · 等 promise 落定后，同样的 compare 会走上「概念优先」→ 分数偏高
 *     · 结果是**同一个输入、同一个进程内，前后得到不同分数** —— 取决于时序
 *
 * 这个脚本不改任何业务代码，只在**同一个进程里**、
 * 用 await 精确控制「promise 是否已落定」，对同一对句子测两次。
 *
 * 用法：
 *   node scripts/repro-normalize-race.js
 */
import { similarity, normalizeReady } from '../server/domain/scoring.js';

const PAIRS = [
  ['我头疼', '头很疼', '同义 —— 旧算法 0.0000'],
  ['我想上厕所', '我要上厕所，很急', '同义'],
  ['我左腿麻', '我的左腿发麻', '同义'],
  ['我想喝水', '我要喝水', '同义'],
];

const line = '─'.repeat(78);
console.log(`\n${line}`);
console.log('  竞态复现：normalize 惰性初始化 vs 同步 similarity');
console.log(line);

console.log(`\n模块刚 import 完，尚未做任何 compare：`);
console.log(`  normalizeReady() = ${JSON.stringify(normalizeReady())}`);

// ── 第一次测量：趁 _normalizeImpl 还没被 promise 填上 ──
console.log(`\n【测量 A】立即调用（此时动态 import 极可能尚未落定）`);
const before = PAIRS.map(([a, b]) => similarity(a, b));
PAIRS.forEach(([a, b, note], i) => {
  console.log(`  ${a.padEnd(12)} vs ${b.padEnd(16)} = ${before[i].toFixed(4)}   ${note}`);
});

// ── 让事件循环跑几圈，确保动态 import 的 promise 落定 ──
await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setImmediate(r));

console.log(`\n等 promise 落定后：`);
console.log(`  normalizeReady() = ${JSON.stringify(normalizeReady())}`);

// ── 第二次测量：同样的句子，同样的函数 ──
console.log(`\n【测量 B】promise 落定后再调用同一对句子`);
const after = PAIRS.map(([a, b]) => similarity(a, b));
PAIRS.forEach(([a, b, note], i) => {
  console.log(`  ${a.padEnd(12)} vs ${b.padEnd(16)} = ${after[i].toFixed(4)}   ${note}`);
});

// ── 结论 ──
console.log(`\n${line}`);
let drifted = 0;
PAIRS.forEach(([a, b], i) => {
  const d = after[i] - before[i];
  if (Math.abs(d) > 1e-9) {
    drifted++;
    console.log(`  🔴 「${a}」vs「${b}」： ${before[i].toFixed(4)} → ${after[i].toFixed(4)}  漂移 ${d >= 0 ? '+' : ''}${d.toFixed(4)}`);
  }
});
if (drifted > 0) {
  console.log(`\n  🔴 证实竞态：${drifted}/${PAIRS.length} 对句子在**同一进程内**前后得分不同。`);
  console.log(`     根因：conceptSet() 首次调用返回空集（同时触发异步预加载），`);
  console.log(`           而 similarity() 是同步的 —— 行为取决于 promise 是否已落定。`);
  console.log(`     产品后果：患者按下按钮的**时机**会影响候选排序与是否澄清，`);
  console.log(`               这与「模型不稳定」是两回事 —— 是我们自己的时序 bug。`);
} else {
  console.log(`  ✓ 未发现漂移 —— 怀疑不成立（可能 conceptSet 的调用点都在 promise 之后）`);
}
console.log(`\n${line}\n`);
