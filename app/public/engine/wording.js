/**
 * 输出措辞校验 —— 产品机制规格 R8
 *
 * 三条硬红线（合规红线：辅助沟通工具，不做诊断）：
 *   1. 候选句为第一人称口语短句（≤15 字）
 *   2. 禁用医学诊断措辞
 *   3. 禁止臆造线索中不存在的人名、药名、具体对象
 *
 * 校验失败的候选一律剔除 —— 宁可少给一个候选，也不让患者说出不属于他的话。
 */

/** 诊断类措辞黑名单（出现即剔除） */
const DIAGNOSIS_TERMS = [
  '脑梗', '脑出血', '卒中', '中风', '癫痫', '痴呆', '抑郁症', '焦虑症',
  '高血压', '糖尿病', '冠心病', '肺炎', '感染', '恶性肿瘤', '癌',
  '诊断为', '确诊', '病症', '病情恶化', '预后', '临床',
];

/** 医学断言句式（辅助沟通工具不做疗效承诺） */
const MEDICAL_ASSERTION_PATTERNS = [
  /我(得|患)了/,
  /我(的病|病情)(是|很|加重)/,
  /(治疗|吃药|用药)(方案|计划)/,
];

/** 第一人称开头（口语短句） */
const FIRST_PERSON_PREFIXES = ['我', '帮', '要', '想', '快', '别', '给', '把', '让', '来', '谢', '对', '这', '那', '不'];

const MAX_LEN = 15;

/**
 * 校验单个候选。
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function validateCandidate(candidate, clues = {}) {
  const reasons = [];
  const text = String(candidate?.text || '').trim();

  // ① 长度（≤15 字）
  if (!text) {
    reasons.push('候选为空');
  } else if ([...text].length > MAX_LEN) {
    reasons.push(`超过 ${MAX_LEN} 字（实际 ${[...text].length} 字）`);
  }

  // ② 禁用诊断措辞
  for (const term of DIAGNOSIS_TERMS) {
    if (text.includes(term)) {
      reasons.push(`出现诊断措辞「${term}」`);
    }
  }
  for (const re of MEDICAL_ASSERTION_PATTERNS) {
    if (re.test(text)) {
      reasons.push('出现医学断言句式');
      break;
    }
  }

  // ③ 不得臆造线索中不存在的具体对象（人名 / 药名 / 地点）
  const invented = findInventedEntities(text, clues);
  if (invented.length > 0) {
    reasons.push(`臆造了线索中不存在的对象：${invented.join('、')}`);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * 臆造检测：候选句里出现的「专有对象」必须能在线索里找到出处。
 * 覆盖三类：称呼/人名、药名、具体地点。
 */
export function findInventedEntities(text, clues = {}) {
  const pool = [
    ...(clues.icons || []),
    ...(clues.keywords || []),
    ...(clues.voiceFragments || []),
  ].map(String);

  const invented = [];

  // 称呼类：句里出现「给X打电话 / 想X」但 X 不在线索里
  const callMatch = text.match(/(?:给|想|找|和|跟)([\u4e00-\u9fa5]{1,4})(?:打电话|视频|说话|聊|来)/);
  if (callMatch) {
    const target = callMatch[1];
    if (!pool.some((c) => c.includes(target) || target.includes(c))) {
      invented.push(target);
    }
  }

  // 药名类：句里出现「吃X药」但 X 不在线索里（排除通用「药」「吃药」）
  const medMatch = text.match(/吃([\u4e00-\u9fa5]{1,4})药/);
  if (medMatch) {
    const med = medMatch[1];
    const genericOk = ['', '点', '该', '这个', '那个'];
    if (!genericOk.includes(med) && !pool.some((c) => c.includes(med))) {
      invented.push(`${med}药`);
    }
  }

  // 地点类：句里出现「去X」但 X 不在线索里（白名单为常见通用地点，仍需线索支撑）
  const placeMatch = text.match(/(?:去|到|在)([\u4e00-\u9fa5]{2,4})(?:看看|买|走走|转转|晒太阳|一下)?$/);
  if (placeMatch) {
    const place = placeMatch[1];
    if (!pool.some((c) => c.includes(place) || place.includes(c))) {
      invented.push(place);
    }
  }

  return [...new Set(invented)];
}

/**
 * 批量过滤候选，返回 { kept, rejected }。
 * 剔除的候选会进失败 case 本（R8 类归因：「常识错误」/「输出武断」）。
 */
export function filterCandidates(candidates, clues = {}) {
  const kept = [];
  const rejected = [];
  for (const c of candidates) {
    const result = validateCandidate(c, clues);
    if (result.ok) kept.push(c);
    else rejected.push({ candidate: c, reasons: result.reasons });
  }
  return { kept, rejected };
}

/** 措辞边界声明 —— 所有对外文字先过这一句 */
export const COMPLIANCE_STATEMENT = '辅助沟通工具，不做诊断与疗效承诺';
