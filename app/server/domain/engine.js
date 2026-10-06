/**
 * 意图理解编排器 —— 把四层串成一条链
 *
 * 链路：线索 → 紧急规则判定 → 模型/规则推理 → 措辞校验 → 综合置信度排序 → 澄清裁决 → 候选输出
 *
 * 上层（API / 前端）只调用 understand()，不关心下面是华为云还是规则引擎。
 */

import { createModelProvider } from '../model/index.js';
import { buildSystemWithFewShot, buildUserMessage } from '../model/prompt.js';
import { INTENT_TEMPLATES, timeBucketOf } from './intents.js';
import { compositeConfidence, dedupeCandidates, decideCandidateCount, CANDIDATE_RULES, similarity, detectClueConflict } from './scoring.js';
import { evaluateEmergency, emergencyMessage } from './emergency.js';
import { decideClarification, CLARIFY_STATE } from './clarify.js';
import { filterCandidates } from './wording.js';
import { normalizeListInScenario, normalizeClue } from './normalize.js';

// 注意：scoring.js 现在**静态 import** normalize.js，归一化能力从模块加载起
// 就同步可用，因此这里不再需要注入（历史上的 injectNormalize 曾掩盖一个竞态，
// 详见 scoring.js 中 conceptSet 上方的长注释与 scripts/repro-normalize-race.js）。
// normalizeClue 仍在本文件内用于线索归一化。

export function createIntentEngine(config = {}) {
  const provider = createModelProvider(config.model || {});

  return {
    provider,

    /**
     * @param {object} input
     *   clues:       { icons[], keywords[], voiceFragments[], repeatCounts{} }
     *   scenario:    当前场景 key（可空）
     *   profile:     个性化画像 { preferredWords[], caregiverNames{}, routine[] }
     *   recentConfirmed: 最近已确认表达
     *   round:       当前澄清轮次
     *   excludeIds:  需排除的候选（澄清回答「不是」后）
     */
    async understand(input = {}) {
      const t0 = Date.now();
      const rawClues = input.clues || {};
      // 显式场景优先 —— 患者点了场景分区时前端一定会传。
      // 它同时用于「单字碎片消歧」，所以必须在归一化之前确定。
      const explicitScenario = input.scenario || '';
      const clues = normalizeClues(rawClues, explicitScenario);
      // 场景可空：未显式指定时从归一化后的线索反推
      const scenario = explicitScenario || inferScenario(clues) || '';
      const round = input.round || 0;

      const timeContext = {
        bucket: timeBucketOf(new Date()),
        raw: timeContextText(scenario, input.profile),
      };

      // ── 第 0 步：紧急规则通道（R6）—— 零模型依赖，优先于一切 ──
      // 双通道判定：归一化后的线索 ∪ 原始线索。
      // 理由：紧急是命悬一线的事，R6 的精神是「宁可多判不可漏判」。
      // 若归一化出现任何意外，原始线索这条路径仍能兜住。
      let emergency = evaluateEmergency(clues);
      if (!emergency.triggered) emergency = evaluateEmergency(rawClues);
      if (emergency.triggered) {
        return {
          state: CLARIFY_STATE.EMERGENCY,
          emergency: {
            triggered: true,
            level: emergency.level,
            rule: emergency.rule,
            reason: emergency.reason,
            message: emergencyMessage(emergency, clues),
            notify: 'caregiver', // 直达家属端通知
            modelCalled: false, // 零模型调用 —— 答辩必讲
          },
          candidates: [],
          clarification: null,
          trace: {
            provider: 'rule-channel',
            scenario,
            durationMs: Date.now() - t0,
            note: '紧急通道命中，未调用任何模型',
          },
        };
      }

      // ── 第 1 步：模型/规则推理 ──
      let raw;
      let usedProvider = provider.id;
      try {
        raw = await provider.infer({
          system: buildSystemWithFewShot(),
          user: buildUserMessage({
            scenario,
            timeContext: timeContext.raw,
            clues,
            profile: input.profile,
            recentConfirmed: input.recentConfirmed || [],
          }),
          meta: { scenario, clues: { ...clues, timeContext }, profile: input.profile },
        });
      } catch (err) {
        // 模型不可用时静默降级到规则引擎，保证演示不中断
        const { inferWithRules } = await import('../model/providers/rule-engine.js');
        raw = inferWithRules({ scenario, clues: { ...clues, timeContext }, profile: input.profile });
        usedProvider = 'rule(fallback)';
      }

      // ── 第 2 步：措辞校验（R8）—— 不合规的候选一律剔除 ──
      const { kept, rejected } = filterCandidates(raw.candidates || [], clues);

      // ── 第 3 步：综合置信度排序（R2）—— 不用模型裸分数 ──
      const scenarioKey = resolveScenarioKey(scenario, kept);
      const scored = kept
        .map((c) => {
          // ── 模板对齐（v1.2 新增，关键）──
          // 真实模型返回的候选不带 _templateId，若直接退化为 { prior: 0.5 }，
          // 则 scenarioPrior 失去模板先验（退到默认值）、personalization 无模板可用而归零，
          // 两项合计 0.35 权重全部损失 —— 这正是真实模型跑分被压低的第二大原因。
          // 这里按文本相似度把候选对齐到最贴近的意图模板。
          const template =
            INTENT_TEMPLATES.find((t) => t.id === c._templateId) ||
            alignTemplate(c.text, scenarioKey);
          const conf = compositeConfidence({
            template,
            modelConfidence: c.model_confidence,
            scenarioKey: template.scenarioKey || scenarioKey,
            clues: { ...clues, timeContext },
            profile: input.profile,
            // 传入候选文本，让覆盖度能识别「我急着要上厕所」覆盖了线索「厕所」
            candidateText: c.text,
          });
          return {
            text: c.text,
            confidence: conf.total,
            breakdown: conf.parts, // 家属端可见数值（R3）
            matchedClues: c.matched_clues || [],
            rationale: c.rationale || '',
            scenarioKey: template.scenarioKey || scenarioKey,
            _templateId: template.id || null,
          };
        })
        .filter((c) => !input.excludeIds?.includes(c.text));

      // 排序后位置锁定由上层会话保证（同一批线索位置不变）
      const rankedAll = dedupeCandidates(
        scored.sort((a, b) => b.confidence - a.confidence),
      ).map((c, i) => ({ ...c, rank: i + 1 }));

      // ── 第 4 步：候选数量（R1）──
      const clueTypeCount = countClueTypes(clues);
      const countRule = decideCandidateCount(clueTypeCount);
      const ranked = rankedAll.slice(0, countRule.max);

      // ── 第 5 步：澄清裁决（R4）──
      // clueConflict 是**确定性**依据：两条线索分别指向不同候选时，
      // 即便综合置信度恰好过线，也应当澄清（理由可复核、可复现）。
      const clueConflict = detectClueConflict(rankedAll, clues);
      const decision = decideClarification(ranked, round, { clueTypeCount, clueConflict });

      // 澄清态下候选列表仍返回（供 FALLBACK_LIST 与界面做「再看一眼」）
      const finalState = decision.state;

      return {
        state: finalState,
        emergency: { triggered: false },
        // 澄清态也返回候选（供界面「再看一眼」与评测定位），
        // 但患者端在 clarifying 态只渲染澄清卡、不渲染候选卡 —— 规则不因数据而变
        candidates: ranked,
        clarification: decision.clarification,
        fallbackOptions: decision.fallbackOptions || null,
        decisionReason: decision.reason,
        trace: {
          provider: usedProvider,
          scenario: scenarioKey,
          clueTypeCount,
          candidateRule: countRule,
          rawCandidateCount: (raw.candidates || []).length,
          rejectedByWording: rejected, // 进失败 case 本：R8 归因
          clueConflict, // 冲突检测结论（确定性依据）
          durationMs: Date.now() - t0,
          modelCalled: usedProvider === 'rule' ? false : true,
        },
      };
    },
  };
}

