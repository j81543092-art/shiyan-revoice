/**
 * 场景词表库 v1 —— 交付物二
 *
 * 依据：《拾言-A阶段0交付物包-v1》交付物二 · 场景词表库 v1
 * 10 个高频场景，每场景 10 个核心词（全量目标每场景 20~30 个，随迭代扩充）。
 * 本文件是前后端共享的单一数据源：
 *   - 前端：表达台的场景分区、图标布局、每屏放几个
 *   - 后端：落库、规则通道的词表匹配
 *
 * 紧急场景（emergency: true）整表不可删 —— 对应产品机制规格 R7。
 */

/** 词条来源枚举 —— 对应交付物二个性化词条 schema 的 source 字段 */
export const WORD_SOURCE = Object.freeze({
  BASE: 'base', // 基础库
  CAREGIVER: 'caregiver', // 家属配置
  LEARNED: 'learned', // 使用习得（须家属审核后生效）
});

/** 个性化词条类别 —— 对应 schema 的 category 字段 */
export const WORD_CATEGORY = Object.freeze({
  COMMON: 'common', // 常用词
  CAREGIVER_NAME: 'caregiver_name', // 护理者称呼
  ROUTINE: 'routine', // 作息
  PREFERENCE: 'preference', // 偏好
});

/**
 * 10 个场景定义。
 * icons 里的每个词条：{ id, text, arasaac（英文检索词）, emergency（可选，一级紧急词） }
 */
