/**
 * R4 澄清裁决的**确定性依据**验证 —— v1.4 新增。
 *
 * 【要守住什么】
 * E06（toilet：图标「厕所」+ 图标「换」）是一条「应澄清」用例，
 * 但它的综合置信度恰好骑在 R4 的 0.6 门槛上 ——
 * 实测真实模型下 8 次里 6 次 ready、2 次 clarifying，
 * 即「是否澄清」由**模型自报置信度的随机波动**决定。
 *
 * 这对产品是不可接受的：患者说同样的话，早按一下就得候选、
 * 晚按一下就被反问一句。这不是阈值问题，是**结论缺乏确定性依据**。
 *
 * 修法：新增 detectClueConflict() —— 纯从句索与候选的对应关系判断：
 * 「是否存在两条线索，其归属候选集合完全不相交？」
 * 若存在，患者给的两条线索指向了系统内部两个互不相干的意图，
 * 谁也不能替对方作证 → 客观歧义，必须澄清。
 *
 * 这个判据**不依赖任何模型输出**，因此恒定、可复现、可解释。
 *
 * 本测试守住三件事：
 *   [A] 真冲突必须被检出（E06 / E20 型）
 *   [B] 互证线索不得被误判为冲突（E05 / E01 型）—— 这是最关键的防误伤
 *   [C] 冲突判据必须与模型无关（同一输入重复调用结论恒定）
 *
 * 运行：node eval/verify-conflict.js
 */
import { detectClueConflict } from '../server/domain/scoring.js';
import { createIntentEngine } from '../server/domain/engine.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${desc}`); }
  else { fail += 1; failures.push(desc); console.log(`  ✗ ${desc}  ${detail}`); }
}
function group(title) {
  console.log(`\n${'─'.repeat(66)}\n${title}\n${'─'.repeat(66)}`);
}

const mk = (text, matchedClues, idx) => ({ text, matchedClues, confidence: 0.5, rank: idx + 1 });

// ══════════════════════════════════════════════════════════════
group('[A] 真冲突必须被检出 —— 两条线索归属集合完全不相交');

{
  // E06 型：厕所 → 候选0；换 → 候选1、2。
  // 「厕所」的归属 {0} 与「换」的归属 {1,2} 交集为空 → 冲突
  const ranked = [
    mk('我要上厕所，很急', ['厕所'], 0),
    mk('帮我换一下尿不湿', ['换'], 1),
    mk('弄脏了，要换一下', ['换'], 2),
  ];
  const r = detectClueConflict(ranked, { icons: ['厕所', '换'] });
  check('E06 型（厕所 vs 换）判为冲突', r.conflicted === true, r.detail);
  check('冲突结论可解释（detail 非空且含线索名）',
    typeof r.detail === 'string' && r.detail.length > 0, r.detail);
}

{
  // E20 型：电视 → 候选0；睡觉 → 候选1
  const ranked = [
    mk('我想看电视', ['电视'], 0),
    mk('我困了，想睡觉', ['睡觉'], 1),
  ];
  const r = detectClueConflict(ranked, { icons: ['电视', '睡觉'] });
  check('E20 型（电视 vs 睡觉）判为冲突', r.conflicted === true, r.detail);
}

// ══════════════════════════════════════════════════════════════
group('[B] 互证线索**不得**被判为冲突 —— 最关键的防误伤');

{
  // E05 型：厕所 + 急，被同一候选「我要上厕所，很急」同时解释
  const ranked = [
    mk('我要上厕所，很急', ['厕所', '急'], 0),
    mk('帮我换一下尿不湿', ['换'], 1),
  ];
  const r = detectClueConflict(ranked, { icons: ['厕所'], keywords: ['急'] });
  check('E05 型（厕所+急 由同一候选统一解释）不判冲突', r.conflicted === false, r.detail);
}

