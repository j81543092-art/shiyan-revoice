/**
 * 紧急规则通道 —— 产品机制规格 R6
 *
 * 红线一：命悬一线的事，不允许任何「AI 猜一下」。
 * 本模块零模型依赖，纯词表匹配 + 规则判定，命中即置顶并直达家属端通知。
 *
 * 触发条件（对应评测集 17 / 18 条）：
 *   - 一级紧急词直接命中（如「跌倒」「喘不上气」「救命」）
 *   - 连点同一症状词 ×3 + 身体部位（如 连点 [疼]×3 + [胸口]）
 *   - 紧急场景（S10）内任意操作
 */

import { SCENARIOS } from './scenarios.js';

/** 一级紧急词（直接触发） */
const PRIMARY_EMERGENCY = new Set(
  SCENARIOS.filter((s) => s.emergency)
    .flatMap((s) => s.words)
    .filter((w) => w.level === 1)
    .map((w) => w.text),
);

/** 二级紧急词（需配合其他信号，或多次连点） */
const SECONDARY_EMERGENCY = new Set(
  SCENARIOS.filter((s) => s.emergency)
    .flatMap((s) => s.words)
    .filter((w) => w.level === 2)
    .map((w) => w.text),
);

/** 症状词 + 部位词的组合规则：「连点 [疼]×3 + [胸口]」 */
const SYMPTOM_WORDS = ['疼', '痛', '麻', '晕'];
const REPEAT_THRESHOLD = 3;

/**
 * 判定是否触发紧急通道。
 * @param {object} clues { icons: string[], keywords: string[], voiceFragments: string[], repeatCounts?: {} }
 * @returns {{ triggered: boolean, level: 1|2|0, reason: string, rule: string, matched: string[] }}
 */
export function evaluateEmergency(clues = {}) {
  const icons = clues.icons || [];
  const keywords = clues.keywords || [];
  const fragments = clues.voiceFragments || [];
  const repeatCounts = clues.repeatCounts || {};
  const all = [...icons, ...keywords, ...fragments].map(String);

  // 规则 1：一级紧急词直接命中
  const hitPrimary = all.filter((c) => PRIMARY_EMERGENCY.has(c) || [...PRIMARY_EMERGENCY].some((w) => c.includes(w)));
  if (hitPrimary.length > 0) {
    return {
      triggered: true,
      level: 1,
      rule: 'R6-①',
      reason: `命中一级紧急词：${[...new Set(hitPrimary)].join('、')}`,
      matched: [...new Set(hitPrimary)],
    };
  }

  // 规则 2：连点症状词 ×3 + 身体部位
  for (const symptom of SYMPTOM_WORDS) {
    const count =
      (repeatCounts[symptom] || 0) + all.filter((c) => c === symptom || c.includes(symptom)).length;
    if (count >= REPEAT_THRESHOLD) {
      const part = all.find((c) => ['头', '胸口', '肚子', '腿', '腰'].some((p) => c.includes(p)));
      return {
        triggered: true,
        level: 1,
        rule: 'R6-②',
        reason: part
          ? `连点「${symptom}」${count} 次并指向${part}，判定为紧急`
          : `连点「${symptom}」${count} 次，判定为紧急`,
        matched: part ? [symptom, part] : [symptom],
      };
    }
  }

  // 规则 3：二级紧急词 + 任一其他线索
  const hitSecondary = all.filter((c) => SECONDARY_EMERGENCY.has(c));
  if (hitSecondary.length > 0 && all.length >= 2) {
    return {
      triggered: true,
      level: 2,
      rule: 'R6-③',
      reason: `命中紧急词「${hitSecondary[0]}」并伴随其他线索`,
      matched: hitSecondary,
    };
  }

  return { triggered: false, level: 0, rule: null, reason: '', matched: [] };
}

/** 紧急提示文案（患者端置顶展示 + 家属端通知） */
export function emergencyMessage(evaluation, clues = {}) {
  const part = (clues.icons || []).find((c) =>
    ['头', '胸口', '肚子', '腿', '腰'].some((p) => String(c).includes(p)),
  );
  switch (evaluation.rule) {
    case 'R6-①':
      return evaluation.matched.includes('跌倒了')
        ? '我跌倒了，快来帮我'
        : '我很不舒服，快来人';
    case 'R6-②':
      return part ? `我${part}疼得厉害，快来人` : '我疼得厉害，快来人';
    case 'R6-③':
      return '快来人，我需要帮忙';
    default:
      return '需要紧急帮助';
  }
}

export { PRIMARY_EMERGENCY, SECONDARY_EMERGENCY };
