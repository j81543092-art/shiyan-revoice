/**
 * 综合置信度与候选排序 —— 产品机制规格 R2 的依据
 *
 * 综合置信度 = 模型置信度 × 0.40 ＋ 场景先验 × 0.20 ＋ 线索覆盖度 × 0.25 ＋ 个性化加权 × 0.15
 *
 * 关键设计：不用模型裸分数排序。
 * 先验与个性化是「懂这个患者」的证据 —— 这是答辩里体现技术深度的点。
 */

import { SCENARIO_TIME_PRIOR, timeBucketOf, BODY_PARTS, DIRECTIONS, KINSHIP_WORDS } from './intents.js';
import { normalizeClue as _normalizeClue } from './normalize.js';

/** 权重表 —— 与报告、交付物包完全一致，改动须同步三处 */
export const WEIGHTS = Object.freeze({
  model: 0.4, // 模型置信度
  scenarioPrior: 0.2, // 场景先验
  clueCoverage: 0.25, // 线索覆盖度
  personalization: 0.15, // 个性化加权
});

/** 候选数量规则 —— R1 */
export const CANDIDATE_RULES = Object.freeze({
  default: 3, // 默认 3 个
  max: 5, // 最多 5 个
  richClueThreshold: 3, // 线索充分（≥3 类线索）可到 4~5 个
  minDistinct: 2, // 凑不出 2 个有区分度的候选 → 触发澄清，不硬凑
});

/** 澄清阈值 —— R4 */
export const CLARIFY_RULES = Object.freeze({
  lowConfidence: 0.6, // ① top1 综合置信 < 0.6 → 是 / 不是
  closeGap: 0.1, // ② 前两名差值 < 0.1 → 二选一
  maxRounds: 2, // ③ 最多 2 轮，不收敛则展示全部候选
  singleClueGap: 0.15, // ④ 单一线索且优势 < 0.15 → 先确认（评测集 19 条）
});

/**
 * 场景先验：当前场景 + 时段下该意图的历史频率。
 * 用「模板声明的先验」×「时段频率」得到，两者的几何平均更稳（避免任一项为 0 时整项归零）。
 */
export function scenarioPriorScore(template, scenarioKey, timeContext) {
  const bucket = timeContext?.bucket || timeBucketOf(new Date());
  const timePrior = SCENARIO_TIME_PRIOR[scenarioKey]?.[bucket] ?? 0.5;
  const basePrior = template.prior ?? 0.5;
  // 几何平均：任一项低都会拉低，但不会互相掩盖
  return Math.sqrt(Math.max(basePrior, 0.001) * Math.max(timePrior, 0.001));
}

/**
 * 线索覆盖度：候选解释了多少比例的输入线索。
 * 覆盖 3/3 类 = 1.0（交付物包原文口径）。
 *
 * ── v1.2 修正（重要，勿回滚）─────────────────────────────────
 * 原实现直接 `pool.has(clue)` 精确匹配，注释理由是「不用子串，否则『开灯』
 * 会被『灯』误伤」。该顾虑本身成立，但**用错了地方**：
 *
 *   线索侧永远是词表原词（患者点的是图标、识别结果经归一化层处理），
 *   但比对是**双向**的 —— 早期只有规则引擎时，两侧都来自词表，精确匹配没问题；
 *   接入真实模型后，**候选文本变成了模型生成的自由句子**：
 *     候选「我急着要上厕所」不含词「厕所」→ 覆盖率恒为 0
 *   而 clues 是 ['厕所','急']，于是 hit=0，覆盖率 0.00，
 *   模型 0.93 的高置信度被稀释成 0.49，触发 R4 强制澄清。
 *
 * 修复思路：**不是改成子串匹配**（那会真的引入「开灯」被「灯」误伤的回归），
 * 而是先让候选文本经过与 normalize.js 同源的归一化，产出它「覆盖了哪些词表概念」，
 * 再与模板词集做精确比对。这样：
 *   · 自由文本能正确落词       —— 解决真实模型场景
 *   · 「开灯」归一化后是「开灯」而非「灯」 —— 原有约束依然成立
 *
 * 归一化失败时（可选依赖缺失）退化为原行为，绝不抛异常影响主链路。
 */
