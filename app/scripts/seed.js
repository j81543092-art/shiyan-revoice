/**
 * 种子数据 —— 演示与答辩现场用
 *
 * 灌入：基础词表（100 条）、示例个性化词条、若干条表达记录，
 * 让家属端一打开就有内容，不是空壳。
 *
 * 用法：
 *   node scripts/seed.js            灌种子（幂等，不清历史）
 *   node scripts/seed.js --reset    先清空表达/紧急/会话记录，再灌种子
 *
 * --reset 用于答辩前重置演示现场：
 *   清掉上一次演示残留的记录，避免旧数据（尤其是早期用例写坏的脏数据）
 *   出现在家属端界面和指标看板里。词表不受影响（seedBase 幂等）。
 */

import { openDatabase, createWordRepository, createExpressionRepository } from '../server/data/db.js';

const RESET = process.argv.includes('--reset');

const db = await openDatabase();

if (RESET) {
  // 只清「使用过程」数据，不动词表与 prompt 版本库
  await db.exec(`
    DELETE FROM expressions;
    DELETE FROM emergency_events;
    DELETE FROM sessions;
  `);
  console.log('✓ 演示数据已重置（表达记录 / 紧急事件 / 会话）');
}

const words = createWordRepository(db);
const expressions = createExpressionRepository(db);

const n = await words.seedBase();
console.log(`✓ 基础词表已就绪：${n} 条`);

// ── 示例个性化词条（对应评测集 E16 的「小王」）──
const demos = [
  { text: '小王', category: 'caregiver_name', mapping: '护工王姐', priority: 5 },
  { text: '闺女', category: 'caregiver_name', mapping: '大女儿', priority: 5 },
  { text: '戏曲', category: 'preference', priority: 4 },
  { text: '楼下', category: 'routine', priority: 4 },
];

for (const d of demos) {
  try {
    await words.upsert({ wordId: `W-DEMO-${Buffer.from(d.text).toString('hex').slice(0, 6)}`, ...d, actor: '演示种子' });
  } catch (e) {
    console.warn(`跳过 ${d.text}：${e.message}`);
  }
}
console.log(`✓ 示例个性化词条：${demos.length} 条`);

// ── 示例表达记录 ──
const samples = [
  { finalText: '我想喝水', scenarioKey: 'food', confidence: 0.81, breakdown: { model: 0.87, scenarioPrior: 0.68, clueCoverage: 1, personalization: 0 }, clues: { icons: ['水'] } },
  { finalText: '我要上厕所，很急', scenarioKey: 'toilet', confidence: 0.75, breakdown: { model: 0.88, scenarioPrior: 0.71, clueCoverage: 1, personalization: 0 }, clues: { icons: ['厕所'], keywords: ['急'] } },
  { finalText: '我想儿子了', scenarioKey: 'emotion', confidence: 0.74, breakdown: { model: 0.92, scenarioPrior: 0.62, clueCoverage: 1, personalization: 0 }, clues: { icons: ['想你'], keywords: ['儿子'] } },
];

for (const s of samples) {
  await expressions.save({ sessionId: 'seed-session', patientId: 'demo-patient', clarifyRounds: 0, ...s });
}
console.log(`✓ 示例表达记录：${samples.length} 条`);

console.log('\n种子完成。启动服务：npm start');
console.log('答辩前重置现场：node scripts/seed.js --reset');
db.close();
