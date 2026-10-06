/**
 * 模型输出稳定性测试（温度未固定的证据）。
 *
 * 背景：E06 的置信度在 0.6103 ~ 0.6543 之间漂移，跨过了 R4 的 0.6 门槛，
 * 导致「同一组线索、同一患者」在不同调用间可能得到澄清 / 不澄清两种相反结果。
 *
 * 怀疑根因：provider 请求体里**没有固定 temperature**，模型每次返回的
 * 候选措辞不同 → alignTemplate 匹配到不同模板 → 场景先验不同 → 置信度漂移。
 *
 * 本脚本对**完全相同的输入**连续调用 N 次，统计：
 *   · 候选文本是否变化
 *   · 置信度极差
 *   · state 是否变化（这才是产品级后果）
 *
 * 用法：
 *   MODEL_PROVIDER=huawei node scripts/test-model-determinism.js [次数]
 */
import { createIntentEngine } from '../server/domain/engine.js';
import { loadEnv } from '../server/data/env.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

const PROVIDER = process.env.MODEL_PROVIDER || 'huawei';
const N = Number(process.argv[2] || 5);

// 选两个用例：一个骑在门槛上（E06），一个离门槛很远（E05 应直接输出）
const PROBES = [
  { id: 'E06', scenarioKey: 'toilet', clues: { icons: ['厕所', '换'], keywords: [], voiceFragments: [] }, note: '骑在 0.6 门槛上' },
  { id: 'E07', scenarioKey: 'body', clues: { icons: ['疼', '头'], keywords: [], voiceFragments: [] }, note: '远高于门槛，应稳定 ready' },
];

const line = '─'.repeat(80);
console.log(`\n${line}`);
console.log(`  模型输出稳定性测试 ｜ provider = ${PROVIDER} ｜ 每例重复 ${N} 次`);
console.log(`  输入完全相同 —— 任何差异都只能来自模型采样`);
console.log(line);

for (const probe of PROBES) {
  const texts = new Set();
  const states = new Set();
  const confs = [];

  console.log(`\n【${probe.id}】${probe.note} ｜ ${JSON.stringify(probe.clues.icons)}`);
  console.log(`${'次'.padEnd(4)} ${'state'.padEnd(11)} ${'top1'.padEnd(9)} top1 文本`);
  console.log('─'.repeat(80));

  for (let i = 1; i <= N; i++) {
    const engine = createIntentEngine({ model: { provider: PROVIDER } });
    const r = await engine.understand({
      scenarioKey: probe.scenarioKey,
      clues: probe.clues,
      patientId: 'det-test',
    });
    const top1 = (r.candidates || [])[0];
    const conf = top1 ? top1.confidence : 0;
    texts.add(top1 ? top1.text : '(无)');
    states.add(r.state);
    confs.push(conf);
    console.log(`${String(i).padEnd(4)} ${String(r.state).padEnd(11)} ${conf.toFixed(4).padEnd(9)} ${top1 ? top1.text : '(无)'}`);
  }

  const min = Math.min(...confs);
  const max = Math.max(...confs);
  console.log('─'.repeat(80));
  console.log(`  不同候选文本数 = ${texts.size} / ${N}`);
  console.log(`  不同 state 数  = ${states.size} / ${N}` + (states.size > 1 ? '  🔴 不稳定！' : '  ✓'));
  console.log(`  置信区间 = [${min.toFixed(4)}, ${max.toFixed(4)}]  极差 = ${(max - min).toFixed(4)}`);
  const crosses = min < 0.6 && max >= 0.6;
  console.log(`  是否跨越 0.6 门槛 = ${crosses ? '🔴 是 —— 同一输入会得到相反的产品行为' : '否'}`);
}

console.log(`\n${line}\n`);