export function clueCoverageScore(template, clues, candidateText = '') {
  const allClues = [
    ...(clues.icons || []),
    ...(clues.keywords || []),
    ...(clues.voiceFragments || []),
  ]
    .map(String)
    .filter(Boolean);
  if (allClues.length === 0) return 0;

  // 模板可解释的词集：requires 各组 + optional
  const pool = new Set(
    [...(template.requires || []).flat(), ...(template.optional || [])].map(String),
  );
  // 槽位型模板（带 {部位}/{称呼}）额外允许部位/称呼/方位词落进覆盖
  const slotPool = new Set([
    ...BODY_PARTS, ...DIRECTIONS, ...KINSHIP_WORDS,
  ]);

  // 候选文本归一化后的概念集合 —— 让「我急着要上厕所」也能被「厕所」覆盖
  let covered = null;
  if (candidateText) {
    const cs = conceptSet(String(candidateText));
    covered = cs.size ? cs : null; // 空集视为无信息，退化为纯线索侧匹配
  }

  let hit = 0;
  for (const clue of allClues) {
    if (pool.has(clue) || slotPool.has(clue)) {
      hit += 1;
      continue;
    }
    // 线索本身是模板词集的子串或超串（如线索「肚子」vs 模板「肚子疼」）
    // 也算命中 —— 但只在归一化不可用时启用，避免双重放宽
    if (!covered) {
      let loose = false;
      for (const p of pool) {
        if (p !== clue && (p.includes(clue) || clue.includes(p))) { loose = true; break; }
      }
      if (!loose) {
        for (const s of slotPool) {
          if (s !== clue && (s.includes(clue) || clue.includes(s))) { loose = true; break; }
        }
      }
      if (loose) hit += 1;
      continue;
    }
    // 候选文本是否表达了这条线索
    if (covered.has(clue)) hit += 1;
  }
  return Math.min(hit / allClues.length, 1);
}

/**
 * 线索冲突检测 —— v1.4 新增（R4 的**确定性**澄清依据）。
 *
 * 【为什么需要它】
 * E06（toilet：图标「厕所」+ 图标「换」）是一条「应澄清」用例：
 * 患者给了两条各自指向**不同意图**的线索 ——
 *   「厕所」指向「我要上厕所」（I-TOILET-01）
 *   「换」  指向「帮我换一下尿不湿」（I-TOILET-02）
 * 这两条线索**无法互证**，理应问一句。
 *
 * 但原实现的综合置信度算出来恰好骑在 0.6 门槛上（实测 [0.594, 0.654]），
 * 于是「是否澄清」由**模型自报置信度的随机波动**决定（8 次里 6 ready / 2 clarifying）。
 * 这不是阈值问题，是**结构问题**：确定分量只有 0.265，差额全靠噪声补。
 *
 * 【本函数做什么】
 * 不依赖任何模型输出，纯从句索与模板的对应关系判断：
 * 「是否存在两条线索，分别被不同的高置信候选所独占？」
 * 若是 —— 这是**客观的歧义**，应当澄清，且理由可解释、可复核、可复现。
 *
 * 这正是 R4 想要的：澄清必须是**机制的一部分**，
 * 而不是「模型恰好给低分」的副产物。
 *
 * @returns {{ conflicted: boolean, by: Array, detail: string }}
 */