// ── 工具函数 ─────────────────────────────────────────────────

/**
 * 线索归一化：把三类通道的原始输入统一成「词表原词」。
 *
 * 为什么必须做映射（这是一个被语音识别引爆的真实缺陷）：
 *   线索覆盖度用的是精确相等匹配（scoring.js 有明确注释：
 *   不用子串，否则「开灯」会被「灯」误伤）。
 *   图标点选天然是原词，所以一直没暴露问题；
 *   但语音识别和关键词输入都是**自由文本** ——
 *   患者说「我想喝水」，一个词都对不上词表里的「水」，
 *   整条链路会静默退回 fallback_list 且不报任何错。
 *
 * 三条通道走同一条规范化路径，才能保证「同一句话从语音说」
 * 和「从键盘打」得到一致结果 —— 否则就是 bug 温床。
 *
 * @param {object} clues 原始线索
 * @param {string} scenarioKey 显式场景，用于单字碎片消歧（可空）
 */
function normalizeClues(clues, scenarioKey = '') {
  // 逃生开关：置 EVAL_DISABLE_NORMALIZE=1 可退回「不做词表映射」的旧行为。
  // 存在的意义不是给生产用，而是让 A/B 对比可复现 ——
  // 「归一化到底带来多少收益」必须能被测量，不能靠感觉下结论。
  if (process.env.EVAL_DISABLE_NORMALIZE === '1') {
    return {
      icons: (clues.icons || []).map(String),
      keywords: (clues.keywords || []).map(String),
      voiceFragments: (clues.voiceFragments || []).map(String),
      repeatCounts: clues.repeatCounts || {},
    };
  }
  return {
    icons: normalizeList(clues.icons, scenarioKey),
    keywords: normalizeList(clues.keywords, scenarioKey),
    voiceFragments: normalizeList(clues.voiceFragments, scenarioKey),
    repeatCounts: clues.repeatCounts || {},
  };
}

