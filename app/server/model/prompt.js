/**
 * prompt v1 与版本库 —— 交付物四
 *
 * 三段式：角色与任务 → 硬约束 → 输出格式。
 * v1 的目标不是高分，是跑出第一组真实数字（Top-3 命中率 + 平均澄清轮次），哪怕只有 30%。
 *
 * 本文件是 prompt 的单一维护点：A 改 prompt 只改这里，版本记录进 versions/。
 */

/** 输出结构契约 —— 跨前后端接口，三方当面敲定后冻结（见《手册》第十章 A→C） */
export const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['emergency_hint', 'candidates', 'clarification'],
  properties: {
    emergency_hint: 'boolean — 涉紧急信号时置 true（是否触发由规则层决定，模型不越权）',
    emergency_reason: 'string',
    candidates: 'array<{ text, model_confidence, matched_clues[], rationale }>',
    clarification: '{ needed: boolean, type: "yes_no"|"either_or"|null, question: string, options: string[] }',
  },
};

/** prompt v1 全文 —— 与《拾言-A阶段0交付物包-v1》交付物四完全一致 */
export const PROMPT_V1 = {
  version: 'v1',
  date: '2026-10-05',
  system: `【角色】你是失语症沟通辅助系统的意图理解模块。你的任务不是替患者说话，而是根据患者提供的残缺线索，生成 3~5 个候选意图，交由患者本人确认。

【输入】JSON：
{
  "scenario": "当前场景（如 饮食/起居/通讯，可能为空）",
  "time_context": "时段与作息上下文（如 午后，患者通常此时下楼）",
  "icons": ["患者点选的图标 id 列表"],
  "keywords": ["患者输入的关键词（可能残缺、电报式）"],
  "voice_fragments": ["语音碎片（识别可能不准，仅供参考）"],
  "user_profile": {"preferred_words": [], "caregiver_names": {}, "routine": []},
  "recent_confirmed": ["最近 3 条已确认的表达"]
}

【硬约束】
1. 输出 3~5 个候选，按置信度降序；候选之间必须有区分度，禁止同义重复。
2. 候选为第一人称口语短句，每句 ≤15 字；禁止医学诊断措辞；
   禁止臆造线索中不存在的人名、药名、具体对象。
3. 凑不出 2 个有区分度的候选时，改为输出澄清请求，不硬凑。
4. 澄清策略：top1 置信 <0.6 → 输出 yes_no 澄清（针对 top1）；
   前两名差值 <0.1 → 输出 either_or 澄清；其余不澄清。澄清最多 2 轮。
5. 个性化：user_profile 中的称呼与常用词优先；
   线索出现称呼词（如「小王」）时解释为「叫某人来 / 与某人联络」。
6. 涉紧急信号（剧烈疼痛 / 跌倒 / 呼吸困难 / 呼救）时置 emergency_hint=true
   并给出理由；是否触发紧急通道由规则层决定，你不做最终决定。
7. 每个候选须给出 matched_clues（它解释了哪些线索）和 ≤20 字 rationale，
   供排序层计算线索覆盖度。没有证据支撑的候选不得输出。

【输出】严格 JSON，不要输出任何多余文字：
{
  "emergency_hint": false,
  "emergency_reason": "",
  "candidates": [
    {"text": "", "model_confidence": 0.0, "matched_clues": [], "rationale": ""}
  ],
  "clarification": {"needed": false, "type": null, "question": "", "options": []}
}`,

  fewShot: [
    {
      label: '示例 1（常规出候选）',
      input: { scenario: '饮食', icons: ['饭', '水'], keywords: ['饿'], voice_fragments: [] },
      output: {
        emergency_hint: false,
        emergency_reason: '',
        candidates: [
          { text: '我饿了，想吃饭', model_confidence: 0.86, matched_clues: ['饭', '饿'], rationale: '饭+饿直接指向进食' },
          { text: '我想吃饭，再喝点水', model_confidence: 0.71, matched_clues: ['饭', '水', '饿'], rationale: '覆盖全部线索' },
          { text: '我渴了，想喝水', model_confidence: 0.34, matched_clues: ['水'], rationale: '仅解释水，饿未覆盖' },
        ],
        clarification: { needed: false, type: null, question: '', options: [] },
      },
    },
    {
      label: '示例 2（触发澄清）',
      input: { scenario: '起居', icons: ['水'], keywords: [], voice_fragments: [] },
      output: {
        emergency_hint: false,
        emergency_reason: '',
        candidates: [
          { text: '我想喝水', model_confidence: 0.52, matched_clues: ['水'], rationale: '单一线索，置信不足' },
        ],
        clarification: { needed: true, type: 'yes_no', question: '想喝水吗？', options: ['是', '不是'] },
      },
    },
  ],
};

/** 构建发给模型的 user 消息 —— 把线索与画像序列化 */
export function buildUserMessage({ scenario, timeContext, clues = {}, profile, recentConfirmed = [] }) {
  return JSON.stringify(
    {
      scenario: scenario || '',
      time_context: timeContext || '',
      icons: clues.icons || [],
      keywords: clues.keywords || [],
      voice_fragments: clues.voiceFragments || [],
      user_profile: {
        preferred_words: profile?.preferredWords || [],
        caregiver_names: profile?.caregiverNames || {},
        routine: profile?.routine || [],
      },
      recent_confirmed: recentConfirmed,
    },
    null,
    0,
  );
}

/** few-shot 拼接：作为 system 的补充段一并送出 */
export function buildSystemWithFewShot(prompt = PROMPT_V1) {
  const shots = prompt.fewShot
    .map((s) => `${s.label}\n输入：${JSON.stringify(s.input)}\n输出：${JSON.stringify(s.output)}`)
    .join('\n\n');
  return `${prompt.system}\n\nfew-shot 示例（随 prompt 一起提交，${prompt.fewShot.length} 条）\n\n${shots}`;
}