export function detectClueConflict(ranked, clues) {
  const allClues = [
    ...(clues?.icons || []),
    ...(clues?.keywords || []),
    ...(clues?.voiceFragments || []),
  ].map(String).filter(Boolean);

  if (allClues.length < 2 || !ranked || ranked.length < 2) {
    return { conflicted: false, by: [], detail: '线索或候选不足 2 个，冲突检测不适用' };
  }

  // 每条线索 → 哪些候选覆盖了它。
  // 判据用候选**自己声明**匹配到的线索（matchedClues），这是最可靠的一手信息：
  //   · 规则引擎与真实模型的候选都会带上它
  //   · 若模型没给，退回到模板词集（requires/optional）推断
  const owners = new Map(); // clue → [候选索引]
  for (const clue of allClues) {
    const idx = [];
    ranked.forEach((c, i) => {
      const declared = (c.matchedClues || []).map(String);
      if (declared.includes(clue)) { idx.push(i); return; }
      // 模型没声明时，用模板词集兜底推断
      const pool = new Set([
        ...(c.requires || []).flat(),
        ...(c.optional || []),
      ].map(String));
      if (pool.has(clue)) idx.push(i);
    });
    owners.set(clue, idx);
  }

  // ── 判据：两条线索的「归属候选集合」是否**完全不相交** ──
  //
  // 不用「必须各自独占」—— 那太严。实测 E06：
  //   「厕所」→ 仅候选[0]        （独占）
  //   「换」  → 候选[1] 与 [2]   （不独占，但**都不含**候选[0]）
  // 关键事实是：解释「厕所」的候选，和解释「换」的候选，**没有交集**。
  // 这说明患者给的两条线索指向了系统内部两个互不相干的意图，
  // 谁也不能替对方作证 —— 这正是需要澄清的情形。
  //
  // 反之若两条线索被同一候选共同覆盖（交集非空），说明它们能互证，
  // 例如「厕所」+「急」都被「我要上厕所，很急」覆盖 → 不该澄清。
  let best = null;
  for (let i = 0; i < allClues.length; i++) {
    for (let j = i + 1; j < allClues.length; j++) {
      const setA = new Set(owners.get(allClues[i]) || []);
      const setB = new Set(owners.get(allClues[j]) || []);
      if (setA.size === 0 || setB.size === 0) continue; // 某条线索无人解释 → 交给覆盖率处理

      const intersect = [...setA].some((x) => setB.has(x));
      if (!intersect) {
        // 两条线索各自被完全不同的候选解释 → 客观歧义
        const aIdx = [...setA][0];
        const bIdx = [...setB][0];
        // 取「代表候选」时优先用更靠前的（置信更高）那个
        if (!best || Math.min(aIdx, bIdx) < best.priority) {
          best = { a: allClues[i], b: allClues[j], aIdx, bIdx, priority: Math.min(aIdx, bIdx) };
        }
      }
    }
  }

  if (best) {
    const ca = ranked[best.aIdx];
    const cb = ranked[best.bIdx];
    const pairs = [
      { clue: best.a, ownerText: ca?.text ?? '?' },
      { clue: best.b, ownerText: cb?.text ?? '?' },
    ];
    return {
      conflicted: true,
      by: [
        { clue: best.a, owner: best.aIdx },
        { clue: best.b, owner: best.bIdx },
      ],
      // pairs 是给界面直接渲染用的最小可读形态：
      // 前端不需要解析 detail 这句话，也就不会被措辞改动拗断。
      // detail 保留给家属端 / 评测做单行归因。
      pairs,
      detail:
        `线索「${best.a}」指向「${ca?.text ?? '?'}」，` +
        `线索「${best.b}」指向「${cb?.text ?? '?'}」—— 两条线索无法互证`,
    };
  }

  return { conflicted: false, by: [], pairs: [], detail: '线索可互证或由同一候选统一解释' };
}

/**
 * 个性化加权：命中患者常用词 / 称呼 / 作息偏好的程度。
 * profile 来自个性化词条表（家属配置 + 使用习得）。
 */
