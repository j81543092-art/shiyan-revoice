/**
 * 规则引擎 Provider —— 零依赖兜底实现
 *
 * 为什么需要它：
 *   项目的评测集、Top-3 命中率、澄清轮次这些数字，必须在没有云凭证时就能跑出来。
 *   「没有数字，prompt 的每次改动都是盲人摸象」——这是项目自己写在坑里的第一条。
 *
 * 它按 prompt v1 的同一套硬约束产出候选，因此与模型版输出结构完全一致，
 * 上层（排序层、澄清层、前端）不需要知道自己接的是谁。
 */

import { INTENT_TEMPLATES, BODY_PARTS, DIRECTIONS, KINSHIP_WORDS } from './intents.js';
import { similarity, clamp01 } from './scoring.js';

export function createRuleProvider() {
  return {
    id: 'rule',

    available() {
      return true; // 无需凭证
    },

    async infer({ meta }) {
      const { scenario, clues = {}, profile } = meta || {};
      return inferWithRules({ scenario, clues, profile });
    },
  };
}

/** 图标 → 概念归一：患者点的是「开灯 / 关灯」，意图模板认的是「灯」 */
const ICON_NORMALIZE = {
  开灯: '灯',
  关灯: '灯',
};

/**
 * 线索归一后再匹配，保证「开灯」「关灯」都能落到灯类意图上。
 */
