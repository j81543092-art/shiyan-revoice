/**
 * 意图模板库 —— 规则引擎兜底 + 场景先验的来源
 *
 * 用途：
 *   1. ModelProvider 无凭证时的规则兜底（保证现在就能跑通全链路与评测）
 *   2. 场景先验：当前场景下该意图的历史频率（综合置信度公式的一项）
 *
 * 设计约束（对应 R8 输出措辞红线）：
 *   - 候选句为第一人称口语短句，≤15 字
 *   - 禁用医学诊断措辞
 *   - 禁止臆造线索中不存在的人名、药名、具体对象
 *
 * 每条模板：{
 *   id, scenarioKey,
 *   requires: 必须命中的线索（图标词 / 关键词，任一类命中即可）
 *   optional: 加分线索
 *   text:      候选句（第一人称口语短句）
 *   prior:     场景先验基础权重 0~1
 *   slots:     需要从线索里填的槽位
 * }
 */

export const INTENT_TEMPLATES = [
  // ── 饮食饮水 (S02) ─────────────────────────────────────────
  {
    id: 'I-FOOD-01',
    scenarioKey: 'food',
    requires: [['饭'], ['饿']],
    optional: ['水', '粥', '汤', '渴'],
    text: '我饿了，想吃饭',
    prior: 0.86,
  },
  {
    id: 'I-FOOD-02b',
    scenarioKey: 'food',
    requires: [['饭', '水', '饿']],
    optional: [],
    text: '我饿了，想吃饭，再喝点水',
    prior: 0.78,
  },
  {
    id: 'I-FOOD-02',
    scenarioKey: 'food',
    requires: [['饭', '饿']],
    optional: ['水'],
    text: '我想吃饭，再喝点水',
    prior: 0.72,
  },
  {
    id: 'I-FOOD-03',
    scenarioKey: 'food',
    requires: [['水', '渴']],
    optional: ['饭', '饿'],
    text: '我想喝水',
    prior: 0.78,
  },
  {
    id: 'I-FOOD-04',
    scenarioKey: 'food',
    requires: [['渴']],
    optional: ['水'],
    text: '我口渴了',
    prior: 0.70,
  },
  {
    id: 'I-FOOD-05',
    scenarioKey: 'food',
    requires: [['烫']],
    optional: ['水', '汤'],
    text: '这个太烫了',
    prior: 0.62,
  },
  {
    id: 'I-FOOD-06',
    scenarioKey: 'food',
    requires: [['凉']],
    optional: ['水', '饭'],
    text: '这个凉了，帮我热一下',
    prior: 0.58,
  },
  {
    id: 'I-FOOD-07',
    scenarioKey: 'food',
    requires: [['饱']],
    optional: ['不要了'],
    text: '我吃饱了，不要了',
    prior: 0.64,
  },
  {
    id: 'I-FOOD-08',
    scenarioKey: 'food',
    requires: [['粥', '汤']],
    optional: ['饭', '饿'],
    text: '我想喝点粥',
    prior: 0.60,
  },

  // ── 起居作息 (S01) ─────────────────────────────────────────
  {
    id: 'I-LIFE-01',
    scenarioKey: 'daily_life',
    // 困 / 睡觉 任一即可；「灯」只作为加分线索，不参与必要条件
    requires: [['睡觉', '困'], ['床', '睡觉', '困']],
    optional: ['开灯', '关灯', '灯'],
    text: '我困了，想睡觉',
    prior: 0.84,
  },
  {
    id: 'I-LIFE-02',
    scenarioKey: 'daily_life',
    // 「灯」类线索（开灯 / 关灯 / 灯）出现即指向关灯睡觉
    requires: [['灯', '关灯', '开灯'], ['睡觉', '床', '困']],
    optional: ['冷', '热'],
    text: '我要睡觉了，请关灯',
    prior: 0.80,
  },
  {
    id: 'I-LIFE-03',
    scenarioKey: 'daily_life',
    requires: [['起床']],
    optional: ['坐起'],
    text: '我想起来了',
    prior: 0.66,
  },
  {
    id: 'I-LIFE-04',
    scenarioKey: 'daily_life',
    requires: [['翻身']],
    optional: [],
    text: '帮我翻个身',
    prior: 0.68,
  },
  {
    id: 'I-LIFE-05',
    scenarioKey: 'daily_life',
    requires: [['坐起']],
    optional: ['起床'],
    text: '帮我把床摇起来坐一会儿',
    prior: 0.60,
  },
  {
    id: 'I-LIFE-06',
    scenarioKey: 'daily_life',
    requires: [['冷']],
    optional: ['被子'],
    text: '我有点冷，帮我盖一下',
    prior: 0.64,
  },
  {
    id: 'I-LIFE-07',
    scenarioKey: 'daily_life',
    requires: [['热']],
    optional: [],
    text: '我有点热',
    prior: 0.62,
  },
  {
    id: 'I-LIFE-08',
    scenarioKey: 'daily_life',
    requires: [['被子']],
    optional: ['冷'],
    text: '帮我把被子盖好',
    prior: 0.56,
  },

  // ── 如厕护理 (S03) ─────────────────────────────────────────
  {
    id: 'I-TOILET-01',
    scenarioKey: 'toilet',
    requires: [['厕所', '小便', '大便']],
    optional: ['急', '帮忙'],
    text: '我要上厕所，很急',
    prior: 0.82,
  },
  {
    id: 'I-TOILET-02',
    scenarioKey: 'toilet',
    requires: [['尿不湿', '换']],
    optional: ['脏', '洗', '帮忙'],
    text: '帮我换一下尿不湿',
    prior: 0.76,
  },
  {
    id: 'I-TOILET-03',
    scenarioKey: 'toilet',
    requires: [['洗']],
    optional: ['擦', '脏'],
    text: '帮我洗一洗',
    prior: 0.60,
  },
  {
    id: 'I-TOILET-04',
    scenarioKey: 'toilet',
    requires: [['擦']],
    optional: ['洗', '脏'],
    text: '帮我擦一下',
    prior: 0.58,
  },
  {
    id: 'I-TOILET-05',
    scenarioKey: 'toilet',
    requires: [['脏']],
    optional: ['换', '洗'],
    text: '弄脏了，要换一下',
    prior: 0.64,
  },

  // ── 身体不适 (S04) ─────────────────────────────────────────
  {
    id: 'I-BODY-01',
    scenarioKey: 'body',
    requires: [['疼']],
    optional: ['头', '胸口', '肚子', '腿'],
    text: '我{部位}疼',
    prior: 0.80,
    slots: ['部位'],
  },
  {
    // 仅有「疼」+「部位」时优先正常表达；连点 ×3 才会被规则通道接管（R6-②）
    id: 'I-BODY-01b',
    scenarioKey: 'body',
    requires: [['疼'], ['头', '胸口', '肚子', '腿']],
    optional: [],
    text: '我{部位}疼，有点难受',
    prior: 0.74,
    slots: ['部位'],
  },
  {
    id: 'I-BODY-02',
    scenarioKey: 'body',
    requires: [['麻']],
    optional: ['腿', '手', '左', '右'],
    text: '我{方位}{部位}麻',
    prior: 0.74,
    slots: ['部位', '方位'],
  },
  {
    id: 'I-BODY-03',
    scenarioKey: 'body',
    requires: [['晕']],
    optional: ['头'],
    text: '我头晕',
    prior: 0.72,
  },
  {
    id: 'I-BODY-04',
    scenarioKey: 'body',
    requires: [['恶心']],
    optional: [],
    text: '我想吐，有点恶心',
    prior: 0.66,
  },
  {
    id: 'I-BODY-05',
    scenarioKey: 'body',
    requires: [['没力气']],
    optional: [],
    text: '我浑身没力气',
    prior: 0.64,
  },
  {
    id: 'I-BODY-06',
    scenarioKey: 'body',
    requires: [['痒']],
    optional: ['头', '腿'],
    text: '我{部位}痒',
    prior: 0.58,
    slots: ['部位'],
  },

  // ── 服药就医 (S05) ─────────────────────────────────────────
  {
    id: 'I-MED-01',
    scenarioKey: 'medication',
    requires: [['药', '吃药']],
    optional: ['几点', '饭前'],
    text: '我该几点吃药？',
    prior: 0.78,
  },
  {
    id: 'I-MED-02',
    scenarioKey: 'medication',
    requires: [['药', '吃药']],
    optional: ['水'],
    text: '我要吃药，帮我倒点水',
    prior: 0.74,
  },
  {
    id: 'I-MED-03',
    scenarioKey: 'medication',
    requires: [['忘吃药']],
    optional: ['药'],
    text: '我好像忘吃药了',
    prior: 0.70,
  },
  {
    id: 'I-MED-04',
    scenarioKey: 'medication',
    requires: [['量血压']],
    optional: [],
    text: '帮我量一下血压',
    prior: 0.68,
  },
  {
    id: 'I-MED-05',
    scenarioKey: 'medication',
    requires: [['医院', '复查']],
    optional: ['医生'],
    text: '我想去医院复查',
    prior: 0.66,
  },
  {
    id: 'I-MED-06',
    scenarioKey: 'medication',
    requires: [['医生', '护士']],
    optional: ['疼', '医院'],
    text: '我想找医生看看',
    prior: 0.62,
  },

  // ── 情感社交 (S06) ─────────────────────────────────────────
  {
    id: 'I-EMO-01',
    scenarioKey: 'emotion',
    requires: [['想你', '想']],
    optional: ['儿子', '闺女', '老伴'],
    text: '我想{称呼}了',
    prior: 0.78,
    slots: ['称呼'],
  },
  {
    id: 'I-EMO-02',
    scenarioKey: 'emotion',
    requires: [['烦']],
    optional: ['安静'],
    text: '我心里烦，想安静一会儿',
    prior: 0.70,
  },
  {
    id: 'I-EMO-03',
    scenarioKey: 'emotion',
    requires: [['安静']],
    optional: ['烦'],
    text: '我想静静，别吵我',
    prior: 0.68,
  },
  {
    id: 'I-EMO-04',
    scenarioKey: 'emotion',
    requires: [['高兴']],
    optional: [],
    text: '我今天挺高兴的',
    prior: 0.60,
  },
  {
    id: 'I-EMO-05',
    scenarioKey: 'emotion',
    requires: [['害怕']],
    optional: [],
    text: '我有点害怕',
    prior: 0.62,
  },
  {
    id: 'I-EMO-06',
    scenarioKey: 'emotion',
    requires: [['谢谢']],
    optional: [],
    text: '谢谢你',
    prior: 0.58,
  },
  {
    id: 'I-EMO-07',
    scenarioKey: 'emotion',
    requires: [['对不起']],
    optional: [],
    text: '对不起，麻烦你了',
    prior: 0.56,
  },

  // ── 休闲娱乐 (S07) ─────────────────────────────────────────
  {
    id: 'I-FUN-01',
    scenarioKey: 'leisure',
    requires: [['电视']],
    optional: ['戏曲', '换一个'],
    text: '我想看电视',
    prior: 0.72,
  },
  {
    id: 'I-FUN-02',
    scenarioKey: 'leisure',
    requires: [['戏曲']],
    optional: ['电视', '收音机'],
    text: '我想看戏曲频道',
    prior: 0.70,
  },
  {
    id: 'I-FUN-03',
    scenarioKey: 'leisure',
    requires: [['收音机']],
    optional: ['声音大', '声音小'],
    text: '帮我开一下收音机',
    prior: 0.64,
  },
  {
    id: 'I-FUN-04',
    scenarioKey: 'leisure',
    requires: [['声音大']],
    optional: ['电视', '收音机'],
    text: '声音开大一点',
    prior: 0.62,
  },
  {
    id: 'I-FUN-05',
    scenarioKey: 'leisure',
    requires: [['声音小']],
    optional: ['电视', '收音机'],
    text: '声音小一点',
    prior: 0.62,
  },
  {
    id: 'I-FUN-06',
    scenarioKey: 'leisure',
    requires: [['象棋']],
    optional: [],
    text: '我想下象棋',
    prior: 0.58,
  },
  {
    id: 'I-FUN-07',
    scenarioKey: 'leisure',
    requires: [['换一个']],
    optional: ['电视', '收音机'],
    text: '我不想看这个，换一个',
    prior: 0.60,
  },

  // ── 外出行动 (S08) ─────────────────────────────────────────
  {
    id: 'I-OUT-01',
    scenarioKey: 'outdoor',
    requires: [['轮椅']],
    optional: ['楼下', '晒太阳', '出去'],
    text: '我想坐轮椅下楼晒太阳',
    prior: 0.76,
  },
  {
    id: 'I-OUT-02',
    scenarioKey: 'outdoor',
    requires: [['晒太阳']],
    optional: ['轮椅', '楼下'],
    text: '我想出去晒太阳',
    prior: 0.70,
  },
  {
    id: 'I-OUT-03',
    scenarioKey: 'outdoor',
    requires: [['出去', '走走', '散步']],
    optional: ['楼下'],
    text: '我想出去走走',
    prior: 0.68,
  },
  {
    id: 'I-OUT-04',
    scenarioKey: 'outdoor',
    requires: [['回家']],
    optional: ['回来'],
    text: '我想回家了',
    prior: 0.64,
  },
  {
    id: 'I-OUT-05',
    scenarioKey: 'outdoor',
    requires: [['太累']],
    optional: ['轮椅', '走走'],
    text: '我太累了，歇一会儿',
    prior: 0.60,
  },
  {
    id: 'I-OUT-06',
    scenarioKey: 'outdoor',
    requires: [['推我']],
    optional: ['轮椅'],
    text: '推我一下',
    prior: 0.62,
  },
  {
    id: 'I-OUT-07',
    scenarioKey: 'outdoor',
    requires: [['菜市场']],
    optional: ['出去'],
    text: '我想去菜市场',
    prior: 0.58,
  },

  // ── 通讯联络 (S09) ─────────────────────────────────────────
  {
    id: 'I-COM-01',
    scenarioKey: 'communication',
    requires: [['打电话', '电话']],
    optional: ['儿子', '闺女', '老伴', '手机'],
    text: '帮我给{称呼}打电话',
    prior: 0.76,
    slots: ['称呼'],
  },
  {
    id: 'I-COM-02',
    scenarioKey: 'communication',
    requires: [['视频']],
    optional: ['儿子', '闺女', '老伴'],
    text: '我想跟{称呼}视频',
    prior: 0.72,
    slots: ['称呼'],
  },
  {
    id: 'I-COM-03',
    scenarioKey: 'communication',
    requires: [['接一下']],
    optional: ['电话', '手机'],
    text: '帮我接一下电话',
    prior: 0.66,
  },
  {
    id: 'I-COM-04',
    scenarioKey: 'communication',
    requires: [['挂断']],
    optional: ['电话'],
    text: '把电话挂了吧',
    prior: 0.60,
  },
  {
    id: 'I-COM-05',
    scenarioKey: 'communication',
    requires: [['发消息']],
    optional: ['手机', '儿子', '闺女'],
    text: '帮我发条消息',
    prior: 0.62,
  },
  {
    id: 'I-COM-06',
    scenarioKey: 'communication',
    requires: [['听不见']],
    optional: ['电话'],
    text: '我听不见，大声一点',
    prior: 0.64,
  },

  // ── 紧急求助 (S10) ── 规则通道，模板仅用于解释，不经模型排序 ──
  {
    // 紧急模板：规则通道决定是否触发（R6），此处仅在有明确紧急词时才参与候选
    id: 'I-EMG-01',
    scenarioKey: 'emergency',
    requires: [['疼得厉害', '救命']],
    optional: ['胸口', '头'],
    text: '我这里疼得厉害，快来人',
    prior: 1.0,
    emergency: true,
  },
  {
    id: 'I-EMG-02',
    scenarioKey: 'emergency',
    requires: [['跌倒了', '跌倒']],
    optional: [],
    text: '我跌倒了，快来帮我',
    prior: 1.0,
    emergency: true,
  },
  {
    id: 'I-EMG-03',
    scenarioKey: 'emergency',
    requires: [['喘不上气']],
    optional: [],
    text: '我喘不上气',
    prior: 1.0,
    emergency: true,
  },
  {
    id: 'I-EMG-04',
    scenarioKey: 'emergency',
    requires: [['救命', '来人']],
    optional: [],
    text: '救命，快来人',
    prior: 1.0,
    emergency: true,
  },
];