export const SCENARIOS = [
  {
    id: 'S01',
    key: 'daily_life',
    name: '起居作息',
    order: 1,
    emergency: false,
    arasaacQuery: 'get up, sleep, turn over, sit up, lie down, light, blanket, cold, hot',
    words: [
      { id: 'W-S01-01', text: '起床', arasaac: 'get up' },
      { id: 'W-S01-02', text: '睡觉', arasaac: 'sleep' },
      { id: 'W-S01-03', text: '翻身', arasaac: 'turn over' },
      { id: 'W-S01-04', text: '坐起', arasaac: 'sit up' },
      { id: 'W-S01-05', text: '躺下', arasaac: 'lie down' },
      { id: 'W-S01-06', text: '开灯', arasaac: 'light on' },
      { id: 'W-S01-07', text: '关灯', arasaac: 'light off' },
      { id: 'W-S01-08', text: '冷', arasaac: 'cold' },
      { id: 'W-S01-09', text: '热', arasaac: 'hot' },
      { id: 'W-S01-10', text: '被子', arasaac: 'blanket' },
    ],
  },
  {
    id: 'S02',
    key: 'food',
    name: '饮食饮水',
    order: 2,
    emergency: false,
    arasaacQuery: 'water, rice, porridge, soup, hungry, thirsty, hot, cold, full',
    words: [
      { id: 'W-S02-01', text: '水', arasaac: 'water' },
      { id: 'W-S02-02', text: '饭', arasaac: 'rice' },
      { id: 'W-S02-03', text: '粥', arasaac: 'porridge' },
      { id: 'W-S02-04', text: '汤', arasaac: 'soup' },
      { id: 'W-S02-05', text: '饿', arasaac: 'hungry' },
      { id: 'W-S02-06', text: '渴', arasaac: 'thirsty' },
      { id: 'W-S02-07', text: '烫', arasaac: 'hot' },
      { id: 'W-S02-08', text: '凉', arasaac: 'cold' },
      { id: 'W-S02-09', text: '饱', arasaac: 'full' },
      { id: 'W-S02-10', text: '不要了', arasaac: 'no' },
    ],
  },
  {
    id: 'S03',
    key: 'toilet',
    name: '如厕护理',
    order: 3,
    emergency: false,
    arasaacQuery: 'toilet, pee, poop, diaper, wipe, wash, change, help',
    words: [
      { id: 'W-S03-01', text: '厕所', arasaac: 'toilet' },
      { id: 'W-S03-02', text: '小便', arasaac: 'pee' },
      { id: 'W-S03-03', text: '大便', arasaac: 'poop' },
      { id: 'W-S03-04', text: '尿不湿', arasaac: 'diaper' },
      { id: 'W-S03-05', text: '擦', arasaac: 'wipe' },
      { id: 'W-S03-06', text: '洗', arasaac: 'wash' },
      { id: 'W-S03-07', text: '换', arasaac: 'change' },
      { id: 'W-S03-08', text: '帮忙', arasaac: 'help' },
      { id: 'W-S03-09', text: '急', arasaac: 'urgent' },
      { id: 'W-S03-10', text: '脏', arasaac: 'dirty' },
    ],
  },
  {
    id: 'S04',
    key: 'body',
    name: '身体不适',
    order: 4,
    emergency: false,
    arasaacQuery: 'pain, numb, dizzy, itch, nausea, weak, head, chest, leg',
    words: [
      { id: 'W-S04-01', text: '疼', arasaac: 'pain' },
      { id: 'W-S04-02', text: '麻', arasaac: 'numb' },
      { id: 'W-S04-03', text: '晕', arasaac: 'dizzy' },
      { id: 'W-S04-04', text: '痒', arasaac: 'itch' },
      { id: 'W-S04-05', text: '恶心', arasaac: 'nausea' },
      { id: 'W-S04-06', text: '没力气', arasaac: 'weak' },
      { id: 'W-S04-07', text: '头', arasaac: 'head' },
      { id: 'W-S04-08', text: '胸口', arasaac: 'chest' },
      { id: 'W-S04-09', text: '肚子', arasaac: 'belly' },
      { id: 'W-S04-10', text: '腿', arasaac: 'leg' },
    ],
  },
  {
    id: 'S05',
    key: 'medication',
    name: '服药就医',
    order: 5,
    emergency: false,
    arasaacQuery: 'medicine, pill, hospital, doctor, nurse, blood pressure',
    words: [
      { id: 'W-S05-01', text: '药', arasaac: 'medicine' },
      { id: 'W-S05-02', text: '吃药', arasaac: 'pill' },
      { id: 'W-S05-03', text: '几点', arasaac: 'clock' },
      { id: 'W-S05-04', text: '医院', arasaac: 'hospital' },
      { id: 'W-S05-05', text: '医生', arasaac: 'doctor' },
      { id: 'W-S05-06', text: '护士', arasaac: 'nurse' },
      { id: 'W-S05-07', text: '量血压', arasaac: 'blood pressure' },
      { id: 'W-S05-08', text: '复查', arasaac: 'checkup' },
      { id: 'W-S05-09', text: '忘吃药', arasaac: 'forget' },
      { id: 'W-S05-10', text: '饭前', arasaac: 'before meal' },
    ],
  },
  {
    id: 'S06',
    key: 'emotion',
    name: '情感社交',
    order: 6,
    emergency: false,
    arasaacQuery: 'miss you, happy, angry, scared, thank you, sorry, quiet',
    words: [
      { id: 'W-S06-01', text: '想你', arasaac: 'miss you' },
      { id: 'W-S06-02', text: '高兴', arasaac: 'happy' },
      { id: 'W-S06-03', text: '烦', arasaac: 'angry' },
      { id: 'W-S06-04', text: '害怕', arasaac: 'scared' },
      { id: 'W-S06-05', text: '谢谢', arasaac: 'thank you' },
      { id: 'W-S06-06', text: '对不起', arasaac: 'sorry' },
      { id: 'W-S06-07', text: '老伴', arasaac: 'spouse' },
      { id: 'W-S06-08', text: '儿子', arasaac: 'son' },
      { id: 'W-S06-09', text: '闺女', arasaac: 'daughter' },
      { id: 'W-S06-10', text: '安静', arasaac: 'quiet' },
    ],
  },
  {
    id: 'S07',
    key: 'leisure',
    name: '休闲娱乐',
    order: 7,
    emergency: false,
    arasaacQuery: 'TV, radio, opera, chess, sun, walk, volume',
    words: [
      { id: 'W-S07-01', text: '电视', arasaac: 'TV' },
      { id: 'W-S07-02', text: '收音机', arasaac: 'radio' },
      { id: 'W-S07-03', text: '戏曲', arasaac: 'opera' },
      { id: 'W-S07-04', text: '象棋', arasaac: 'chess' },
      { id: 'W-S07-05', text: '晒太阳', arasaac: 'sun' },
      { id: 'W-S07-06', text: '出去转转', arasaac: 'walk' },
      { id: 'W-S07-07', text: '声音大', arasaac: 'volume up' },
      { id: 'W-S07-08', text: '声音小', arasaac: 'volume down' },
      { id: 'W-S07-09', text: '换一个', arasaac: 'change' },
      { id: 'W-S07-10', text: '不看', arasaac: 'no' },
    ],
  },
  {
    id: 'S08',
    key: 'outdoor',
    name: '外出行动',
    order: 8,
    emergency: false,
    arasaacQuery: 'go out, home, wheelchair, walk, downstairs, market, tired',
    words: [
      { id: 'W-S08-01', text: '出去', arasaac: 'go out' },
      { id: 'W-S08-02', text: '回家', arasaac: 'home' },
      { id: 'W-S08-03', text: '轮椅', arasaac: 'wheelchair' },
      { id: 'W-S08-04', text: '散步', arasaac: 'walk' },
      { id: 'W-S08-05', text: '楼下', arasaac: 'downstairs' },
      { id: 'W-S08-06', text: '菜市场', arasaac: 'market' },
      { id: 'W-S08-07', text: '走走', arasaac: 'walk' },
      { id: 'W-S08-08', text: '推我', arasaac: 'push' },
      { id: 'W-S08-09', text: '太累', arasaac: 'tired' },
      { id: 'W-S08-10', text: '回来', arasaac: 'come back' },
    ],
  },
  {
    id: 'S09',
    key: 'communication',
    name: '通讯联络',
    order: 9,
    emergency: false,
    arasaacQuery: 'phone call, video call, mobile, answer, hang up, message',
    words: [
      { id: 'W-S09-01', text: '打电话', arasaac: 'phone call' },
      { id: 'W-S09-02', text: '视频', arasaac: 'video call' },
      { id: 'W-S09-03', text: '手机', arasaac: 'mobile' },
      { id: 'W-S09-04', text: '接一下', arasaac: 'answer' },
      { id: 'W-S09-05', text: '挂断', arasaac: 'hang up' },
      { id: 'W-S09-06', text: '儿子', arasaac: 'son' },
      { id: 'W-S09-07', text: '闺女', arasaac: 'daughter' },
      { id: 'W-S09-08', text: '老伴', arasaac: 'spouse' },
      { id: 'W-S09-09', text: '发消息', arasaac: 'message' },
      { id: 'W-S09-10', text: '听不见', arasaac: 'deaf' },
    ],
  },
  {
    id: 'S10',
    key: 'emergency',
    name: '紧急求助（不可删）',
    order: 10,
    emergency: true, // 整表不可删 —— R7
    arasaacQuery: 'help, fall, pain, breathe, emergency, ambulance, bell',
    words: [
      { id: 'W-S10-01', text: '救命', arasaac: 'help', emergency: true, level: 1 },
      { id: 'W-S10-02', text: '跌倒了', arasaac: 'fall', emergency: true, level: 1 },
      { id: 'W-S10-03', text: '疼得厉害', arasaac: 'pain', emergency: true, level: 1 },
      { id: 'W-S10-04', text: '喘不上气', arasaac: 'breathe', emergency: true, level: 1 },
      { id: 'W-S10-05', text: '来人', arasaac: 'emergency', emergency: true, level: 1 },
      { id: 'W-S10-06', text: '快', arasaac: 'hurry', emergency: true, level: 2 },
      { id: 'W-S10-07', text: '出血', arasaac: 'bleed', emergency: true, level: 1 },
      { id: 'W-S10-08', text: '叫救护车', arasaac: 'ambulance', emergency: true, level: 1 },
      { id: 'W-S10-09', text: '按铃', arasaac: 'bell', emergency: true, level: 2 },
      { id: 'W-S10-10', text: '别动我', arasaac: 'stop', emergency: true, level: 2 },
    ],
  },
];

