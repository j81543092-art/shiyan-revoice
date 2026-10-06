/**
 * 线索归一化 v1 —— 把「自由文本」映射回「词表原词」
 * ══════════════════════════════════════════════════════════════
 *
 * 为什么需要这一层（这是一个真实的、被语音识别引爆的缺陷）：
 *
 *   引擎的线索覆盖度用的是「精确相等匹配」（scoring.js 有明确注释：
 *   不用子串，否则「开灯」会被「灯」误伤）。
 *
 *   这在「图标点选」时代完全够用 —— 按钮上写的就是「水」，
 *   点一下传的就是「水」，天然是词表原词。
 *
 *   但语音识别给出的是自由文本。患者说「我想喝水」，
 *   SIS 返回「我想喝水」，一个字都对不上词表里的「水」，
 *   整条语音链路会静默失效（表现为 fallback_list，还不报错）。
 *
 * 解法不是去改引擎的匹配语义（那会引入「灯」误伤「开灯」的回归），
 * 而是在语音文本「进入引擎之前」做一次归一化：
 *   自由文本 → 词表原词
 * 让语音和图标走上同一条规范化通道，两条链路天然可以互证。
 *
 * 设计原则：
 *   1. 只做「有把握」的映射。宁可漏，不可错 ——
 *      错映射会让患者看到驴唇不对马嘴的候选，比没候选更伤信任。
 *   2. 长词优先。「开灯」「关灯」优先于「灯」，
 *      这正是精确匹配当初想防的那个坑，在这里用排序解决。
 *   3. 保留原文。归一化结果和原文本都要留着，
 *      家属端排障和 A 迭代 prompt 时需要看到患者到底说了什么。
 */

import { SCENARIOS } from './scenarios.js';

/**
 * 语气词与口语填充。归一化时直接丢弃，不参与匹配。
 * 这些词单独出现时没有任何意图信息。
 */
const FILLER_WORDS = [
  '我想', '我要', '我想说', '帮我', '麻烦', '给我', '能不能', '可以',
  '一下', '一点', '有点', '感觉', '觉得', '好像', '大概',
  '就是', '那个', '这个', '然后', '嗯', '呃', '啊', '哦', '呀', '吧', '呢', '了',
];

/**
 * 同义/近义表达表：患者的口语说法 → 词表原词。
 *
 * 这张表是**领域知识**，不是通用分词。
 * 只收录失语症患者高频且与词表语义一致的说法；
 * 模棱两可的一律不收（原则 1：宁可漏，不可错）。
 *
 * 结构：{ 词表原词: [口语变体...] }
 */
export const SYNONYM_MAP = Object.freeze({
  // 起居作息
  起床: ['起来', '起身', '起'],
  睡觉: ['睡', '睡觉觉', '想睡', '困了', '困'],
  翻身: ['翻个身', '换个姿势'],
  坐起: ['坐起来', '坐一坐'],
  躺下: ['躺', '躺平', '卧下'],
  开灯: ['开个灯', '亮灯', '把灯开开'],
  关灯: ['关个灯', '熄灯', '把灯关了'],
  冷: ['好冷', '凉', '冻', '冷了'],
  热: ['好热', '闷热', '烫'],
  被子: ['盖被', '毯子', '被子'],
  // 饮食饮水
  水: ['喝水', '开水', '温水', '凉水', '热水', '水喝', '渴了', '口渴'],
  饭: ['吃饭', '米饭', '饭了', '饿了'],
  粥: ['喝粥', '稀饭', '粥了'],
  汤: ['喝汤', '汤水'],
  饿: ['饿了', '肚子饿', '想吃'],
  渴: ['渴了', '口渴', '想喝'],
  // 如厕
  厕所: ['上厕所', '去厕所', '解手', '方便', '小解', '大解', '内急', '憋不住', '尿急'],
  小便: ['尿尿', '排尿', '尿'],
  大便: ['拉屎', '解大手', '排便'],
  尿不湿: ['尿布', '纸尿裤', '换尿布'],
  擦: ['擦一擦', '擦擦'],
  洗: ['洗手', '洗洗', '清洗'],
  换: ['换一下', '更换', '换个'],
  // 身体不适
  疼: ['痛', '好疼', '好痛', '疼痛', '疼得厉害'],
  麻: ['发麻', '麻木', '手麻', '腿麻'],
  晕: ['头晕', '晕乎', '犯晕'],
  痒: ['发痒', '痒痒'],
  恶心: ['想吐', '反胃', '要吐'],
  没力气: ['没劲', '乏力', '浑身无力', '使不上劲'],
  // 用药
  药: ['吃药', '服药', '用药'],
  吃药: ['该吃药了', '把药吃了'],
  // 情感
  // ⚠️ 「舒服」原放在「高兴」的同义词里，是一个**语义反转陷阱**：
  //    「舒服」  → 高兴（正向）
  //    「不舒服」→ 含「舒服」→ 被映射成「高兴」（**语义完全反了**）
  //    患者在护理场景说「不舒服」是在表达痛苦、需要关注，
  //    映射成「高兴」不可接受 —— 与「快救救我」被归一成「快」同类的严重缺陷。
  // 修正：「舒服」不再属于「高兴」；否定形式归入「难受」。
  高兴: ['开心', '挺好的', '不错', '心情好'],
  烦: ['心烦', '烦躁', '不高兴', '闹心'],
  害怕: ['怕', '有点怕', '担心'],
  难受: ['不舒服', '不得劲', '憋屈', '不舒服了'],
  // 休闲
  电视: ['看电视', '开电视', '关电视'],
  出去转转: ['出去', '走走', '散步', '遛弯', '转转'],
  // 沟通
  打电话: ['打电话吧', '打电话给', '拨电话'],
  手机: ['看手机', '拿手机'],
  // 紧急
  救命: ['救我', '救救我', '不行了', '快救我'],
  跌倒了: ['摔了', '摔倒', '摔了一跤', '跌倒'],
  喘不上气: ['喘不上', '呼吸困难', '憋气', '透不过气', '喘不过气'],
  来人: ['快来', '来人啊', '有人吗', '叫个人'],
  叫救护车: ['救护车', '打120', '叫车'],
  按铃: ['按个铃', '按呼叫器', '叫护士'],
});