/** 场景先验基础表：场景 → 时间段的相对频率（0~1） */
export const SCENARIO_TIME_PRIOR = {
  daily_life: { morning: 0.9, noon: 0.4, afternoon: 0.5, evening: 0.9, night: 1.0 },
  food: { morning: 0.8, noon: 1.0, afternoon: 0.3, evening: 0.9, night: 0.1 },
  toilet: { morning: 0.9, noon: 0.6, afternoon: 0.6, evening: 0.7, night: 0.6 },
  body: { morning: 0.5, noon: 0.5, afternoon: 0.5, evening: 0.5, night: 0.7 },
  medication: { morning: 1.0, noon: 0.8, afternoon: 0.3, evening: 0.9, night: 0.4 },
  emotion: { morning: 0.4, noon: 0.4, afternoon: 0.5, evening: 0.6, night: 0.5 },
  leisure: { morning: 0.4, noon: 0.5, afternoon: 0.9, evening: 0.8, night: 0.2 },
  outdoor: { morning: 0.7, noon: 0.3, afternoon: 0.9, evening: 0.3, night: 0.05 },
  communication: { morning: 0.5, noon: 0.5, afternoon: 0.6, evening: 0.8, night: 0.3 },
  emergency: { morning: 0.5, noon: 0.5, afternoon: 0.5, evening: 0.5, night: 0.5 },
};

/** 时段推断：把小时映射到时段键 */
export function timeBucketOf(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 14) return 'noon';
  if (h >= 14 && h < 18) return 'afternoon';
  if (h >= 18 && h < 22) return 'evening';
  return 'night';
}

/** 身体部位词 —— 用于「部位 + 症状」组合（评测集 07/08 条） */
export const BODY_PARTS = ['头', '胸口', '肚子', '腿', '手', '腰', '背', '脚', '脖子'];

/** 方位词 —— 落到候选句里（评测集 08 条） */
export const DIRECTIONS = ['左', '右', '两边'];

/** 称呼词 —— 触发个性化映射（评测集 11/15/16 条） */
export const KINSHIP_WORDS = ['儿子', '闺女', '老伴', '女儿', '孙子', '老伴儿'];
