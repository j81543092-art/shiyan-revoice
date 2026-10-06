/**
 * 评测集 v1 —— 交付物三（20 条）
 *
 * 每条带五样：场景 / 线索组合 / 标准答案 / 等价说法 / 应触发澄清。
 * 覆盖 10 场景 × 2 条；线索类型混合（纯图标、图标+关键词、图标+语音碎片）；
 * 含 2 条紧急规则、2 条个性化、4 条澄清。
 *
 * 判中口径：模型输出的任一候选与标准答案或任一等价说法语义一致，记一次命中。
 * 「没有等价说法就没法判命中——语言有歧义，这是评测集最容易被漏掉的一列。」
 *
 * 扩充路线：第 4 周 50 条 → 六周内 80 条。
 */

export const EVAL_SET_V1 = [
  {
    id: 'E01', scenarioKey: 'food', scenarioName: '饮食',
    clueType: 'icon+keyword',
    clues: { icons: ['饭', '水'], keywords: ['饿'], voiceFragments: [] },
    answer: '我饿了，想吃饭，再喝点水',
    equivalents: ['我要吃饭', '饿了先吃饭', '我饿了，想吃饭'],
    expectClarify: false,
    focus: '图标 + 关键词基础融合',
  },
  {
    id: 'E02', scenarioKey: 'food', scenarioName: '饮食',
    clueType: 'icon+voice',
    clues: { icons: ['水'], keywords: [], voiceFragments: ['喝', '喝'] },
    answer: '我想喝水',
    equivalents: ['给我水', '口渴了', '我渴了'],
    expectClarify: false,
    focus: '语音碎片与图标互证',
  },
  {
    id: 'E03', scenarioKey: 'daily_life', scenarioName: '起居',
    clueType: 'icon+keyword',
    clues: { icons: ['睡觉'], keywords: ['困'], voiceFragments: [] },
    answer: '我困了，想睡觉',
    equivalents: ['想睡觉', '我要睡了'],
    expectClarify: false,
    focus: '近义表达归并（困 = 想睡）',
  },
  {
    id: 'E04', scenarioKey: 'daily_life', scenarioName: '起居',
    clueType: 'icon+voice',
    clues: { icons: ['开灯', '睡觉'], keywords: [], voiceFragments: ['关'] },
    answer: '我要睡觉了，请关灯',
    equivalents: ['把灯关了', '关灯睡觉'],
    expectClarify: false,
    focus: '双图标的动作 + 对象关系',
  },
  {
    id: 'E05', scenarioKey: 'toilet', scenarioName: '如厕',
    clueType: 'icon+keyword',
    clues: { icons: ['厕所'], keywords: ['急'], voiceFragments: [] },
    answer: '我要上厕所，很急',
    equivalents: ['快，上厕所', '憋不住了'],
    expectClarify: false,
    focus: '紧迫度进入候选措辞',
  },
  {
    id: 'E06', scenarioKey: 'toilet', scenarioName: '如厕',
    clueType: 'low-confidence',
    clues: { icons: ['厕所', '换'], keywords: [], voiceFragments: [] },
    answer: '（应触发澄清，不出候选）',
    equivalents: [],
    expectClarify: true,
    expectClarifyType: 'yes_no',
    focus: '线索不足不硬猜',
  },
  {
    id: 'E07', scenarioKey: 'body', scenarioName: '身体',
    clueType: 'pure-icon',
    clues: { icons: ['疼', '头'], keywords: [], voiceFragments: [] },
    answer: '我头疼',
    equivalents: ['头很疼', '我头痛'],
    expectClarify: false,
    focus: '症状 + 部位组合',
  },
  {
    id: 'E08', scenarioKey: 'body', scenarioName: '身体',
    clueType: 'icon+keyword',
    clues: { icons: ['麻', '腿'], keywords: ['左'], voiceFragments: [] },
    answer: '我左腿麻',
    equivalents: ['左边腿麻', '左腿发麻'],
    expectClarify: false,
    focus: '方位词落到句子里',
  },
  {
    id: 'E09', scenarioKey: 'medication', scenarioName: '服药',
    clueType: 'icon+keyword',
    clues: { icons: ['药'], keywords: ['几点'], voiceFragments: [] },
    answer: '我该几点吃药？',
    equivalents: ['什么时候吃药', '到吃药时间了吗'],
    expectClarify: false,
    focus: '疑问意图（不是陈述）',
  },
  {
    id: 'E10', scenarioKey: 'medication', scenarioName: '服药',
    clueType: 'icon+voice',
    clues: { icons: ['药', '水'], keywords: [], voiceFragments: ['吃', '药'] },
    answer: '我要吃药，帮我倒点水',
    equivalents: ['吃药，给水', '该吃药了'],
    expectClarify: false,
    focus: '碎片 + 图标互证',
  },
  {
    id: 'E11', scenarioKey: 'emotion', scenarioName: '情感',
    clueType: 'icon+keyword+name',
    clues: { icons: ['想你'], keywords: ['想', '儿子'], voiceFragments: [] },
    answer: '我想儿子了',
    equivalents: ['想儿子', '让儿子来看看我'],
    expectClarify: false,
    focus: '称呼进入意图',
  },
  {
    id: 'E12', scenarioKey: 'emotion', scenarioName: '情感',
    clueType: 'icon+voice',
    clues: { icons: ['烦'], keywords: [], voiceFragments: ['别', '别'] },
    answer: '我心里烦，想安静一会儿',
    equivalents: ['别吵我', '我想静静'],
    expectClarify: true,
    expectClarifyType: 'either_or',
    clarificationOptions: ['想安静', '不想见人'],
    focus: '情绪类候选难分，考察澄清',
  },
  {
    id: 'E13', scenarioKey: 'leisure', scenarioName: '娱乐',
    clueType: 'icon+keyword',
    clues: { icons: ['电视'], keywords: ['戏'], voiceFragments: [] },
    answer: '我想看戏曲频道',
    equivalents: ['看戏', '调到戏曲台'],
    expectClarify: false,
    focus: '常用词映射（戏 = 戏曲频道）',
  },
  {
    id: 'E14', scenarioKey: 'outdoor', scenarioName: '外出',
    clueType: 'icon+keyword',
    clues: { icons: ['轮椅', '晒太阳'], keywords: ['楼下'], voiceFragments: [] },
    answer: '我想坐轮椅下楼晒太阳',
    equivalents: ['下楼转转', '推我下去晒太阳'],
    expectClarify: false,
    focus: '作息偏好加权（午后外出习惯）',
  },
  {
    id: 'E15', scenarioKey: 'communication', scenarioName: '通讯',
    clueType: 'icon+name',
    clues: { icons: ['打电话'], keywords: ['闺女'], voiceFragments: [] },
    answer: '帮我给闺女打电话',
    equivalents: ['打给闺女', '我要跟闺女通话'],
    expectClarify: false,
    focus: '个性化称呼映射',
  },
  {
    id: 'E16', scenarioKey: 'communication', scenarioName: '通讯',
    clueType: 'icon+caregiver-name',
    clues: { icons: ['视频'], keywords: ['小王'], voiceFragments: [] },
    answer: '叫小王来，我想跟他视频',
    equivalents: ['找小王视频', '让小王开视频'],
    expectClarify: false,
    focus: '护理者称呼（家属配置词生效）',
    profile: { caregiverNames: { 小王: '护工王姐' } },
  },
  {
    id: 'E17', scenarioKey: 'emergency', scenarioName: '紧急',
    clueType: 'rule-channel',
    clues: { icons: ['疼', '胸口'], keywords: [], voiceFragments: [], repeatCounts: { 疼: 3 } },
    answer: '（规则触发紧急通道，不出候选）',
    equivalents: [],
    expectEmergency: true,
    focus: '零模型依赖，直接通知家属端',
  },
  {
    id: 'E18', scenarioKey: 'emergency', scenarioName: '紧急',
    clueType: 'rule-channel',
    clues: { icons: ['跌倒了'], keywords: [], voiceFragments: ['啊'] },
    answer: '（规则触发紧急通道）',
    equivalents: [],
    expectEmergency: true,
    focus: '「跌倒」是一级紧急词',
  },
  {
    id: 'E19', scenarioKey: 'food', scenarioName: '澄清',
    clueType: 'single-clue',
    clues: { icons: ['水'], keywords: [], voiceFragments: [] },
    answer: '（触发澄清，不硬出候选）',
    equivalents: [],
    expectClarify: true,
    expectClarifyType: 'yes_no',
    focus: '单线索低置信，走 R4①',
  },
  {
    id: 'E20', scenarioKey: 'leisure', scenarioName: '澄清',
    clueType: 'fuzzy-keyword',
    clues: { icons: ['电视', '睡觉'], keywords: ['那个'], voiceFragments: [] },
    answer: '（触发澄清）',
    equivalents: [],
    expectClarify: true,
    expectClarifyType: 'either_or',
    focus: '前两名接近，走 R4②',
  },
];

/** 失败 case 五类归因 —— 每条归因对应一次 prompt 改动 */
export const FAILURE_TAXONOMY = {
  CLUE_LOST: '线索丢失',
  OVER_ASSERTIVE: '输出武断',
  NO_DISTINCTION: '候选无区分度',
  MISSED_CLARIFY: '该澄清没澄清',
  COMMON_SENSE: '常识错误',
};

export const FAILURE_TAXONOMY_LIST = Object.values(FAILURE_TAXONOMY);

export const EVAL_STATS_V1 = {
  total: EVAL_SET_V1.length,
  scenarios: 10,
  emergencyCases: EVAL_SET_V1.filter((e) => e.expectEmergency).length,
  clarifyCases: EVAL_SET_V1.filter((e) => e.expectClarify).length,
  personalizedCases: EVAL_SET_V1.filter((e) => e.profile).length,
};
