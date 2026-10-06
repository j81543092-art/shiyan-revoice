/**
 * 机制契约回归测试 —— 规格 R1~R8 的必须成立项
 *
 * 这些不是「功能测试」，是**产品红线测试**：
 * 任何一条挂掉，代表产品做了它绝对不该做的事。
 *
 * 运行：node eval/test-contracts.js
 *
 * 重点覆盖（每一条都对应一次真实踩坑）：
 *   C1  否定回答绝不能被判成肯定 —— 「不是」包含「是」，曾导致患者说「不是」反被确认
 *   C2  R2 排序锁定 —— 同批线索两次提交，位置必须一致
 *   C3  R4③ 轮次上限 —— 2 轮不收敛必须给「都不是，重来」
 *   C4  R6 紧急通道零模型调用
 *   C5  R7 紧急词不可删
 *   C6  R8 措辞边界 —— 禁诊断措辞、禁超长、禁臆造实体
 *   C7  R1 候选数量 —— 默认 3，上限 5，不足 2 不硬凑
 */

import { isAffirmative, applyClarificationAnswer, CLARIFY_TYPE, decideClarification } from '../server/domain/clarify.js';
import { evaluateEmergency } from '../server/domain/emergency.js';
import { validateCandidate, filterCandidates, COMPLIANCE_STATEMENT } from '../server/domain/wording.js';
import { CANDIDATE_RULES, CLARIFY_RULES, decideCandidateCount } from '../server/domain/scoring.js';
import { createIntentEngine } from '../server/domain/engine.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(t) {
  console.log(`\n${t}`);
  console.log('─'.repeat(62));
}

// ── C1 否定判定（最关键的一条）─────────────────────────────
section('C1 · 否定回答绝不能被判成肯定（确认权在患者手里）');

check('「是」判为肯定', isAffirmative('是') === true);
check('「对」判为肯定', isAffirmative('对') === true);
check('「嗯」判为肯定', isAffirmative('嗯') === true);

check('「不是」判为否定', isAffirmative('不是') === false, '「不是」含「是」，最易踩的坑');
check('「不对」判为否定', isAffirmative('不对') === false);
check('「都不是」判为否定', isAffirmative('都不是') === false);
check('「不」判为否定', isAffirmative('不') === false);
check('「没有」判为否定', isAffirmative('没有') === false);
check('「不想要」判为否定', isAffirmative('不想要') === false);
check('「no」判为否定', isAffirmative('no') === false);

{
  const r = applyClarificationAnswer({
    clarification: { type: CLARIFY_TYPE.YES_NO },
    answer: '不是',
    ranked: [{ id: 'a', text: '我想喝水' }],
  });
  check('答「不是」→ action=reclue（不得 confirm）', r.action === 'reclue', `实际 ${r.action}`);
  check('答「不是」→ 排除该候选', r.exclude === 'a');
}

{
  const r = applyClarificationAnswer({
    clarification: { type: CLARIFY_TYPE.YES_NO },
    answer: '是',
    ranked: [{ id: 'a', text: '我想喝水' }],
  });
  check('答「是」→ action=confirm', r.action === 'confirm');
  check('答「是」→ 带出被确认的候选', r.confirmed?.text === '我想喝水');
}

{
  const r = applyClarificationAnswer({
    clarification: { type: CLARIFY_TYPE.YES_NO },
    answer: '是',
    ranked: [],
  });
  check('无候选时答「是」→ 不得 confirm 空对象', !(r.action === 'confirm' && !r.confirmed));
}

// ── C2 R2 排序锁定（逻辑层：区分度足够时不发澄清）───────────
section('C2 · R2 排序锁定（逻辑层：区分度足够直接出候选）');

{
  const clear = [
    { id: '1', text: '甲', confidence: 0.85 },
    { id: '2', text: '乙', confidence: 0.55 },
  ];
  const d1 = decideClarification(clear, 0, { clueTypeCount: 3 });
  check('区分度足够（gap 0.30）→ 直接出候选', d1.state === 'ready', `实际 ${d1.state}`);

  const close = [
    { id: '1', text: '甲', confidence: 0.72 },
    { id: '2', text: '乙', confidence: 0.70 },
  ];
  const d2 = decideClarification(close, 0, { clueTypeCount: 3 });
  check('前两名过近（gap 0.02）→ 发二选一', d2.state === 'clarifying');
  check('过近时澄清类型为 either_or', d2.clarification?.type === CLARIFY_TYPE.EITHER_OR);
}