/**
 * 单通道归一化：逐条映射到词表原词，去重保序。
 * 落空时尝试场景消歧；仍无解则保留原文（保证单调改善）。
 */
function normalizeList(list, scenarioKey = '') {
  return normalizeListInScenario(list, scenarioKey);
}


/** 线索类型数（图标 / 关键词 / 语音碎片）—— 决定候选数量上限（R1） */
function countClueTypes(clues) {
  let n = 0;
  if (clues.icons?.length) n += 1;
  if (clues.keywords?.length) n += 1;
  if (clues.voiceFragments?.length) n += 1;
  return n;
}

/** 从线索反推场景：命中词最多的场景获胜 */
function inferScenario(clues) {
  const all = [...clues.icons, ...clues.keywords, ...clues.voiceFragments];
  if (all.length === 0) return '';
  const votes = {};
  for (const t of INTENT_TEMPLATES) {
    const pool = [...(t.requires || []).flat(), ...(t.optional || [])];
    for (const clue of all) {
      if (pool.some((w) => clue.includes(w) || w.includes(clue))) {
        votes[t.scenarioKey] = (votes[t.scenarioKey] || 0) + 1;
      }
    }
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : '';
}

function resolveScenarioKey(scenario, candidates) {
  if (scenario) return scenario;
  return candidates[0]?._scenarioKey || '';
}

/**
 * 候选文本 → 意图模板对齐。
 *
 * 【为什么必须有这一步】
 * 规则引擎产出的候选天生带 _templateId（它是照着模板拼的）；
 * 真实模型产出的候选**没有任何模板标识** —— 它只是"说了一句人话"。
 *
 * 若不对齐，engine 会退化成 `{ scenarioKey, prior: 0.5 }` 这个空壳模板，导致：
 *   · scenarioPriorScore 拿不到模板真实先验 → 退到默认 0.5，权重 0.2 白白浪费
 *   · personalizationScore 依赖模板的 requires/optional 匹配常用词 → 直接归零，0.15 全损
 * 合计 0.35 的权重（占非模型部分的 58%）被无声丢弃 —— 这是真实模型跑分偏低的第二大原因。
 *
 * 【对齐策略：先同场景、后全局】
 * 患者已选场景时，优先在该场景的模板里找 —— 这既是先验最相关的地方，
 * 也避免「身体不适」的模板被「居家日常」的候选误抢。
 * 同场景找不到（模型说了句该场景没有的话）才放宽到全局，
 * 并保留原场景 key，不因对齐结果而篡改场景判定。
 *
 * 相似度用与评测集同一套字符 bigram Jaccard，保证「对齐口径」与「判分口径」一致。
 * 阈值 0.2 偏宽松：宁可对齐到一个次优模板（拿到部分先验），
 * 也好过归零 —— 归零等于把 0.35 权重直接扔掉。
 */
function alignTemplate(text, scenarioKey) {
  const pool = scenarioKey
    ? INTENT_TEMPLATES.filter((t) => t.scenarioKey === scenarioKey)
    : INTENT_TEMPLATES;
  const candidates = pool.length ? pool : INTENT_TEMPLATES;

  // 模板的可比较文本：把它声明的词集拼起来当作文本代理
  const templateText = (t) =>
    [t.id, ...(t.requires || []).flat(), ...(t.optional || [])].join('');
  // 兜底代理：模板的示例说法（有的话更贴近自然语言）
  const templateExample = (t) => t.example || t.text || '';

  let best = null;
  let bestScore = 0;
  for (const t of candidates) {
    const s1 = similarity(text, templateText(t));
    const ex = templateExample(t);
    const s2 = ex ? similarity(text, ex) : 0;
    const s3 = similarity(text, t.id);
    const s = Math.max(s1, s2, s3);
    if (s > bestScore) { bestScore = s; best = t; }
  }

  // 连最低阈值都够不上 —— 返回一个带原场景的保底模板，
  // 至少让 scenarioPrior 用场景默认值而不是彻底失去场景信息
  if (!best || bestScore < 0.2) {
    return { scenarioKey: scenarioKey || best?.scenarioKey || '', prior: 0.5, id: null };
  }
  return best;
}

/** 时段与作息上下文文本（进 prompt 的 time_context 字段） */
function timeContextText(scenario, profile) {
  const bucket = timeBucketOf(new Date());
  const zh = { morning: '早上', noon: '中午', afternoon: '午后', evening: '傍晚', night: '夜间' }[bucket];
  const routine = (profile?.routine || []).find((r) => r.scenarioKey === scenario);
  if (routine) return `${zh}，患者通常此时${routine.habit || '有固定安排'}`;
  return zh;
}