{
  // E01 型：饭 + 水 + 饿，被同一候选同时解释
  const ranked = [
    mk('我饿了，想吃饭，再喝点水', ['饭', '水', '饿'], 0),
    mk('我想喝水', ['水'], 1),
  ];
  const r = detectClueConflict(ranked, { icons: ['饭', '水'], keywords: ['饿'] });
  check('E01 型（饭+水+饿 由同一候选统一解释）不判冲突', r.conflicted === false, r.detail);
}

{
  // 仅 1 条线索 —— 不存在「两条线索互不能证」的问题
  const ranked = [
    mk('我想喝水', ['水'], 0),
    mk('我渴了', ['水'], 1),
  ];
  const r = detectClueConflict(ranked, { icons: ['水'] });
  check('单一线索不判冲突（无从谈互证）', r.conflicted === false, r.detail);
}

{
  // 线索无人解释 → 交给覆盖率处理，不算冲突
  const ranked = [
    mk('A', ['甲'], 0),
    mk('B', ['乙'], 1),
  ];
  const r = detectClueConflict(ranked, { icons: ['丙', '丁'] });
  check('线索无候选解释时不判冲突（避免与覆盖率职责重叠）', r.conflicted === false, r.detail);
}

// ══════════════════════════════════════════════════════════════
group('[C] 冲突判据必须与模型无关 —— 同一输入结论恒定');

{
  // 同一组线索 + 同一组候选，重复 20 次必须结论完全一致
  const ranked = [
    mk('我要上厕所，很急', ['厕所'], 0),
    mk('帮我换一下尿不湿', ['换'], 1),
  ];
  const clues = { icons: ['厕所', '换'] };
  const results = new Set();
  for (let i = 0; i < 20; i++) results.add(detectClueConflict(ranked, clues).conflicted);
  check('同一输入 20 次调用结论恒定（无随机性）', results.size === 1,
    `出现 ${results.size} 种结论：${[...results].join(', ')}`);
  check('该输入 20 次均为「冲突」', results.size === 1 && [...results][0] === true);
}

{
  // 顺序无关：候选次序颠倒不该改变「是否冲突」的结论
  const a = [mk('我要上厕所，很急', ['厕所'], 0), mk('帮我换一下尿不湿', ['换'], 1)];
  const b = [mk('帮我换一下尿不湿', ['换'], 0), mk('我要上厕所，很急', ['厕所'], 1)];
  const clues = { icons: ['厕所', '换'] };
  check('候选顺序颠倒不改变冲突结论',
    detectClueConflict(a, clues).conflicted === detectClueConflict(b, clues).conflicted);
}

// ══════════════════════════════════════════════════════════════
group('[D] 引擎级：冲突时必须澄清，且理由可读');

{
  const engine = createIntentEngine({ model: { provider: 'rule' } });
  const r = await engine.understand({
    scenarioKey: 'toilet',
    clues: { icons: ['厕所', '换'], keywords: [], voiceFragments: [] },
    patientId: 'verify-conflict',
  });
  check('E06 冲突用例在引擎级进入澄清态', r.state === 'clarifying', `实际 ${r.state}`);
  check('trace 暴露冲突结论（可复核）', Boolean(r.trace?.clueConflict));
  check('冲突结论为 true', r.trace?.clueConflict?.conflicted === true,
    JSON.stringify(r.trace?.clueConflict));
  check('澄清理由引用了冲突线索（患者端可读）',
    String(r.decisionReason || '').includes('线索'),
    r.decisionReason);
}

console.log(`\n${'═'.repeat(66)}`);
console.log(`  冲突检测：通过 ${pass} ／ 失败 ${fail}`);
if (fail === 0) console.log('  ✓ R4 澄清具备确定性依据（不再依赖模型噪声）');
else console.log(`  ✗ 失败项：${failures.join('；')}`);
console.log(`${'═'.repeat(66)}\n`);

process.exit(fail === 0 ? 0 : 1);