export function personalizationScore(template, clues, profile) {
  if (!profile) return 0;

  const nameMap = profile.caregiverNames || {}; // { '小王': '护工王姐' }
  const preferred = (profile.preferredWords || []).map(String);
  const routine = profile.routine || []; // [{ scenarioKey, bucket, weight }]

  const allClues = [
    ...(clues.icons || []),
    ...(clues.keywords || []),
    ...(clues.voiceFragments || []),
  ].map(String);

  let score = 0;
  let weights = 0;

  // ① 称呼命中：线索里出现家属配置过的称呼 → 高权重
  for (const clue of allClues) {
    for (const name of Object.keys(nameMap)) {
      if (clue.includes(name) || name.includes(clue)) {
        score += 1.0;
        weights += 1.0;
      }
    }
  }

  // ② 常用词命中：模板候选句或线索命中患者常用词
  for (const clue of allClues) {
    if (preferred.some((p) => clue.includes(p) || p.includes(clue))) {
      score += 0.7;
      weights += 0.7;
      break;
    }
  }

  // ③ 作息偏好：该场景在此时段的患者个人习惯
  const bucket = clues.timeContext?.bucket || timeBucketOf(new Date());
  const routineHit = routine.find(
    (r) => r.scenarioKey === template.scenarioKey && (!r.bucket || r.bucket === bucket),
  );
  if (routineHit) {
    score += Math.min(Number(routineHit.weight) || 0.5, 1.0);
    weights += 1.0;
  }

  if (weights === 0) return 0;
  return Math.min(score / weights, 1);
}

/**
 * 主入口：计算一条候选的综合置信度。
 * modelConfidence 由模型（或规则引擎）给出，这里做融合排序。
 *
 * ── v1.4 新增：模型自报置信度的**收缩（shrinkage）**────────────────────
 *
 * 【为什么必须收缩】实测同一份提示词、同一组线索、连续 6 次调用，
 * 模型对**语义完全相同**的句子自报的 model_confidence 是：
 *     我要上厕所 → 0.62
 *     我要上厕所 → 0.88      ← 同一句话，同一个模型，相差 0.26
 * 即 model_confidence **本质上是噪声**，它没有经过任何校准，
 * 却带着 0.40 的权重、单独决定 R4 的 0.6 门槛 —— 这是设计缺陷。
 *
 * 产品后果（实测 E06，toilet：厕所 + 换，8 次）：
 *     综合置信在 [0.5823, 0.7183] 之间漂移，7 次 ready、1 次 clarifying。
 *     患者说同样的话，得到「直接出候选」还是「被反问一句」**取决于模型抽签**。
 *
 * 【收缩怎么做】把模型置信度向中性值 0.5 拉近：
 *     model' = 0.5 + (model - 0.5) × MODEL_CONFIDENCE_TRUST
 * 这只压缩**幅度**、不改变**方向** —— 模型说高的仍然高，只是不那么极端。
 * 权重表 WEIGHTS 与 R4 阈值 0.6 / 0.1 一律不动（对外契约）。
 *
 * 【为什么选向 0.5 收缩】0.5 是「毫无信息」的中性点。模型的偏差主要在幅度
 * （同义句给 0.62~0.88），方向上是可信的，所以保留符号、压缩幅度是对症的。
 */
export const MODEL_CONFIDENCE_TRUST = 0.5;

/** 把模型自报置信度向中性值收缩，降低其对门槛判定的杠杆 */
export function calibrateModelConfidence(raw) {
  const v = clamp01(raw);
  return clamp01(0.5 + (v - 0.5) * MODEL_CONFIDENCE_TRUST);
}