function normalizeClueList(allClues) {
  const out = [];
  for (const c of allClues) {
    out.push(c);
    const mapped = ICON_NORMALIZE[c];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** 规则推理主函数：模板匹配 → 槽位填充 → 置信度打分 */
export function inferWithRules({ scenario, clues = {}, profile }) {
  const icons = clues.icons || [];
  const keywords = clues.keywords || [];
  const fragments = clues.voiceFragments || [];
  // 原始线索用于槽位抽取与措辞校验；归一后的线索用于模板匹配
  const rawClues = [...icons, ...keywords, ...fragments].map(String);
  const allClues = normalizeClueList(rawClues);

  // ── 槽位抽取（R8：不得臆造线索中不存在的对象）──
  const bodyPart = allClues.find((c) => BODY_PARTS.some((p) => c.includes(p))) || '';
  const direction = allClues.find((c) => DIRECTIONS.some((d) => c.includes(d))) || '';
  const kinship = allClues.find((c) => KINSHIP_WORDS.some((k) => c.includes(k))) || '';

  // 称呼映射：家属配置过就用映射后的叫法（如「小王」→「护工王姐」）
  const nameMap = profile?.caregiverNames || {};
  let callName = kinship;
  for (const clue of allClues) {
    for (const [alias, real] of Object.entries(nameMap)) {
      if (clue.includes(alias) || alias.includes(clue)) callName = alias;
    }
  }
  // 线索里直接出现的自定义称呼（如「小王」）
  const customCall = allClues.find((c) => Object.keys(nameMap).some((k) => c.includes(k)));
  if (customCall) callName = customCall;

  // ── 模板匹配 ──
  // 先按「匹配质量」排序，再取前 8 个作为候选池 —— 对应《手册》链 4 的
  // 「先生成 8 个再筛 3~5 个」重排序思路，避免弱模板稀释掉强候选。
  //
  // 评分口径（关键校准）：
  //   precision = 该模板能解释的线索数 / 输入线索总数   → 奖励「解释得全」
  //   recall    = 命中的 required 组数 / required 组总数 → 奖励「必要条件都满足」
  //   单个 OR 组命中只算部分 recall，避免「水」命中 [水|渴] 就冒充满分
  const totalClues = allClues.length || 1;
  const scored = [];
  for (const t of INTENT_TEMPLATES) {
    // 场景不符的降权但不排除（线索可能跨场景）
    const scenarioMatch = !scenario || t.scenarioKey === scenario;
    const settled = settleTemplate(t, { bodyPart, direction, callName });
    if (!settled) continue; // 槽位缺失（会臆造）→ 丢弃

    const match = matchTemplate(t, allClues);
    if (match.hit === 0) continue;

    const recall = match.reqHit / Math.max(match.reqTotal, 1);
    const precision = Math.min(match.matched.length / totalClues, 1);

    // 校准口径（四段加权，让「必要条件全满足」主导排序）：
    //   必要条件完整度 recall   × 0.62  ← 主项：必须条件都命中才应该是首选
    //   required 组绝对命中数    × 0.18  ← 组数多的模板（解释力更强）加分
    //   线索解释广度 precision   × 0.12
    //   场景一致                 × 0.08
    // 目标：required 全中 + 线索全解释 ≈ 1.00；全中但只解释一半 ≈ 0.76
    const reqAbsolute = Math.min(match.reqHit / 3, 1); // 3 组以上封顶
    const modelConf = clamp01(
      recall * 0.62 + reqAbsolute * 0.18 + precision * 0.12 + (scenarioMatch ? 0.08 : -0.12),
    );

    scored.push({
      text: settled,
      model_confidence: round4(modelConf),
      matched_clues: match.matched,
      rationale: rationaleOf(t, allClues),
      __templateId: t.id,
      __scenarioKey: t.scenarioKey,
      __scenarioMatch: scenarioMatch,
      // 池排序：先看必要条件完整度，再看线索解释广度
      __matchQuality: recall * 3 + precision,
    });
  }

  scored.sort((a, b) => b.__matchQuality - a.__matchQuality);
  const pool = scored.slice(0, 8);

  // 按模板内置信度排序，去同义重复（R1：禁止同义重复）
  // 次级排序用线索覆盖广度（matched_clues 数）—— 线索全中的模板排在部分命中的前面
  pool.sort(
    (a, b) =>
      b.model_confidence - a.model_confidence ||
      (b.matched_clues?.length || 0) - (a.matched_clues?.length || 0),
  );
  // 去同义重复（R1：候选之间必须有区分度，禁止同义重复）。
  // v1.3：随 similarity 算法更换同步重标定，0.72 → 0.45。
  // 旧值 0.72 是配合字符 bigram 定的，而该尺度下同义句仅 0.0~0.4，
  // 0.72 实际从未触发过去重。新尺度下同义 0.5~1.0、异义 0.0~0.15，
  // 取 0.45 才能压掉「我头疼 / 我头疼，有点难受」这类近乎重合的，
  // 同时不误伤「我头晕 / 我头疼」这种同场景下的真实备选。
  const distinct = [];
  for (const c of pool) {
    if (!distinct.some((d) => similarity(d.text, c.text) >= 0.45)) distinct.push(c);
  }
  distinct.sort(
    (a, b) =>
      b.model_confidence - a.model_confidence ||
      (b.matched_clues?.length || 0) - (a.matched_clues?.length || 0),
  );

  // ── 低置信判定：交给澄清层决策，这里只如实产出 ──
  const top = distinct[0];
  const lowConfidence = !top || top.model_confidence < 0.45;

  const candidates = distinct.slice(0, 5).map(({ __templateId, __scenarioKey, __scenarioMatch, ...rest }) => ({
    ...rest,
    _templateId: __templateId,
    _scenarioKey: __scenarioKey,
  }));

  return {
    emergency_hint: false, // 紧急判定归规则通道（emergency.js），模型侧不越权
    emergency_reason: '',
    candidates,
    clarification: {
      // 规则引擎不自作主张发澄清，只给信号；最终由 clarify.js 按 R4 统一裁决
      needed: lowConfidence && candidates.length < 2,
      type: lowConfidence && candidates.length < 2 ? 'yes_no' : null,
      question: lowConfidence && candidates.length < 2 && top ? `你是想说「${top.text}」吗？` : '',
      options: lowConfidence && candidates.length < 2 ? ['是', '不是'] : [],
    },
    _lowConfidence: lowConfidence,
  };
}

// ── 内部工具 ─────────────────────────────────────────────────

/** 槽位填充；缺关键槽位则返回 null（宁可不输出，也不臆造 —— R8） */
function settleTemplate(t, { bodyPart, direction, callName }) {
  let text = t.text;
  if (text.includes('{部位}')) {
    if (!bodyPart) return null;
    text = text.replace('{部位}', bodyPart);
  }
  if (text.includes('{方位}')) {
    if (!direction) return null;
    text = text.replace('{方位}', direction);
  }
  if (text.includes('{称呼}')) {
    if (!callName) return null;
    text = text.replace('{称呼}', callName);
  }
  return text;
}

/**
 * 精确线索命中：线索与词条「相等」才算命中。
 * 不用双向 includes —— 那会让「困」命中「想睡觉」（困⊂想睡觉 不成立，
 * 但「开灯」会被「灯」这类子串误伤），导致线索覆盖度虚高、
 * 强候选与弱候选被压成几乎同分，进而触发不必要的澄清。
 */
function clueHit(clue, word) {
  return clue === word;
}

/**
 * 模板与线索的匹配度。
 * requires 是「或组」数组：每个组命中任一词即算该组命中。
 * required 命中决定候选是否够格（reqHit 必须 > 0），optional 决定覆盖广度。
 */
function matchTemplate(t, allClues) {
  const reqGroups = t.requires || [];
  const opts = t.optional || [];

  let reqHit = 0;
  const matched = new Set();

  for (const group of reqGroups) {
    const hitWord = group.find((w) => allClues.some((c) => clueHit(c, w)));
    if (hitWord) {
      reqHit += 1;
      for (const c of allClues) if (clueHit(c, hitWord)) matched.add(c);
    }
  }

  let optHit = 0;
  for (const w of opts) {
    const hitClue = allClues.find((c) => clueHit(c, w));
    if (hitClue) {
      optHit += 1;
      matched.add(hitClue);
    }
  }

  return {
    reqHit,
    reqTotal: reqGroups.length,
    optHit,
    optTotal: opts.length,
    hit: reqHit + optHit,
    matched: [...matched],
  };
}

/** ≤20 字的排序理由 */
function rationaleOf(t, allClues) {
  const m = matchTemplate(t, allClues);
  if (m.matched.length === 0) return '线索支持较弱';
  return `覆盖线索「${m.matched.join('、')}」`;
}

function round4(v) {
  return Math.round(Number(v) * 10000) / 10000;
}
