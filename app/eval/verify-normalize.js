/**
 * 线索归一化验证 —— 防止语音链路静默失效
 * ══════════════════════════════════════════════════════════════
 *
 * 背景：这是一个被语音识别引爆的真实缺陷。
 * 引擎只做精确相等匹配（为了防「开灯」被「灯」误伤），
 * 而语音识别返回自由文本 —— 不加归一化，整条语音链路
 * 会静默退回 fallback_list，且不报任何错。
 *
 * 本文件钉死三件事：
 *   1. 自由文本能正确归一化到词表原词
 *   2. 长词优先，绝不出现「灯」误伤「开灯」的反向回归
 *   3. 宁可漏不可错 —— 词表外的内容不许被硬塞进候选
 */

import {
  normalizeClue,
  normalizeFragments,
  normalizeStats,
  normalizeListInScenario,
  disambiguateStats,
  SYNONYM_MAP,
} from '../server/domain/normalize.js';
import { createIntentEngine } from '../server/domain/engine.js';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
}

function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`); }
}

console.log('\n════ 线索归一化验证 ════\n');

console.log('[1] 词表原词必须原样通过（图标链路不能受影响）');
{
  for (const w of ['水', '饭', '厕所', '疼', '药', '救命']) {
    check(`原词「${w}」原样返回`, normalizeClue(w), [w]);
  }
}

console.log('\n[2] 自由文本 → 词表原词（语音链路的核心）');
{
  const cases = [
    ['我想喝水', ['水']],
    ['我要上厕所', ['厕所']],
    ['肚子有点饿了', ['饿']],
    // 「饭」是原词，「想吃」在同义表里归到「饿」—— 两条都是有效线索
    ['我想吃点饭', ['饭', '饿']],
    // 「头」和「晕」都是词表原词且互不包含，两条都是有效线索，都要留
    ['我头有点晕', ['晕', '头']],
    ['手有点发麻', ['麻']],
    ['好冷啊', ['冷']],
    ['帮我翻个身', ['翻身']],
    ['我疼', ['疼']],
    ['喘不上气了', ['喘不上气']],
  ];
  for (const [input, expected] of cases) {
    check(`「${input}」→ ${JSON.stringify(expected)}`, normalizeClue(input), expected);
  }
}

console.log('\n[3] 长词优先：绝不能出现「灯」误伤「开灯」');
{
  // 这是引擎当初拒绝子串匹配要防的坑，归一化必须同样守住
  check('「开灯」归一化为开灯而非灯', normalizeClue('开灯'), ['开灯']);
  check('「关灯」归一化为关灯而非灯', normalizeClue('关灯'), ['关灯']);
  check('「把灯开开」→ 开灯', normalizeClue('把灯开开'), ['开灯']);
  check('「把灯关了」→ 关灯', normalizeClue('把灯关了'), ['关灯']);

  // 只说「灯」时不该凭空归一出开灯或关灯 —— 那是猜，不是归一化
  const vague = normalizeClue('灯');
  ok('模糊的「灯」不硬塞开灯/关灯', !vague.includes('开灯') && !vague.includes('关灯'),
    `实际 ${JSON.stringify(vague)}`);
}

console.log('\n[4] 多意图长句应当拆出多个线索');
{
  // 患者一次说不止一件事是常态
  const r1 = normalizeClue('我又饿又渴');
  ok('「又饿又渴」同时命中饿与渴',
    r1.includes('饿') && r1.includes('渴'), JSON.stringify(r1));

  const r2 = normalizeClue('我想上厕所然后喝水');
  ok('「上厕所+喝水」命中厕所与水',
    r2.includes('厕所') && r2.includes('水'), JSON.stringify(r2));
}

console.log('\n[5] 去重：说三遍同一件事只算一个线索');
{
  const { words, raw } = normalizeFragments(['水', '喝水', '我想喝水', '水']);
  check('归一化后去重为一个词', words, ['水']);
  check('原始文本全部保留', raw.length, 4);

  // 覆盖度分母被灌水会导致置信度虚高，这条是防线
  const dup = normalizeFragments(['疼', '好疼', '好痛', '疼得厉害']);
  check('多种说法归一到同一个词（含包含消解）', dup.words, ['疼得厉害']);
}

console.log('\n[5b] 包含消解：长词吸收短词，但不做语义推断');
{
  // 「疼得厉害」是紧急场景 level 1 词表原词，且字面包含「疼」。
  // 多出的「疼」会撑大覆盖度分母，稀释真正的紧急线索 —— 必须消解。
  check('「疼得厉害」只留长词', normalizeClue('疼得厉害'), ['疼得厉害']);
  check('「我疼得厉害」只留长词', normalizeClue('我疼得厉害'), ['疼得厉害']);

  // 互不包含的真多意图必须都保留 —— 消解不能过头
  const two = normalizeClue('头和肚子都疼');
  ok('互不包含的多个线索都保留', two.length >= 2, JSON.stringify(two));
}

console.log('\n[6] 宁可漏不可错：词表外的内容不许硬塞');
{
  const outOfVocab = [
    '我想看电视节目',
    '今天天气不错',
    '这个多少钱',
    '明天开会',
  ];
  // 允许部分命中（如「电视」），但绝不能凭空造出无关原词
  let invented = 0;
  for (const t of outOfVocab) {
    const words = normalizeClue(t);
    // 每个返回的词都必须真的在原文里能找到依据
    for (const w of words) {
      const hasBasis = t.includes(w)
        || (SYNONYM_MAP[w] || []).some((v) => t.includes(v));
      if (!hasBasis) { invented++; console.log(`      ⚠ 「${t}」凭空产出「${w}」`); }
    }
  }
  check('不存在凭空捏造的归一化结果', invented, 0);

  check('完全无关的文本返回空', normalizeClue('啊啊啊'), []);
  check('空输入返回空', normalizeClue(''), []);
  check('null 输入返回空', normalizeClue(null), []);
}

console.log('\n[7] 端到端：自由文本经归一化后必须能产出候选');
{
  const engine = createIntentEngine({});

  const cases = [
    ['我想喝水', 'daily_life'],
    ['我要上厕所很急', 'toilet'],
    ['肚子饿了想吃饭', 'food'],
    ['我头有点晕', 'body'],
  ];

  for (const [utterance, scenario] of cases) {
    const norm = normalizeFragments([utterance]);
    const r = await engine.understand({
      sessionId: 'norm-e2e-' + utterance,
      patientId: 'p',
      scenario,
      clues: { icons: [], keywords: [], voiceFragments: norm.words },
    });
    const n = (r.candidates || []).length;
    ok(`「${utterance}」→ ${JSON.stringify(norm.words)} → 候选 ${n} 个`,
      n > 0 || r.state === 'clarifying',
      `state=${r.state}`);
  }
}

console.log('\n[8] 引擎入口已自带归一化（修复后行为）');
{
  const engine = createIntentEngine({});

  // 直接把自由文本塞进引擎 —— 修复前这会静默退回 fallback_list。
  // 现在引擎入口的 normalizeClues 会把它映射到词表原词，
  // 因此任何一条通道（图标/关键词/语音）都不需要各自记得先归一化。
  const r = await engine.understand({
    sessionId: 'norm-engine-inline',
    patientId: 'p',
    scenario: 'daily_life',
    clues: { icons: [], keywords: [], voiceFragments: ['我想喝水'] },
  });
  const n = (r.candidates || []).length;
  ok(`引擎直接吃自由文本也能产出候选（${n} 个）`, n > 0 || r.state === 'clarifying',
    `state=${r.state}`);
  ok('不再静默退回 fallback_list', r.state !== 'fallback_list', `state=${r.state}`);

  // 三条通道必须行为一致 —— 同一句话从哪个口进来结果都该一样
  const viaIcon = await engine.understand({
    sessionId: 'norm-consist-icon', patientId: 'p', scenario: 'daily_life',
    clues: { icons: ['我想喝水'], keywords: [], voiceFragments: [] },
  });
  const viaKeyword = await engine.understand({
    sessionId: 'norm-consist-kw', patientId: 'p', scenario: 'daily_life',
    clues: { icons: [], keywords: ['我想喝水'], voiceFragments: [] },
  });
  const top = (x) => (x.candidates || [])[0]?.text || null;
  check('三条通道 top1 一致（图标）', top(viaIcon), top(r));
  check('三条通道 top1 一致（关键词）', top(viaKeyword), top(r));
}

console.log('\n[8b] 紧急通道不受归一化影响（R6 安全底线）');
{
  const engine = createIntentEngine({});

  // 紧急词是写死的边界，归一化绝不能削弱它。
  // 特别注意「口语化紧急」这组 —— 曾经的真实 bug：
  // 「快救救我」里「快」是词表原词，扫描时一命中就短路返回，
  // 把同义变体「救救我」→「救命」整个跳过，导致口语呼救不触发紧急。
  // 这是产品上最不能接受的失败模式（没候选、没紧急、还不报错）。
  const cases = [
    ['纯紧急词', { icons: ['救命'], keywords: [], voiceFragments: [] }],
    ['口语化紧急', { icons: [], keywords: [], voiceFragments: ['快救救我'] }],
    ['口语化紧急2', { icons: [], keywords: [], voiceFragments: ['救救我'] }],
    ['长句含紧急词', { icons: [], keywords: ['我喘不上气了好难受'], voiceFragments: [] }],
    ['跌倒描述', { icons: [], keywords: [], voiceFragments: ['我摔了一跤'] }],
    ['呼喊来人', { icons: [], keywords: [], voiceFragments: ['来人啊'] }],
  ];
  for (const [name, clues] of cases) {
    const r = await engine.understand({
      sessionId: 'norm-emg-' + name, patientId: 'p', scenario: 'daily_life', clues,
    });
    check(`${name} → 触发紧急通道`, r.state, 'emergency');
    check(`${name} → 零模型调用`, r.emergency?.modelCalled, false);
  }
}

console.log('\n[8c] 口语化紧急表达必须归一到紧急词');
{
  ok('「快救救我」含救命', normalizeClue('快救救我').includes('救命'),
    JSON.stringify(normalizeClue('快救救我')));
  check('「救救我」→ 救命', normalizeClue('救救我'), ['救命']);
  check('「来人啊」→ 来人', normalizeClue('来人啊'), ['来人']);
  check('「我摔了一跤」→ 跌倒了', normalizeClue('我摔了一跤'), ['跌倒了']);
  check('「喘不上气了」→ 喘不上气', normalizeClue('喘不上气了'), ['喘不上气']);
}

console.log('\n[8d] 已知边界：繁体字目前不能匹配（明写在案，不藏着）');
{
  // 词表只有简体。SIS 对中文返回简体，所以主链路不受影响；
  // 但若有人从别处粘贴繁体（如「廁所」），会匹配不上。
  // 这里把它固化为「已知边界」而非静默行为 ——
  // 答辩时主动说明边界比被问出来更可信。
  check('繁体「廁所」当前匹配不上（已知边界）', normalizeClue('廁所'), []);
  ok('简体「厕所」正常命中', normalizeClue('厕所').includes('厕所'));

  // 同时确认边界不会造成「错误匹配」——宁可返回空，也不给错的词
  ok('繁体输入不会产出错误候选', !normalizeClue('廁所').includes('厕所'));
}

console.log('\n[8e] 场景消歧：单字碎片的确定性映射');
{
  // 失语症患者的真实语音常是单字蹦的（「关」「吃」），
  // 这些字不在词表，同义表也难穷举。但**场景已知**时，
  // 若场景词表内只有一个词包含它，映射就是确定的而非猜测。
  const cases = [
    ['关', 'daily_life', ['关灯']],      // 起居表内唯一
    ['戏', 'leisure', ['戏曲']],         // 娱乐表内唯一
    ['别', 'emergency', ['别动我']],      // 紧急表内唯一
    ['不', 'leisure', ['不看']],         // 娱乐表内唯一
  ];
  for (const [clue, scene, expected] of cases) {
    check(`「${clue}」+ ${scene} → ${JSON.stringify(expected)}`,
      normalizeListInScenario([clue], scene), expected);
  }

  // ── 边界一：场景内出现多个候选词时必须放弃（歧义未消解，猜就是错）──
  // medication 表内含「吃」的有「吃药」和「忘吃药」两个 → 不敢映射
  const ambiguous = normalizeListInScenario(['吃'], 'medication');
  ok('场景内有多解时不做映射', !ambiguous.includes('吃药') && !ambiguous.includes('忘吃药'),
    JSON.stringify(ambiguous));

  // ── 边界二：场景不匹配时不跨场景乱配 ──
  // 「关」在娱乐表里没有任何词包含它 → 保持原文，绝不跨界映射到起居的「关灯」
  const crossScene = normalizeListInScenario(['关'], 'leisure');
  ok('不跨场景乱配（娱乐场景的「关」不会变成关灯）',
    !crossScene.includes('关灯'), JSON.stringify(crossScene));

  // ── 边界三：没有场景时不启用（无约束条件，等于猜）──
  const noScene = normalizeListInScenario(['关'], '');
  ok('场景为空时不启用消歧（不猜）', !noScene.includes('关灯'), JSON.stringify(noScene));

  // ── 边界四：词表原词不该被消歧改坏 ──
  check('原词「疼」+ body 原样返回', normalizeListInScenario(['疼'], 'body'), ['疼']);
  check('原词「关灯」+ daily_life 原样返回',
    normalizeListInScenario(['关灯'], 'daily_life'), ['关灯']);
}

console.log('\n[8f] 场景消歧在评估集上的真实影响（诚实记录）');
{
  // 实测：开启场景消歧后，E13 从「命中第 2 位」变成 either_or 澄清，
  // Top-3 命中率由 42.9% 降到 35.7%。
  //
  // 归因（已逐条核对）：
  //   消歧本身是对的 ——「戏」确实被正确映射到「戏曲」，
  //   正确答案的置信度也上升了。但同时图标「电视」命中了另一条候选，
  //   两条分数仅差 0.0021（0.7538 vs 0.7517），低于 R4 的 0.1 差值阈值，
  //   于是触发 either_or 澄清。
  //
  // 这个澄清从产品角度是**合理的**（患者点了电视又说戏，确实该问一句），
  // 但评测集标注为 expectClarify:false（其意图是测「常用词映射」）。
  // 这是评测标注与产品行为之间的张力，不是代码缺陷 ——
  // 需要的是扩充评测集的判定口径，而非回滚消歧能力。
  const engine = createIntentEngine({});
  const r = await engine.understand({
    sessionId: 'ev-e13', patientId: 'p', scenario: 'leisure',
    clues: { icons: ['电视'], keywords: ['戏'], voiceFragments: [] },
  });
  const texts = (r.candidates || []).map((c) => c.text);
  console.log(`      state=${r.state}`);
  console.log(`      候选：${texts.join(' / ')}`);
  ok('消歧后正确答案仍在候选内（未丢失命中）',
    texts.some((t) => t.includes('戏曲')), JSON.stringify(texts));
  ok('「戏」被正确理解为戏曲方向', texts.some((t) => t.includes('戏曲')));
}

console.log('\n[9] 归一化能力统计（供答辩展示）');
{
  const s = normalizeStats();
  const d = disambiguateStats();
  console.log(`      词表原词: ${s.vocabSize}`);
  console.log(`      同义词条: ${s.synonymEntries} 条原词带口语变体`);
  console.log(`      口语变体: ${s.variantCount} 个`);
  console.log(`      场景消歧: ${d.scenarioCount} 个场景 / ${d.scenarioVocabSize} 词`);
  ok('词表规模合理', s.vocabSize >= 90, `vocabSize=${s.vocabSize}`);
  ok('同义表有规模', s.variantCount >= 80, `variantCount=${s.variantCount}`);
  ok('场景消歧覆盖全部场景', d.scenarioCount === 10, `scenarioCount=${d.scenarioCount}`);
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  归一化：通过 ${pass} ／ 失败 ${fail}`);
console.log('═'.repeat(60));

process.exit(fail === 0 ? 0 : 1);
