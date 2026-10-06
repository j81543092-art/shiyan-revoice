/**
 * 意图理解编排器（前端精简版）—— 把四层串成一条链，零后端依赖
 *
 * 链路：线索 → 紧急规则判定 → 规则推理 → 措辞校验 → 综合置信度排序 → 澄清裁决 → 候选输出
 *
 * 与 server/domain/engine.js 的区别：
 *   - 不调用任何模型 API，只用规则引擎（inferWithRules）
 *   - 不依赖 process.env
 *   - 可在浏览器 / GitHub Pages 上直接运行
 */

import { INTENT_TEMPLATES, timeBucketOf } from './intents.js';
import { compositeConfidence, dedupeCandidates, decideCandidateCount, similarity, detectClueConflict } from './scoring.js';
import { evaluateEmergency, emergencyMessage } from './emergency.js';
import { decideClarification, CLARIFY_STATE } from './clarify.js';
import { filterCandidates } from './wording.js';
import { normalizeListInScenario, normalizeClue } from './normalize.js';
import { inferWithRules } from './rule-engine.js';

/**
 * @param {object} input
 *   clues:       { icons[], keywords[], voiceFragments[], repeatCounts{} }
 *   scenario:    当前场景 key（可空）
 *   profile:     个性化画像 { preferredWords[], caregiverNames{}, routine[] }
 *   recentConfirmed: 最近已确认表达
 *   round:       当前澄清轮次
 *   excludeIds:  需排除的候选（澄清回答「不是」后）
 */
export async function understand(input = {}) {
  const t0 = Date.now();
  const rawClues = input.clues || {};
  const explicitScenario = input.scenario || '';
  const clues = normalizeClues(rawClues, explicitScenario);
  const scenario = explicitScenario || inferScenario(clues) || '';
  const round = input.round || 0;

  const timeContext = {
    bucket: timeBucketOf(new Date()),
    raw: timeContextText(scenario, input.profile),
  };

  // ── 第 0 步：紧急规则通道（R6）—— 零模型依赖，优先于一切 ──
  let emergency = evaluateEmergency(clues);
  if (!emergency.triggered) emergency = evaluateEmergency(rawClues);
  if (emergency.triggered) {
    return {
      ok: true,
      state: CLARIFY_STATE.EMERGENCY,
      emergency: {
        triggered: true,
        level: emergency.level,
        rule: emergency.rule,
        reason: emergency.reason,
        message: emergencyMessage(emergency, clues),
        notify: 'caregiver',
        modelCalled: false,
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

  // ── 第 1 步：规则推理（无模型依赖）──
  const raw = inferWithRules({ scenario, clues: { ...clues, timeContext }, profile: input.profile });
  const usedProvider = 'rule';

  // ── 第 2 步：措辞校验（R8）──
  const { kept, rejected } = filterCandidates(raw.candidates || [], clues);

  // ── 第 3 步：综合置信度排序（R2）──
  const scenarioKey = resolveScenarioKey(scenario, kept);
  const scored = kept
    .map((c) => {
      const template =
        INTENT_TEMPLATES.find((t) => t.id === c._templateId) ||
        alignTemplate(c.text, scenarioKey);
      const conf = compositeConfidence({
        template,
        modelConfidence: c.model_confidence,
        scenarioKey: template.scenarioKey || scenarioKey,
        clues: { ...clues, timeContext },
        profile: input.profile,
        candidateText: c.text,
      });
      return {
        text: c.text,
        confidence: conf.total,
        breakdown: conf.parts,
        matchedClues: c.matched_clues || [],
        rationale: c.rationale || '',
        scenarioKey: template.scenarioKey || scenarioKey,
        _templateId: template.id || null,
      };
    })
    .filter((c) => !input.excludeIds?.includes(c.text));

  const rankedAll = dedupeCandidates(
    scored.sort((a, b) => b.confidence - a.confidence),
  ).map((c, i) => ({ ...c, rank: i + 1 }));

  // ── 第 4 步：候选数量（R1）──
  const clueTypeCount = countClueTypes(clues);
  const countRule = decideCandidateCount(clueTypeCount);
  const ranked = rankedAll.slice(0, countRule.max);

  // ── 第 5 步：澄清裁决（R4）──
  const clueConflict = detectClueConflict(rankedAll, clues);
  const decision = decideClarification(ranked, round, { clueTypeCount, clueConflict });

  return {
    ok: true,
    state: decision.state,
    emergency: { triggered: false },
    candidates: ranked,
    clarification: decision.clarification,
    fallbackOptions: decision.fallbackOptions || null,
    decisionReason: decision.reason,
    clueConflict,
    trace: {
      provider: usedProvider,
      scenario: scenarioKey,
      clueTypeCount,
      candidateRule: countRule,
      rawCandidateCount: (raw.candidates || []).length,
      rejectedByWording: rejected,
      clueConflict,
      durationMs: Date.now() - t0,
      modelCalled: false,
    },
  };
}

// ── 工具函数 ─────────────────────────────────────────────────

function normalizeClues(clues, scenarioKey = '') {
  return {
    icons: normalizeList(clues.icons, scenarioKey),
    keywords: normalizeList(clues.keywords, scenarioKey),
    voiceFragments: normalizeList(clues.voiceFragments, scenarioKey),
    repeatCounts: clues.repeatCounts || {},
  };
}

function normalizeList(list, scenarioKey = '') {
  return normalizeListInScenario(list, scenarioKey);
}

function countClueTypes(clues) {
  let n = 0;
  if (clues.icons?.length) n += 1;
  if (clues.keywords?.length) n += 1;
  if (clues.voiceFragments?.length) n += 1;
  return n;
}

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

function alignTemplate(text, scenarioKey) {
  const pool = scenarioKey
    ? INTENT_TEMPLATES.filter((t) => t.scenarioKey === scenarioKey)
    : INTENT_TEMPLATES;
  const candidates = pool.length ? pool : INTENT_TEMPLATES;

  const templateText = (t) =>
    [t.id, ...(t.requires || []).flat(), ...(t.optional || [])].join('');
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

  if (!best || bestScore < 0.2) {
    return { scenarioKey: scenarioKey || best?.scenarioKey || '', prior: 0.5, id: null };
  }
  return best;
}

function timeContextText(scenario, profile) {
  const bucket = timeBucketOf(new Date());
  const zh = { morning: '早上', noon: '中午', afternoon: '午后', evening: '傍晚', night: '夜间' }[bucket];
  const routine = (profile?.routine || []).find((r) => r.scenarioKey === scenario);
  if (routine) return `${zh}，患者通常此时${routine.habit || '有固定安排'}`;
  return zh;
}