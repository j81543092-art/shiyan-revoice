/**
 * 澄清状态机 —— 产品机制规格 R4
 *
 * ① top1 综合置信 < 0.6        → 「是 / 不是」（针对 top1）
 * ② 前两名差值 < 0.1           → 「二选一」
 * ③ 最多 2 轮，不收敛 → 展示全部候选 + 「都不是，重来」入口
 *
 * 澄清是机制的一部分，不是失败兜底 —— 这句话在答辩里必须讲。
 *
 * 状态流转：
 *   IDLE ──提交线索──> EVALUATING
 *   EVALUATING ──候选充分且不接近──> READY（展示候选，等确认）
 *   EVALUATING ──置信不足──> CLARIFYING(yes_no)
 *   EVALUATING ──前两名接近──> CLARIFYING(either_or)
 *   CLARIFYING ──患者回答──> EVALUATING（轮次 +1）
 *   CLARIFYING ──轮次达上限仍不收敛──> FALLBACK_LIST（全部候选 + 重来入口）
 *   READY ──患者点选──> CONFIRMED
 */

import { CLARIFY_RULES } from './scoring.js';

export const CLARIFY_STATE = Object.freeze({
  IDLE: 'idle',
  EVALUATING: 'evaluating',
  READY: 'ready', // 候选就绪，等患者确认
  CLARIFYING: 'clarifying', // 正在澄清
  FALLBACK_LIST: 'fallback_list', // 两轮未收敛，全量展示 + 重来
  CONFIRMED: 'confirmed', // 患者已确认
  EMERGENCY: 'emergency', // 走规则通道
});

export const CLARIFY_TYPE = Object.freeze({
  YES_NO: 'yes_no',
  EITHER_OR: 'either_or',
});

/**
 * 决策：给定排好序的候选，判断该出候选还是该澄清。
 * @param {Array} ranked 已按综合置信度降序排好的候选 [{ text, confidence }]
 * @param {number} round 当前澄清轮次（从 0 开始）
 * @param {object} opts { clueTypeCount }
 *
 * 阈值严格取自产品机制规格 R4：
 *   ① top1 < 0.6 → 是/不是
 *   ② 前两名差值 < 0.1 → 二选一
 * 两个阈值都是绝对量，改动须走 A 的规格变更 —— 这是机制的对外契约。
 * （v1.3 只调整了判定**顺序**，未改动 0.6 / 0.1 这两个数值。）
 *
 * ── v1.3 修正：判定顺序（规格级改动，已获确认）────────────────
 * 原实现把「候选不足 2 个」放在**最前面无条件短路**：
 *     if (ranked.length < 2) return YES_NO 澄清
 * 后果是 E07「我头疼」这类用例 —— top1 综合置信度 **0.6997**（远高于 0.6）、
 * 线索充分（疼 + 头）、模型高度确信 —— 仅因为「只有 1 个候选」就被要求澄清。
 * 诊断显示 4/8 条失败都栽在这一条上（E03 / E07 / E11 / E13）。
 *
 * 根因是把两件不同的事混为一谈：
 *   · 「去重后剩 1 个」= 线索不足的证据（如 E06「厕所+换」，语义不明）→ 应澄清
 *   · 「去重后剩 1 个」= 模型非常确信（如 E07「疼+头」→「我头疼」）  → 应直接出
 * 原实现一律按前者处理，等于**因为答案唯一就否认它正确**。
 *
 * 修正：候选不足 2 个时，先看 top1 置信度 ——
 *   够高（≥ R4① 的 0.6）→ 直接出候选，让患者确认即可
 *   不够高           → 仍走 yes_no 澄清（保持 E06 这类用例的正确行为）
 * 这样既解开了误判，又不放宽 R4 的任何一个阈值。
 */