export function compositeConfidence({ template, modelConfidence, scenarioKey, clues, profile, candidateText = '' }) {
  const rawModel = clamp01(modelConfidence);
  const parts = {
    model: calibrateModelConfidence(rawModel),
    scenarioPrior: scenarioPriorScore(template, scenarioKey, clues.timeContext),
    clueCoverage: clueCoverageScore(template, clues, candidateText),
    personalization: personalizationScore(template, clues, profile),
  };

  const total =
    parts.model * WEIGHTS.model +
    parts.scenarioPrior * WEIGHTS.scenarioPrior +
    parts.clueCoverage * WEIGHTS.clueCoverage +
    parts.personalization * WEIGHTS.personalization;

  return {
    total: round4(total),
    parts: {
      model: round4(parts.model),
      rawModel: round4(rawModel), // 保留原始值，便于诊断与留痕
      scenarioPrior: round4(parts.scenarioPrior),
      clueCoverage: round4(parts.clueCoverage),
      personalization: round4(parts.personalization),
    },
  };
}

/**
 * 候选去重与区分度检查 —— R1「候选之间必须有区分度，禁止同义重复」。
 *
 * 【v1.3 重标定】阈值由 0.7 调整为 0.45。
 * 旧值 0.7 是配合字符 bigram Jaccard 定的，而该算法对中文同义表达失效：
 * 实测「我左腿麻 / 我的左腿发麻」仅 0.14、「我头疼 / 头很疼」为 0.00，
 * 阈值 0.7 形同虚设，同义候选从来不会被去重。
 * 新算法下同义候选落在 0.5~1.0，异义候选落在 0.0~0.15，
 * 取 0.45 可有效拦截同义重复，同时不误杀真正有区分度的候选。
 * 标定过程见 scripts/calibrate-thresholds.js。
 */
export function dedupeCandidates(candidates, threshold = 0.45) {
  const kept = [];
  for (const c of candidates) {
    const dup = kept.some((k) => similarity(normText(k.text), normText(c.text)) >= threshold);
    if (!dup) kept.push(c);
  }
  return kept;
}

/**
 * 文本相似度 —— v1.3 重构（重要，勿回滚）
 *
 * 【为什么必须换掉旧实现】
 * 旧实现是字符 bigram Jaccard。实测它对中文近义句的判别力趋近于零：
 *   语义相同的句子 → 0.00 ~ 0.40
 *   语义不同的句子 → 0.00 ~ 0.25
 * **两个区间完全重叠，任何单一阈值都无法分开。** 典型失例：
 *   「我头疼」  vs「头很疼」        旧算法 0.0000（只多一个「很」字，二元组全偏）
 *   「我想喝水」vs「我想吃饭」      旧算法 0.2000（只差一个字，反而更高）
 * 而 similarity 是三个关键位置的依据：
 *   ① 评测判中（阈值 0.42）② 候选去重（阈值 0.7）③ 模板对齐
 * 所以旧的「Top-3 命中率」在度量层面就不可信。
 *
 * 【新实现：概念优先、字面兜底】
 *   概念重合 0.50 —— 经 normalize.js 压到词表概念后比较，**能跨同义替换**
 *                    （「几点」/「什么时候」只要映射到同一概念就能对上）
 *   实词骨架 0.30 —— 剥掉人称/情态/虚词后的 2-gram，对词序与虚词鲁棒
 *   实词集合 0.15 —— 兜住词序打乱的改写
 *   原始字面 0.05 —— 极少量字面信息，防概念过度抽象而误合
 * 最后按**否定/量级不一致**扣分（「我不想喝水」≠「我想喝水」，
 * 「我有点疼」≠「我疼得很厉害」—— 后者在护理场景下含义完全不同）。
 *
 * 依赖方向：scoring → normalize 会形成循环（normalize 依赖 intents，scoring 也依赖 intents），
 * 因此归一化能力由 engine 启动时通过 injectNormalize 注入，缺失时自动退化为字面比较。
 */

/** 虚词/填充词 —— 几乎不携带意图信息 */
const STOP_WORDS = new Set([
  '的', '了', '着', '过', '地', '得', '是', '在', '有',
  '会', '能', '可', '可以', '请', '帮我', '给我',
  '一个', '一下', '一点', '一些', '稍微', '比较', '挺',
  '那个', '这个', '然后', '就是', '好像', '大概', '嗯', '呃', '啊', '哦', '呀',
  '吧', '呢', '吗', '嘛', '啦', '再', '又', '还', '就', '都', '也',
]);
const FIRST_PERSON = new Set(['我', '你', '他', '她', '它', '俺', '咱', '自己', '我们', '你们', '他们']);
const MODALS = new Set(['想', '要', '得', '需', '需要', '打算']);

