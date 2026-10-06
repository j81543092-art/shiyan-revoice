/**
 * 诊断：真实模型的输出被「综合置信度公式」衰减到什么程度
 *
 * 怀疑：模型的 model_confidence 高达 0.9~0.95，但公式里它只占 40% 权重，
 * 其余 60% 由本地三项（场景先验/线索覆盖度/个性化）构成，而这三项有天花板，
 * 导致总分被稀释到 R4 阈值以下 → 强制澄清 → 评测判为「不必要地澄清」。
 *
 * 本脚本把每一步的分数打出来，用数据确认或推翻该怀疑。
 */

import { loadEnv } from '../server/data/env.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

import { createIntentEngine } from '../server/domain/engine.js';
import { INTENT_TEMPLATES } from '../server/domain/intents.js';
import { compositeConfidence, WEIGHTS } from '../server/domain/scoring.js';
import { buildSystemWithFewShot, buildUserMessage } from '../server/model/prompt.js';
import { createHuaweiProvider } from '../server/model/providers/huawei.js';
import { injectNormalize } from '../server/domain/scoring.js';
import { normalizeClue } from '../server/domain/normalize.js';

// 与 engine 一致：注入归一化，否则覆盖度无法识别"候选句子覆盖了哪些线索"
injectNormalize({ normalizeClue });

const provider = createHuaweiProvider({});
const engine = createIntentEngine({ model: { provider: 'huawei' } });

console.log('权重表：', JSON.stringify(WEIGHTS));

const CASES = [
  { id: 'E05', scenario: 'toilet', clues: { icons: ['厕所'], keywords: ['急'], voiceFragments: [] }, answer: '我要上厕所，很急' },
  { id: 'E07', scenario: 'body', clues: { icons: ['疼'], keywords: ['头'], voiceFragments: [] }, answer: '我头疼，有点难受' },
  { id: 'E16', scenario: 'communication', clues: { icons: ['视频'], keywords: [], voiceFragments: [] }, answer: '我想跟小王视频', profile: { caregiverNames: { 小王: '护工王姐' } } },
];

for (const c of CASES) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${c.id}  场景=${c.scenario}  线索=${JSON.stringify(c.clues)}`);

  const raw = await provider.infer({
    system: buildSystemWithFewShot(),
    user: buildUserMessage({
      scenario: c.scenario,
      timeContext: '',
      clues: c.clues,
      profile: c.profile,
      recentConfirmed: [],
    }),
    meta: { scenario: c.scenario, clues: c.clues, profile: c.profile },
  });

  console.log('\n模型原始输出：');
  for (const cand of (raw.candidates || [])) {
    console.log(`  · ${cand.text}   model_confidence=${cand.model_confidence}  templateId=${cand._templateId || '(无)'}`);
  }

  console.log('\n逐项拆解（模型第一条候选）：');
  for (const cand of (raw.candidates || []).slice(0, 3)) {
    const template = INTENT_TEMPLATES.find((t) => t.id === cand._templateId) || { scenarioKey: c.scenario, prior: 0.5 };
    const conf = compositeConfidence({
      template,
      modelConfidence: cand.model_confidence,
      scenarioKey: template.scenarioKey || c.scenario,
      clues: c.clues,
      profile: c.profile,
      candidateText: cand.text,
    });
    const p = conf.parts;
    console.log(`  「${cand.text}」`);
    console.log(`     模型     ${p.model} × ${WEIGHTS.model} = ${(p.model * WEIGHTS.model).toFixed(4)}`);
    console.log(`     场景先验 ${p.scenarioPrior} × ${WEIGHTS.scenarioPrior} = ${(p.scenarioPrior * WEIGHTS.scenarioPrior).toFixed(4)}`);
    console.log(`     线索覆盖 ${p.clueCoverage} × ${WEIGHTS.clueCoverage} = ${(p.clueCoverage * WEIGHTS.clueCoverage).toFixed(4)}`);
    console.log(`     个性化   ${p.personalization} × ${WEIGHTS.personalization} = ${(p.personalization * WEIGHTS.personalization).toFixed(4)}`);
    console.log(`     ──────────────────────────`);
    console.log(`     综合     ${conf.total}   ${conf.total < 0.6 ? '← 低于 R4 阈值 0.6，会被强制澄清' : ''}`);
  }

  const top = (raw.candidates || []).slice(0, 2).map((cand) => {
    const template = INTENT_TEMPLATES.find((t) => t.id === cand._templateId) || { scenarioKey: c.scenario, prior: 0.5 };
    return compositeConfidence({ template, modelConfidence: cand.model_confidence, scenarioKey: template.scenarioKey || c.scenario, clues: c.clues, profile: c.profile }).total;
  });
  if (top.length === 2) {
    console.log(`\n  前两名差值 = ${(top[0] - top[1]).toFixed(4)}  ${Math.abs(top[0] - top[1]) < 0.1 ? '← 低于 0.1，触发 either_or 澄清' : ''}`);
  }
}