/** 一级紧急词（如连点 [疼]×3 触发规则通道，见 R6 / 评测集 17-18 条） */
export const EMERGENCY_WORDS_PRIMARY = SCENARIOS.filter((s) => s.emergency)
  .flatMap((s) => s.words)
  .filter((w) => w.level === 1)
  .map((w) => w.text);

/** 扁平化：所有词条 + 其所属场景，便于落库与匹配 */
export function flattenWords() {
  const out = [];
  for (const s of SCENARIOS) {
    for (const w of s.words) {
      out.push({
        wordId: w.id,
        text: w.text,
        scenarioId: s.id,
        scenarioKey: s.key,
        scenarioName: s.name,
        arasaac: w.arasaac,
        emergency: !!w.emergency,
        emergencyLevel: w.level || 0,
        category: w.emergency ? WORD_CATEGORY.COMMON : WORD_CATEGORY.COMMON,
        priority: w.emergency ? 5 : 3,
        locked: !!w.emergency, // 紧急词 locked = true，不可删
        source: WORD_SOURCE.BASE,
      });
    }
  }
  return out;
}

/** 按文本或 id 查词条 */
export function findWord(ref) {
  const flat = flattenWords();
  return flat.find((w) => w.wordId === ref || w.text === ref) || null;
}

/** 场景优先级：紧急场景在规则层恒为最高 */
export function scenarioByKey(key) {
  return SCENARIOS.find((s) => s.key === key) || null;
}