const NEGATION_WORDS = ['不', '别', '没', '不要', '不用', '不想', '不能', '无法', '拒绝'];
const HIGH_DEGREE_WORDS = ['很', '非常', '特别', '太', '极了', '厉害', '严重', '受不了'];
const LOW_DEGREE_WORDS = ['有点', '稍微', '一点', '些', '轻微', '略微'];

/**
 * 相似度与概念归一化的依赖装配。
 *
 * ── v1.4 修正：改回**静态 import**，修掉一个我自己引入的竞态 ──────────
 *
 * 【曾经的错误做法】初版用 injectNormalize 显式注入 → 诊断脚本忘了注入就静默退化；
 * 于是改成「动态 import 惰性自初始化」。**但这个改动引入了一个更严重的问题**：
 * 动态 import 是**异步**的，而 similarity() 是**同步**的，
 * 于是 conceptSet() 在 promise 落定之前会返回**空集**，使相似度退化成纯字面比较。
 *
 * 实测证据（scripts/repro-normalize-race.js）：
 *     我头疼 / 头很疼        0.2000（未落定） → 1.0000（落定）
 *     我左腿麻 / 我的左腿发麻  0.3893           → 1.0000
 *     4/4 对句子在**同一进程内**前后得分不同
 *
 * 产品后果比数字严重得多：**患者按下按钮的时机，会影响候选排序、
 * 进而影响是否触发澄清** —— 同一个人说同一句话，早零点几秒按就得到不同结果。
 * 这不是模型不稳定，是我们自己的时序 bug。
 *
 * 【为什么现在可以静态 import】
 * 当初担心 scoring.js ↔ normalize.js 循环依赖，所以用了动态 import。
 * 但实际依赖图是无环的（已用 scripts 核验）：
 *     normalize.js → scenarios.js        （scenarios 是叶子）
 *     scoring.js   → intents.js
 *     normalize.js ✗ 不 import scoring
 *     intents.js   ✗ 不 import normalize / scoring
 * 即 normalize 与 scoring 之间**根本没有环**。动态 import 是在解决
 * 一个不存在的问题，却制造了一个真实的竞态。
 *
 * 【现在的做法】模块加载时静态绑定，归一化能力**从第一行代码起就同步可用**，
 * 不存在「未就绪」的时间窗。injectNormalize 保留，仅用于测试强制替换。
 */
const _normalizeImpl = { normalizeClue: _normalizeClue };

/** 由测试显式替换（生产路径不再需要注入） */
export function injectNormalize(fnModule) {
  Object.assign(_normalizeImpl, fnModule || { normalizeClue: _normalizeClue });
}

/** 概念集合：这句话表达了哪些词表概念
 *
 * ⚠️ 必须是同步且恒定的 —— 历史上这里曾因动态 import 而返回空集，
 * 导致同一句话在不同时机得到不同分数（详见上方注释与
 * scripts/repro-normalize-race.js）。**不要改回异步加载。**
 */
function conceptSet(text) {
  const out = new Set();
  try {
    for (const w of _normalizeImpl.normalizeClue(String(text || ''))) out.add(w);
  } catch { /* 归一化异常 → 退化为纯字面（此时概念集为空，similarity 会自动降权） */ }
  return out;
}

/** 归一化能力是否已就绪 —— 供诊断脚本检查，避免拿到误导性分数 */
export function normalizeReady() {
  return { ready: true, error: '' };
}

