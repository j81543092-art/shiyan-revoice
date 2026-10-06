/**
 * E06 置信度漂移追踪。
 *
 * 现象：同一组线索（toilet：厕所 + 换）在不同 patientId 下得到
 * top1 置信 0.5933 与 0.6343 两个值，跨过了 R4 的 0.6 门槛，
 * 导致「澄清 / 不澄清」两种相反结果。
 *
 * 本脚本用**同一个 provider、同一组线索、只改 patientId**，
 * 确认漂移是否由个性化画像/缓存造成 —— 如果是，那是一个真 bug：
 * 同一个患者说同一句话，不该因为「换了个人」就改变是否澄清。
 *
 * 用法：
 *   node scripts/diagnose-e06-drift.js
 *   MODEL_PROVIDER=huawei node scripts/diagnose-e06-drift.js
 */
import { createIntentEngine } from '../server/domain/engine.js';
import { loadEnv } from '../server/data/env.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

const PROVIDER = process.env.MODEL_PROVIDER || 'rule';

const CLUES = { icons: ['厕所', '换'], keywords: [], voiceFragments: [] };
const PATIENTS = ['diag-r4', 'diag2', 'eval', 'p-e06-a', 'p-e06-b'];

const line = '─'.repeat(78);
console.log(`\n${line}`);
console.log(`  E06 置信度漂移追踪 ｜ provider = ${PROVIDER}`);
console.log(`  线索固定为 toilet：icons=[厕所,换]，只改 patientId`);
console.log(line);
console.log(`${'patientId'.padEnd(14)} ${'state'.padEnd(11)} ${'top1'.padEnd(9)} ${'top1 文本'}`);
console.log(line);

const rows = [];
for (const pid of PATIENTS) {
  // 每个 patientId 用**全新引擎**，避免进程内缓存串味
  const engine = createIntentEngine({ model: { provider: PROVIDER } });
  const r = await engine.understand({
    scenarioKey: 'toilet',
    clues: CLUES,
    patientId: pid,
  });
  const top1 = (r.candidates || [])[0];
  rows.push({ pid, state: r.state, conf: top1 ? top1.confidence : 0, text: top1 ? top1.text : '(无)' });
  console.log(
    `${pid.padEnd(14)} ${String(r.state).padEnd(11)} ${(top1 ? top1.confidence.toFixed(4) : '--').padEnd(9)} ${top1 ? top1.text : '(无)'}`
  );
}

console.log(line);
const confs = rows.map((r) => r.conf);
const min = Math.min(...confs);
const max = Math.max(...confs);
console.log(`  置信区间 = [${min.toFixed(4)}, ${max.toFixed(4)}]  跨度 = ${(max - min).toFixed(4)}`);
const states = new Set(rows.map((r) => r.state));
if (states.size > 1) {
  console.log(`  🔴 **同一组线索得到 ${states.size} 种不同 state** —— 这是真 bug，不是调参问题`);
  console.log(`     解释：state 不该依赖 patientId 是否已有画像/缓存`);
} else if (max - min > 1e-6) {
  console.log(`  ⚠️  置信度随 patientId 漂移但未改变 state（跨度 ${(max - min).toFixed(4)}）`);
} else {
  console.log(`  ✓ 置信度不随 patientId 漂移`);
}
console.log(`\n  参照：R4 门槛 lowConfidence = 0.6，本用例恰好骑在门槛上`);
console.log(`  ${min.toFixed(4)} < 0.6 <= ${max.toFixed(4)} ? ${min < 0.6 && max >= 0.6 ? '是 —— 门槛骑线，最脆弱' : '否'}`);
console.log(`\n${line}\n`);