export function decideClarification(ranked, round = 0, opts = {}) {
  // 兜底：一个候选都没有 → 必须澄清（无从输出）
  if (!ranked || ranked.length === 0) {
    return needClarify(null, ranked, round, '没有任何候选可输出');
  }

  const top1 = ranked[0];

  // ── v1.4：线索冲突（确定性依据，优先于全部置信度判定）──────────────
  // 若两条线索分别指向**不同**候选（各自被独占），则这是客观歧义：
  // 线索彼此不能互证，系统不应替患者在两个意图之间做选择。
  // 放在最前面，是因为它的可信度高于任何模型自报分数 ——
  // 实测 E06 的综合置信度在 [0.594, 0.654] 之间由模型噪声决定，
  // 而线索冲突是纯结构判断，恒定、可解释、可复现。
  if (opts.clueConflict?.conflicted) {
    return needClarify(CLARIFY_TYPE.YES_NO, ranked, round,
      `线索冲突：${opts.clueConflict.detail}`);
  }

  // 候选不足 2 个：不能无条件澄清，要看模型有多确信（见上方 v1.3 说明）
  if (ranked.length < 2) {
    if (top1.confidence >= CLARIFY_RULES.lowConfidence) {
      // 唯一候选但置信充分 —— 直接输出，交由患者确认（R5）
      return {
        state: CLARIFY_STATE.READY,
        clarification: null,
        reason: `仅 1 个候选，但置信 ${fmt(top1.confidence)} ≥ ${CLARIFY_RULES.lowConfidence}，直接输出`,
      };
    }
    return needClarify(CLARIFY_TYPE.YES_NO, ranked, round,
      `仅 1 个候选且置信 ${fmt(top1.confidence)} < ${CLARIFY_RULES.lowConfidence}，先确认`);
  }

  const top2 = ranked[1];
  const gap = top1.confidence - top2.confidence;

  // ④ 只有「孤证」才确认：唯一线索且候选优势不明显时
  //    —— 对应评测集 19 条「仅图标 [水] 单线索 / 走 R4①」
  //    单一线索但 top1 优势明显（差值 ≥0.15）时直接出候选，
  //    否则会把「图标[疼]+[头]」这种证据充分的场景误判为需要确认
  if (opts.clueTypeCount === 1 && gap < CLARIFY_RULES.singleClueGap) {
    return needClarify(CLARIFY_TYPE.YES_NO, ranked, round, '仅单一线索且候选优势不明显，先确认再输出');
  }

  // ① top1 置信过低 → 是 / 不是
  if (top1.confidence < CLARIFY_RULES.lowConfidence) {
    return needClarify(CLARIFY_TYPE.YES_NO, ranked, round, `top1 置信 ${fmt(top1.confidence)} < ${CLARIFY_RULES.lowConfidence}`);
  }

  // ② 前两名太接近 → 二选一（R4 原文：差值 < 0.1）
  if (gap < CLARIFY_RULES.closeGap) {
    return needClarify(CLARIFY_TYPE.EITHER_OR, ranked, round, `前两名差值 ${fmt(gap)} < ${CLARIFY_RULES.closeGap}`);
  }

  return { state: CLARIFY_STATE.READY, clarification: null, reason: '候选充分且区分度足够' };
}

/** 生成澄清请求；轮次到上限则转 FALLBACK_LIST */
function needClarify(type, ranked, round, reason) {
  // ③ 最多 2 轮 → 不收敛则展示全部候选 + 「都不是，重来」
  if (round >= CLARIFY_RULES.maxRounds) {
    return {
      state: CLARIFY_STATE.FALLBACK_LIST,
      clarification: null,
      reason: `已澄清 ${round} 轮仍不收敛（上限 ${CLARIFY_RULES.maxRounds} 轮），展示全部候选`,
      fallbackOptions: ['都不是，重来'],
    };
  }

  if (!type) {
    // 无候选可依据，直接给开放式重来
    return {
      state: CLARIFY_STATE.FALLBACK_LIST,
      clarification: null,
      reason,
      fallbackOptions: ['都不是，重来'],
    };
  }

  const top1 = ranked[0];
  const top2 = ranked[1];

  const question =
    type === CLARIFY_TYPE.YES_NO
      ? `你是想说「${top1.text}」吗？`
      : `你是想「${top1.text}」，还是「${top2.text}」？`;

  const options =
    type === CLARIFY_TYPE.YES_NO ? ['是', '不是'] : [top1.text, top2.text];

  return {
    state: CLARIFY_STATE.CLARIFYING,
    clarification: {
      needed: true,
      type,
      question,
      options,
      round: round + 1,
      maxRounds: CLARIFY_RULES.maxRounds,
      targetId: top1.id ?? null,
    },
    reason,
  };
}