/** 从 SCENARIOS 建立「词表原词」全集（含紧急词） */
function buildVocab() {
  const set = new Set();
  for (const s of SCENARIOS) {
    for (const w of s.words || []) set.add(w.text);
  }
  return set;
}

const VOCAB = buildVocab();

/** 反查表：口语变体 → 词表原词 */
const VARIANT_TO_WORD = (() => {
  const m = new Map();
  for (const [word, variants] of Object.entries(SYNONYM_MAP)) {
    for (const v of variants) {
      // 若同一变体被映射到多个原词，保留先出现的（表是有意排序的）
      if (!m.has(v)) m.set(v, word);
    }
  }
  return m;
})();

/**
 * 归一化单条线索文本 → 词表原词数组。
 *
 * 匹配顺序（从最确定到最宽松）：
 *   1. 本身就是词表原词          → 直接返回
 *   2. 整体命中同义表            → 映射到原词
 *   3. 去掉语气词后是词表原词    → 返回
 *   4. 去掉语气词后命中同义表    → 映射
 *   5. 在文本中扫描词表原词（长词优先）→ 返回命中的所有原词
 *
 * @returns {string[]} 归一化后的词表原词（可能多个，可能为空）
 */
export function normalizeClue(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return [];

  // ① 本身即原词
  if (VOCAB.has(raw)) return [raw];

  // ② 整体命中同义表
  if (VARIANT_TO_WORD.has(raw)) return [VARIANT_TO_WORD.get(raw)];

  // ③④ 剥离语气词后再试
  const stripped = stripFillers(raw);
  if (stripped && stripped !== raw) {
    if (VOCAB.has(stripped)) return [stripped];
    if (VARIANT_TO_WORD.has(stripped)) return [VARIANT_TO_WORD.get(stripped)];
  }

  // ⑤ 扫描词表原词。
  //    长词优先 —— 「开灯」必须先于「灯」被匹配，
  //    这正是引擎当初拒绝子串匹配要防的坑，在这里用排序解决。
  const vocabByLength = [...VOCAB].sort((a, b) => b.length - a.length);
  const hits = [];
  for (const word of vocabByLength) {
    if (raw.includes(word) && !hits.includes(word)) hits.push(word);
  }

  // ⑥ 再扫一遍同义变体。
  //    ⚠ 这里必须与 ⑤ 合并返回，不能因为 ⑤ 有命中就短路 ——
  //    曾经的 bug：「快救救我」里「快」是词表原词（level 2 紧急词），
  //    ⑤ 一命中就直接返回 ['快']，把同义变体「救救我」→「救命」
  //    整个跳过了，导致口语化的紧急呼救反而不触发紧急通道。
  //    教训：先收齐所有证据，最后再统一消解。
  const variantByLength = [...VARIANT_TO_WORD.keys()].sort((a, b) => b.length - a.length);
  for (const v of variantByLength) {
    if (raw.includes(v)) {
      const w = VARIANT_TO_WORD.get(v);
      if (!hits.includes(w)) hits.push(w);
    }
  }
  return absorb(hits);
}

/**
 * 包含消解：若短词被同组里的长词包含，丢弃短词。
 *
 * 为什么必须做：
 *   「疼得厉害」是紧急场景的 level 1 词表原词，而「疼」也在词表里。
 *   患者喊「疼得厉害」时两者会同时命中，于是得到 ['疼','疼得厉害'] ——
 *   多出的「疼」会把线索覆盖度的分母撑大，反而稀释真正紧急的那条线索。
 *
 *   注意只消解「字面包含」关系，不做语义推断：
 *   「头」和「晕」谁都不包含谁，两个都留 —— 它们确实是两条独立线索。
 */
