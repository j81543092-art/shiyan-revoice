/**
 * 评测跑分器 —— 交付物三 + 交付物四的数字出口
 *
 * 两个数字：
 *   Top-3 命中率（主）—— 标准答案出现在前三候选的比例
 *   平均澄清轮次（辅）—— 每次表达平均需要的澄清轮数，目标 ≤1 轮收敛
 *
 * 判中口径：任一候选与标准答案或任一等价说法语义一致 → 记一次命中。
 * 应澄清样例的正确行为是追问而不是出候选 —— 出候选即失败。
 *
 * 运行：node eval/run-eval.js [--write] [--verbose]
 */

import { EVAL_SET_V1, FAILURE_TAXONOMY, EVAL_STATS_V1 } from './eval-set-v1.js';
import { loadEnv } from '../server/data/env.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIntentEngine } from '../server/domain/engine.js';
import { CLARIFY_STATE } from '../server/domain/clarify.js';
import { similarity } from '../server/domain/scoring.js';
import { openDatabase, createPromptVersionRepository } from '../server/data/db.js';
import { PROMPT_V1 } from '../server/model/prompt.js';

// ⚠️ 必须在 createIntentEngine() 之前执行。
// ESM 的 import 会被提升到模块顶部，所以不能靠「写在 import 之后」来保证时机 ——
// 必须显式放在真正使用之前（见 main() 开头）。
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

// 语义一致的近似阈值。
//
// 【v1.3 重标定】旧值 0.42 是配合旧的字符 bigram Jaccard 定的，而那个算法
// 对中文近义句判别力趋近于零（同义 0.00~0.40 与异义 0.00~0.25 完全重叠）。
// 换成概念优先的新算法后，尺度整体改变，此阈值必须重标定。
// 新值由 scripts/calibrate-thresholds.js 在 42 对人工标注样本上扫描得出：
// 阈值 0.35 时误判最少（7 对），同义漏判 4 / 异义误判 3。
const MATCH_THRESHOLD = 0.35;

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const VERBOSE = args.includes('--verbose');
const PROVIDER = process.env.MODEL_PROVIDER || 'rule';

// ── 判中：候选 vs 标准答案 / 等价说法 ────────────────────────
function isHit(candidateText, item) {
  const targets = [item.answer, ...(item.equivalents || [])].filter(Boolean);
  return targets.some((t) => similarity(candidateText, t) >= MATCH_THRESHOLD);
}

// ── 跑单条 ───────────────────────────────────────────────────
async function runCase(engine, item) {
  const result = await engine.understand({
    clues: item.clues,
    scenario: item.scenarioKey,
    profile: item.profile || null,
    round: 0,
  });

  const outcome = {
    id: item.id,
    scenario: item.scenarioName,
    focus: item.focus,
    state: result.state,
    passed: false,
    hitRank: null,
    clarifyRounds: 0,
    failureType: null,
    detail: '',
  };

  // ① 紧急样例：必须走规则通道，且零模型调用
  if (item.expectEmergency) {
    outcome.passed = result.state === CLARIFY_STATE.EMERGENCY
      && result.emergency?.triggered === true
      && result.emergency?.modelCalled === false;
    if (!outcome.passed) {
      outcome.failureType = FAILURE_TAXONOMY.COMMON_SENSE;
      outcome.detail = `期望走紧急规则通道，实际 state=${result.state}`;
    }
    return outcome;
  }

  // ② 应澄清样例：必须触发澄清；出候选即失败
  if (item.expectClarify) {
    const isClarifying = result.state === CLARIFY_STATE.CLARIFYING
      || result.state === CLARIFY_STATE.FALLBACK_LIST;
    const typeOk = !item.expectClarifyType
      || result.clarification?.type === item.expectClarifyType
      || result.state === CLARIFY_STATE.FALLBACK_LIST;
    outcome.passed = isClarifying && typeOk;
    outcome.clarifyRounds = 1;
    if (!outcome.passed) {
      outcome.failureType = isClarifying
        ? FAILURE_TAXONOMY.COMMON_SENSE
        : FAILURE_TAXONOMY.MISSED_CLARIFY;
      outcome.detail = isClarifying
        ? `澄清类型不符：期望 ${item.expectClarifyType}，实际 ${result.clarification?.type}`
        : `应澄清却直接出了候选（state=${result.state}）`;
    }
    return outcome;
  }

  // ③ 常规样例：标准答案要落进前三
  if (result.state === CLARIFY_STATE.CLARIFYING) {
    // 本来该直接给候选的场景却去澄清了 —— 记澄清轮次，但不算命中
    outcome.clarifyRounds = 1;
    outcome.failureType = FAILURE_TAXONOMY.MISSED_CLARIFY;
    outcome.detail = `不必要地澄清了：${result.clarification?.question || ''}`;
    return outcome;
  }

  const cands = result.candidates || [];
  const idx = cands.findIndex((c) => isHit(c.text, item));
  if (idx >= 0 && idx < 3) {
    outcome.passed = true;
    outcome.hitRank = idx + 1;
  } else {
    outcome.failureType = idx >= 0
      ? FAILURE_TAXONOMY.NO_DISTINCTION
      : FAILURE_TAXONOMY.CLUE_LOST;
    outcome.detail = idx >= 0
      ? `命中但掉到第 ${idx + 1} 位（超出 Top-3）`
      : `前三候选未覆盖标准答案。实际：${cands.slice(0, 3).map((c) => c.text).join(' / ') || '（无候选）'}`;
  }
  return outcome;
}

