/**
 * 验证评分层修复是否在 engine 链路里真正生效
 *
 * 直接调 compositeConfidence 不会经过 injectNormalize，
 * 所以必须通过 engine.understand 走完整链路才算数。
 */

import { loadEnv } from '../server/data/env.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

import { createIntentEngine } from '../server/domain/engine.js';
import { clueCoverageScore, injectNormalize } from '../server/domain/scoring.js';
import { normalizeClue } from '../server/domain/normalize.js';
import { INTENT_TEMPLATES } from '../server/domain/intents.js';

console.log('=== 第 1 步：归一化本身是否可用 ===');
console.log("normalizeClue('我急着要上厕所') =", JSON.stringify(normalizeClue('我急着要上厕所')));
console.log("normalizeClue('快带我去厕所')   =", JSON.stringify(normalizeClue('快带我去厕所')));

console.log('\n=== 第 2 步：注入前 vs 注入后（线索覆盖度）===');
const tpl = INTENT_TEMPLATES.find((t) => t.scenarioKey === 'toilet') || INTENT_TEMPLATES[0];
const clues = { icons: ['厕所'], keywords: ['急'], voiceFragments: [] };
const text = '我急着要上厕所';
console.log('注入前:', clueCoverageScore(tpl, clues, text));
injectNormalize({ normalizeClue });
console.log('注入后:', clueCoverageScore(tpl, clues, text));

console.log('\n=== 第 3 步：走 engine 完整链路 ===');
const engine = createIntentEngine({ model: { provider: 'huawei' } });
const r = await engine.understand({
  clues: { icons: ['厕所'], keywords: ['急'], voiceFragments: [] },
  scenario: 'toilet',
  profile: null,
  round: 0,
});
console.log('state      =', r.state);
console.log('provider   =', r.trace.provider);
console.log('候选与置信度：');
for (const c of (r.candidates || []).slice(0, 5)) {
  console.log(`  ${c.rank}. [${c.confidence}] ${c.text}`);
  console.log(`      breakdown = ${JSON.stringify(c.breakdown)}`);
  console.log(`      templateId = ${c._templateId}`);
}
console.log('澄清:', JSON.stringify(r.clarification));