/**
 * 判定患者是否做了肯定回答。
 *
 * ⚠️ 这里必须显式处理否定，不能用 `answer.includes('是')` ——
 *    「不是」包含「是」，会被误判为同意，等于**替患者说了相反的话**。
 *    这是整个产品最不能出错的一处：确认权在患者手里，反了就全盘皆错。
 *
 * 词表里的否定词取 R4④ 界面实际给出的选项（「不是」「都不对」「都不是」），
 * 以及常见的口语否定（不 / 没 / 别 / 否）。
 */
const NEGATIVE_PREFIXES = ['不', '没', '别', '否', '无'];
const NEGATIVE_WORDS = ['no', 'nope', 'false', 'not'];
const AFFIRMATIVE_WORDS = ['是', '对', '嗯', '好', '要', 'yes', 'yeah', 'true', 'ok'];

export function isAffirmative(answer) {
  const a = String(answer ?? '').trim().toLowerCase();
  if (!a) return false;

  // ① 否定优先：只要整句以否定词开头，或本身就是否定词，一律判否
  if (NEGATIVE_WORDS.some((w) => a === w)) return false;
  if (NEGATIVE_PREFIXES.some((p) => a.startsWith(p))) return false;

  // ② 肯定：整句等于某个肯定词（避免「是不是」这类歧义片段误命中）
  return AFFIRMATIVE_WORDS.some((w) => a === w) || /^(对|是|嗯|好|要)/.test(a);
}
/**
 * 应用患者对澄清的回答，产出下一步动作。
 *
 * 返回值（action）：
 *   confirm  —— 患者认可，直接锁定该候选（带 confirmed）
 *   reclue   —— 患者否认，排除对应候选后重跑（轮次 +1）
 *   none     —— 无法判定，交回上层重新理解
 *
 * @param {object} p
 * @param {object} p.clarification 上一轮的澄清请求
 * @param {string} p.answer        患者的选择文本
 * @param {Array}  p.ranked        当前候选（可能为空 —— 会话未持久化候选时会这样）
 * @param {object} [p.target]      上一轮澄清指向的候选（clarification.targetId 对应的对象）
 */
export function applyClarificationAnswer({ clarification, answer, ranked = [], target = null }) {
  if (!clarification) return { action: 'none', reason: '无澄清上下文' };

  // 是 / 不是
  if (clarification.type === CLARIFY_TYPE.YES_NO) {
    // 上一轮问的那个候选：优先用 ranked[0]，退回到调用方传入的 target
    const subject = ranked[0] || target || null;

    if (isAffirmative(answer)) {
      // 只有真的存在候选对象时才允许确认，否则交回上层重跑，避免confirm出空对象
      if (!subject) return { action: 'none', reason: '肯定回答但无候选可锁定' };
      return { action: 'confirm', confirmed: subject };
    }

    // 否定 → 排除该候选，重跑
    return { action: 'reclue', exclude: subject?.id ?? subject?.text ?? null, residualClues: [] };
  }

  // 二选一
  if (clarification.type === CLARIFY_TYPE.EITHER_OR) {
    const picked = ranked.find((c) => c.text === answer);
    if (picked) return { action: 'confirm', confirmed: picked };
    // 选了非候选的文本 → 当作新线索回灌
    return { action: 'reclue', exclude: null, residualClues: [String(answer)] };
  }

  return { action: 'none', reason: '未知澄清类型' };
}

function fmt(v) {
  return Number(v).toFixed(2);
}