// ── 主流程 ───────────────────────────────────────────────────
async function main() {
  // 凭证必须在 engine 构造前就位，否则 provider 静默降级为规则引擎
  const envResult = loadEnv(ENV_PATH);

  const engine = createIntentEngine({ model: { provider: PROVIDER } });

  const line = '═'.repeat(74);
  console.log(`\n${line}`);
  console.log('  拾言 ReVoice · 评测集 v1 跑分');
  console.log(`  provider = ${engine.provider.id} ｜ 样例数 = ${EVAL_STATS_V1.total} ｜ prompt ${PROMPT_V1.version}`);
  console.log(`  凭证可用 = ${engine.provider.available()} ｜ .env ${envResult.loaded ? `载入 ${envResult.count} 项` : '未找到'}`);
  if (PROVIDER === 'huawei' && !engine.provider.available()) {
    console.log('  ⚠️ 指定了 huawei 但凭证不可用 —— 本次结果实际来自规则引擎兜底，数字无参考价值');
  }
  console.log(line);

  const outcomes = [];
  for (const item of EVAL_SET_V1) {
    outcomes.push(await runCase(engine, item));
  }

  // ── 两个主指标 ──
  const regular = outcomes.filter((o, i) => !EVAL_SET_V1[i].expectEmergency && !EVAL_SET_V1[i].expectClarify);
  const clarifyCases = outcomes.filter((o, i) => EVAL_SET_V1[i].expectClarify);
  const emergencyCases = outcomes.filter((o, i) => EVAL_SET_V1[i].expectEmergency);

  const top3Hit = regular.length ? regular.filter((o) => o.passed).length / regular.length : 0;
  const totalRounds = outcomes.reduce((s, o) => s + o.clarifyRounds, 0);
  const avgRounds = outcomes.length ? totalRounds / outcomes.length : 0;

  const clarifyCorrect = clarifyCases.length ? clarifyCases.filter((o) => o.passed).length / clarifyCases.length : 0;
  const emergencyCorrect = emergencyCases.length ? emergencyCases.filter((o) => o.passed).length / emergencyCases.length : 0;

  // ── 明细 ──
  console.log('\n【逐条结果】');
  console.log('  ID    场景   期望        实际        结果   说明');
  console.log('  ' + '─'.repeat(70));
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    const item = EVAL_SET_V1[i];
    const expect = item.expectEmergency ? '紧急通道' : item.expectClarify ? '应澄清' : '出候选';
    const mark = o.passed ? '✓ 通过' : '✗ 失败';
    console.log(
      `  ${o.id}  ${pad(o.scenario, 5)} ${pad(expect, 10)} ${pad(o.state, 11)} ${mark}  ${o.detail || (o.hitRank ? `命中第 ${o.hitRank} 位` : '')}`,
    );
  }

  // ── 汇总 ──
  console.log('\n' + line);
  console.log('  指标汇总');
  console.log(line);
  console.log(`  Top-3 命中率（主）      ${(top3Hit * 100).toFixed(1)}%   （${regular.filter((o) => o.passed).length}/${regular.length} 条常规样例）`);
  console.log(`  平均澄清轮次（辅）      ${avgRounds.toFixed(2)}     （目标 ≤1 轮收敛）`);
  console.log(`  澄清判定正确率          ${(clarifyCorrect * 100).toFixed(1)}%   （${clarifyCases.filter((o) => o.passed).length}/${clarifyCases.length} 条）`);
  console.log(`  紧急通道正确率          ${(emergencyCorrect * 100).toFixed(1)}%   （${emergencyCases.filter((o) => o.passed).length}/${emergencyCases.length} 条 · 零模型调用）`);
  console.log(`  整体通过率              ${((outcomes.filter((o) => o.passed).length / outcomes.length) * 100).toFixed(1)}%`);

  // ── 失败 case 五类归因 ──
  const failures = outcomes.filter((o) => !o.passed && o.failureType);
  if (failures.length) {
    console.log('\n【失败 case 归因】');
    const byType = {};
    for (const f of failures) byType[f.failureType] = (byType[f.failureType] || 0) + 1;
    for (const [type, n] of Object.entries(byType)) {
      console.log(`  ${type}  ×${n}`);
    }
  }

  if (VERBOSE) {
    console.log('\n【失败明细】');
    for (const f of failures) console.log(`  ${f.id} [${f.failureType}] ${f.detail}`);
  }

  console.log('\n' + line + '\n');

  // ── 写入 prompt 版本库（交付物四）──
  if (WRITE) {
    const db = await openDatabase();
    const repo = createPromptVersionRepository(db);
    await repo.save({
      version: `${PROMPT_V1.version}-${PROVIDER}`,
      date: new Date().toISOString().slice(0, 10),
      changeDesc: `首版：角色 + 硬约束 + JSON 输出 + ${PROMPT_V1.fewShot.length} 条 few-shot（provider=${PROVIDER}）`,
      hypothesis: '基线能跑通，输出稳定可解析',
      top3HitRate: Math.round(top3Hit * 10000) / 10000,
      avgClarifyRounds: Math.round(avgRounds * 100) / 100,
      failCases: failures.length,
    });
    console.log(`  ✓ 已写入 prompt 版本库：${PROMPT_V1.version}-${PROVIDER}`);
    console.log(`    Top-3 ${(top3Hit * 100).toFixed(1)}% ｜ 平均澄清 ${avgRounds.toFixed(2)} 轮 ｜ 失败 ${failures.length} 条\n`);
    db.close();
  }

  return { top3Hit, avgRounds, clarifyCorrect, emergencyCorrect, outcomes };
}

function pad(s, n) {
  const str = String(s);
  const width = [...str].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