/** 实词骨架：剥掉虚词/人称/情态，只留承载意图的字 */
function contentChars(s) {
  const clean = String(s || '').replace(/[\s，。、！？,.!?；;：:'"（）()【】\[\]—-]/g, '');
  const cs = [...clean].filter((c) => !STOP_WORDS.has(c) && !FIRST_PERSON.has(c) && !MODALS.has(c));
  return cs.length ? cs : [...clean];
}

function ngrams(arr) {
  const out = new Set();
  if (arr.length === 0) return out;
  if (arr.length === 1) { out.add(arr[0]); return out; }
  for (let i = 0; i < arr.length - 1; i++) out.add(arr[i] + arr[i + 1]);
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 方向性扣分：否定与量级不一致必须降低相似度 */
function polarityPenalty(a, b) {
  const sA = String(a || '');
  const sB = String(b || '');
  const has = (s, list) => list.some((w) => s.includes(w));
  let penalty = 1;
  // 否定相反 —— 语义对立，重罚
  if (has(sA, NEGATION_WORDS) !== has(sB, NEGATION_WORDS)) penalty *= 0.30;
  // 程度悬殊（很强 vs 有点）—— 护理场景下不可等同，重罚
  const hiA = has(sA, HIGH_DEGREE_WORDS); const loA = has(sA, LOW_DEGREE_WORDS);
  const hiB = has(sB, HIGH_DEGREE_WORDS); const loB = has(sB, LOW_DEGREE_WORDS);
  if ((hiA && loB) || (loA && hiB)) penalty *= 0.40;
  return penalty;
}

/**
 * 文本相似度（v1.3）—— 概念优先、字面兜底。
 * @returns {number} 0~1
 */
export function similarity(a, b) {
  const rawA = String(a || '');
  const rawB = String(b || '');
  if (rawA === rawB) return 1;
  if (!rawA || !rawB) return 0;

  const cA = conceptSet(rawA);
  const cB = conceptSet(rawB);
  // 双方概念集合都非空时才采信概念信号，否则该项「无信息」
  const conceptSig = (cA.size && cB.size) ? jaccard(cA, cB) : null;

  const skelA = contentChars(rawA);
  const skelB = contentChars(rawB);
  const s2 = jaccard(ngrams(skelA), ngrams(skelB));
  const s3 = jaccard(new Set(skelA), new Set(skelB));
  const s4 = jaccard(ngrams([...rawA]), ngrams([...rawB]));

  let score;
  if (conceptSig === null) {
    // 无概念信息：按字面权重重新归一化到 0~1
    score = (0.30 * s2 + 0.15 * s3 + 0.05 * s4) / 0.50;
  } else {
    score = 0.50 * conceptSig + 0.30 * s2 + 0.15 * s3 + 0.05 * s4;
    // 概念重合是强证据，给一个下限抬升（但不一刀切顶到固定值，
    // 否则「喝水 vs 吃饭」这种只共享情态词的也会被抬上去）
    if (conceptSig > 0) score = Math.max(score, conceptSig);
  }

  return Math.min(Math.max(score * polarityPenalty(rawA, rawB), 0), 1);
}

/**
 * 旧版字符 bigram Jaccard —— 保留供对比测试与回归排查。
 * 生产代码不应再调用它。verify-similarity.js 用它做前后对比。
 */
export function similarityLegacy(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

function normText(s) {
  return String(s)
    .replace(/[\s，。、！？,.!?]/g, '')
    .toLowerCase();
}

/** 候选数量决策 —— R1 */
export function decideCandidateCount(clueTypeCount) {
  if (clueTypeCount >= CANDIDATE_RULES.richClueThreshold) {
    return { min: 3, max: CANDIDATE_RULES.max, reason: '线索充分（≥3 类）可到 4~5 个' };
  }
  return { min: CANDIDATE_RULES.minDistinct, max: CANDIDATE_RULES.default, reason: '线索有限，默认 3 个' };
}

// ── 小工具 ───────────────────────────────────────────────────
export function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function round4(v) {
  return Math.round(Number(v) * 10000) / 10000;
}