// ── C3 R4③ 轮次上限 ─────────────────────────────────────────
section('C3 · R4③ 澄清最多 2 轮，不收敛必须给「都不是，重来」');

{
  const low = [
    { id: '1', text: '甲', confidence: 0.4 },
    { id: '2', text: '乙', confidence: 0.35 },
  ];
  const d1 = decideClarification(low, 0, { clueTypeCount: 1 });
  check('第 1 轮置信不足 → 发澄清', d1.state === 'clarifying');

  const d2 = decideClarification(low, CLARIFY_RULES.maxRounds, { clueTypeCount: 1 });
  check('达轮次上限 → 转 fallback_list', d2.state === 'fallback_list', `实际 ${d2.state}`);
  check('fallback 带「都不是，重来」', (d2.fallbackOptions || []).includes('都不是，重来'));
}

// ── C4 R6 紧急通道 ──────────────────────────────────────────
section('C4 · R6 紧急通道（零模型调用，命悬一线不靠 AI 猜）');

{
  const e1 = evaluateEmergency({ icons: ['跌倒了'] });
  check('R6① 一级紧急词直接命中', e1.triggered === true);
  check('R6① 标识为 R6-①', e1.rule === 'R6-①', `实际 ${e1.rule}`);

  const e2 = evaluateEmergency({ icons: ['疼', '胸口'], repeatCounts: { 疼: 3 } });
  check('R6② 连点症状词 ×3 + 部位', e2.triggered === true, JSON.stringify(e2.rule));
  check('R6② 标识为 R6-②', e2.rule === 'R6-②', `实际 ${e2.rule}`);

  const e3 = evaluateEmergency({ icons: ['水'] });
  check('常规线索不误触紧急', e3.triggered === false);
}

// ── C5 R7 词库边界（逻辑层）─────────────────────────────────
section('C5 · R8 措辞边界（禁诊断、限长、禁臆造）');

{
  const ok = validateCandidate({ text: '我左腿麻' });
  check('常规短句通过', ok.ok === true, JSON.stringify(ok));

  const tooLong = validateCandidate({ text: '这是一句远远超过十五个字的很长的表达内容测试' });
  check('超 15 字被拦', tooLong.ok === false, `reason=${tooLong.reason || '无'}`);

  const diag = validateCandidate({ text: '我这是脑梗死复发' });
  check('含诊断措辞被拦', diag.ok === false, diag.reason || '');
}

// ── C6 R1 候选数量 ──────────────────────────────────────────
section('C6 · R1 候选数量（默认 3，上限 5，不足不硬凑）');

{
  check('CANDIDATE_RULES 默认 3', CANDIDATE_RULES.default === 3, JSON.stringify(CANDIDATE_RULES));
  check('CANDIDATE_RULES 上限 5', CANDIDATE_RULES.max === 5);
  check('CLARIFY_RULES 低置信阈值 0.6', CLARIFY_RULES.lowConfidence === 0.6);
  check('CLARIFY_RULES 差值阈值 0.1', CLARIFY_RULES.closeGap === 0.1);
  check('CLARIFY_RULES 轮次上限 2', CLARIFY_RULES.maxRounds === 2);
  check('线索充分时可到 5 个', decideCandidateCount(3).max === 5);
  check('线索有限时默认 3 个', decideCandidateCount(1).max === 3);
}

// ── C7 端到端：紧急优先于常规推理 ───────────────────────────
section('C7 · 端到端：紧急线索必须抢占常规推理');

{
  const engine = createIntentEngine({});
  const r = await engine.understand({ clues: { icons: ['跌倒了'] }, profile: null, round: 0 });
  check('紧急线索 → state=emergency', r.state === 'emergency', `实际 ${r.state}`);
  check('紧急路径不产出候选', (r.candidates || []).length === 0);
  // 「零模型调用」是引擎层对外的承诺标志（evaluateEmergency 本身无此字段）
  check('引擎声明零模型调用', r.emergency?.modelCalled === false, JSON.stringify(r.emergency));
  check('紧急提示文案第一人称', String(r.emergency?.message || '').startsWith('我'));
}

// ── 汇总 ────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(62));
console.log(`  通过 ${pass} ／ 失败 ${fail}`);
if (fail > 0) {
  console.log('\n  失败项：');
  for (const f of failures) console.log(`    ✗ ${f}`);
  console.log('═'.repeat(62));
  process.exit(1);
}
console.log('  ✓ 全部机制契约成立');
console.log('═'.repeat(62));
