/**
 * 图片解析层 —— 把「候选意图」变成「患者能指认的图形」
 *
 * 【设计立场】
 * 失语症患者认图比认字容易，所以候选要配图。但两条路各有代价：
 *
 *   本地图标库（ARASAAC / 场景词表）
 *     ✅ 秒级返回、离线可用、零成本、风格统一
 *     ❌ 只覆盖词表内的概念，组合意图表达不了
 *
 *   文生图（华为云 qwen-image）
 *     ✅ 任意意图都能画
 *     ❌ 慢（5~15s）、按张计费、风格不稳定、可能画出歧义图
 *
 * 结论：**图标优先，文生图只做兜底**。
 * 患者需要快速反馈，让每次点选都等十几秒，产品就不可用了。
 *
 * 因此本层的职责是「先查表，查不到才花钱」：
 *   1. 把候选意图拆成词表中的概念（词级匹配）
 *   2. 命中 ≥1 个 → 返回图标组合（source: 'icon'）
 *   3. 一个都没命中 → 调文生图（source: 'generated'）
 *   4. 文生图也不可用/失败 → 返回空 symbols（source: 'none'），前端退回纯文字
 *
 * 任何一步失败都不能抛异常 —— 图片是增强，文字核心机制必须照常工作。
 */

import { SCENARIOS } from './scenarios.js';
import { createImageProvider, buildImagePrompt } from '../model/providers/image.js';

/** 词表检索索引：把场景词表摊平成 { text → 词条 } 便于快速命中 */
function buildWordIndex() {
  const byText = new Map();
  for (const s of SCENARIOS) {
    for (const w of s.words) {
      // 同一文本可能在多场景出现，保留全部，供按场景择优
      const list = byText.get(w.text) || [];
      list.push({ ...w, scenarioId: s.id, scenarioKey: s.key, scenarioName: s.name });
      byText.set(w.text, list);
    }
  }
  return byText;
}

const WORD_INDEX = buildWordIndex();

export function createVisualResolver(config = {}) {
  const imageProvider = createImageProvider(config.image || {});

  /**
   * 生成缓存 —— 同一个候选文本不重复生成。
   * key 用 场景 + 文本，因为同一句话在不同场景画面不同。
   */
  const generatedCache = new Map();

  return {
    imageProvider,

    /**
     * 解析一个候选意图的图形表达。
     *
     * @param {object} candidate  { text, scenarioKey }
     * @param {object} opts
     *   allowGenerate: 是否允许走文生图（默认 true；批量渲染时可设 false 控制成本）
     * @returns {Promise<object>}
     *   { symbols: [{wordId,text,arasaac,scenarioKey,iconFile}], prompt, source, cached }
     *   source: 'icon' | 'generated' | 'none'
     */
    async resolve(candidate = {}, opts = {}) {
      const text = String(candidate.text || '').trim();
      if (!text) return emptyResult();

      // ── 第 1 步：词表匹配（图标优先）──
      const symbols = matchSymbols(text, candidate.scenarioKey);
      if (symbols.length > 0) {
        return {
          symbols,
          prompt: '',
          source: 'icon',
          cached: true, // 图标库是本地资源，等同于「已缓存」
        };
      }

      // ── 第 2 步：文生图兜底 ──
      if (opts.allowGenerate === false) return emptyResult();
      if (!imageProvider.available()) return emptyResult();

      const prompt = buildImagePrompt({
        text,
        scenario: candidate.scenarioKey,
        icons: symbols.map((s) => s.text),
      });

      const cacheKey = `${candidate.scenarioKey || '_'}::${text}`;
      const hit = generatedCache.get(cacheKey);
      if (hit) return { ...hit, cached: true };

      const b64 = await imageProvider.generate({ prompt });
      if (!b64) return emptyResult();

      const result = {
        symbols: [],
        prompt,
        image: b64, // base64 图片数据（不含 data: 前缀）
        source: 'generated',
        cached: false,
      };
      generatedCache.set(cacheKey, result);
      return result;
    },

    /** 批量解析 —— 供候选列表一次性配图 */
    async resolveAll(candidates = [], opts = {}) {
      return Promise.all(candidates.map((c) => this.resolve(c, opts)));
    },

    stats() {
      return {
        iconIndexSize: WORD_INDEX.size,
        generatedCached: generatedCache.size,
        imageProvider: imageProvider.id,
        imageAvailable: imageProvider.available(),
      };
    },
  };
}

/**
 * 词表匹配：从候选文本里找出可用的图标概念。
 *
 * 匹配策略（由严到宽）：
 *   1. 文本整体等于某个词                 —— 最强信号
 *   2. 文本包含某个词（如「我饿了想吃饭」含「吃饭」）—— 主力
 *   3. 无命中 → 返回空，交文生图
 *
 * 同场景的词优先，避免「热」在起居场景匹配到饮食场景的图标。
 */
export function matchSymbols(text, scenarioKey, maxCount = 3) {
  const hits = [];

  for (const [word, entries] of WORD_INDEX) {
    if (!text.includes(word)) continue;
    // 同场景优先；没有同场景的则接受任一场景
    const preferred =
      entries.find((e) => e.scenarioKey === scenarioKey) || entries[0];
    if (preferred) {
      hits.push({
        wordId: preferred.id,
        text: preferred.text,
        arasaac: preferred.arasaac,
        scenarioKey: preferred.scenarioKey,
        scenarioName: preferred.scenarioName,
        iconFile: iconFileOf(preferred.arasaac),
        // 匹配长度越长，说明越具体，排序靠前
        weight: word.length,
        exact: text === word,
      });
    }
  }

  return hits
    .sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (a.weight !== b.weight) return b.weight - a.weight;
      return a.wordId < b.wordId ? -1 : 1;
    })
    .slice(0, maxCount);
}

/**
 * arasaac 检索词 → 本地图标文件名。
 * 目前只落地了 11 个 ARASAAC 图标（见「拾言-关键屏导出/ARASAAC-符号出处/」），
 * 未落地的返回 null，前端会退化为文字标签（不报错）。
 */
const LOCAL_ICON_FILES = new Set([
  'cold', 'eat', 'hot', 'medicine', 'pain',
  'phone', 'sleep', 'toilet', 'water', 'window',
]);

function iconFileOf(arasaac) {
  if (!arasaac) return null;
  const key = String(arasaac).toLowerCase().trim().replace(/\s+/g, '_');
  // 图标名可能是「eat」也可能是「get up」这类短语，取首个单词尝试
  const first = key.split('_')[0];
  if (LOCAL_ICON_FILES.has(key)) return key;
  if (LOCAL_ICON_FILES.has(first)) return first;
  return null;
}

function emptyResult() {
  return { symbols: [], prompt: '', source: 'none', cached: false };
}