function absorb(hits) {
  if (hits.length <= 1) return hits;
  return hits.filter((w) => !hits.some((other) => other !== w && other.includes(w)));
}

/** 去掉句首/句中的语气填充词 */
function stripFillers(text) {
  let s = text;
  for (const f of FILLER_WORDS) {
    // 全局替换：患者可能连说「我想我想」
    s = s.split(f).join('');
  }
  return s.trim();
}

/**
 * 归一化一整组语音碎片。
 *
 * 保留原始文本（供排障与 prompt 迭代），去掉重复与空值。
 * 同时做**跨碎片去重**：患者说了三遍「水」，不该算三个线索 ——
 * 否则线索覆盖度的分母会被灌水，置信度虚高。
 *
 * @param {string[]} fragments 原始碎片
 * @returns {{ words: string[], raw: string[] }} 归一化词 + 原始文本
 */
export function normalizeFragments(fragments = []) {
  const raw = [];
  const words = [];
  for (const f of fragments) {
    const t = String(f == null ? '' : f).trim();
    if (!t) continue;
    raw.push(t);
    for (const w of normalizeClue(t)) {
      if (!words.includes(w)) words.push(w);
    }
  }
  // 合并后必须再消解一次包含关系。
  // 原因：患者断续说「疼…疼得厉害」会切成两条碎片，
  // 各自归一化分别得到「疼」和「疼得厉害」，单条内部无从发现包含关系。
  // 不合并消解，覆盖度分母就会翻倍，把真正紧急的线索稀释掉。
  return { words: absorb(words), raw };
}

/** 供健康检查与测试使用 */
export function normalizeStats() {
  return {
    vocabSize: VOCAB.size,
    synonymEntries: Object.keys(SYNONYM_MAP).length,
    variantCount: VARIANT_TO_WORD.size,
  };
}

// ══════════════════════════════════════════════════════════════
// 场景消歧：单字碎片的确定性映射
// ══════════════════════════════════════════════════════════════
//
// 为什么需要：
//   失语症患者的真实语音常是**单字蹦**的 ——「关」「吃」「疼」。
//   这些字本身不在词表，同义表也难以穷举（「关」可以指关灯/关电视）。
//   评测集 E02/E04/E10/E12 都踩了这个点。
//
// 为什么敢做：
//   场景是**已知**的（患者点了场景分区），这让映射从「猜」变成「确定」——
//   若某场景词表内**有且仅有一个**词包含这个字，那它就是唯一合理解。
//   例：起居场景里含「关」的词只有「关灯」→ 可安全映射。
//       娱乐场景里没有词含「关」→ 不映射，保留原文，不猜。
//
// 边界（宁可漏不可错）：
//   ① 有 2 个以上候选词时一律不映射（歧义未消解，猜就是错）
//   ② 只在指定场景的词表内查找，绝不跨场景乱配
//   ③ 场景为空时不启用（没有约束条件，等于猜）

/** 场景 key → 该场景词表原词集合 */
const SCENARIO_VOCAB = (() => {
  const m = new Map();
  for (const s of SCENARIOS) {
    m.set(s.key, (s.words || []).map((w) => w.text));
  }
  return m;
})();

/**
 * 在指定场景的词表内，为一条线索找**唯一**包含它的词。
 * @returns {string|null} 唯一解，或 null（无解 / 有歧义）
 */
function disambiguateInScenario(clue, scenarioKey) {
  if (!scenarioKey) return null;
  const words = SCENARIO_VOCAB.get(scenarioKey);
  if (!words || words.length === 0) return null;

  // 只在「词包含线索」方向找：「关」⊂「关灯」成立；反向不成立
  const matches = words.filter((w) => w !== clue && w.includes(clue));
  // 有且仅有一个解才敢映射 —— 两个以上说明歧义没消掉
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 场景感知归一化：先做常规归一化，落空时尝试场景消歧。
 *
 * @param {string[]} list 原始线索
 * @param {string} scenarioKey 当前场景（可为空）
 * @returns {string[]} 归一化后的词表原词；若仍无解，保留原文
 */
export function normalizeListInScenario(list, scenarioKey) {
  const items = (list || []).map(String).filter(Boolean);
  if (items.length === 0) return [];

  const out = [];
  for (const item of items) {
    // ① 常规归一化优先
    let words = normalizeClue(item);
    // ② 落空时，尝试场景消歧
    if (words.length === 0) {
      const unique = disambiguateInScenario(item, scenarioKey);
      if (unique) words = [unique];
    }
    // ③ 仍无解则保留原文（与旧行为一致，保证单调改善）
    if (words.length === 0) words = [item];
    for (const w of words) if (!out.includes(w)) out.push(w);
  }
  // 合并后统一做包含消解
  return absorb(out);
}

/** 供测试与健康检查使用：暴露场景消歧能力 */
export function disambiguateStats() {
  return {
    scenarioCount: SCENARIO_VOCAB.size,
    scenarioVocabSize: [...SCENARIO_VOCAB.values()].reduce((n, v) => n + v.length, 0),
  };
}
