/**
 * 语音识别 Provider —— 华为云 SIS 一句话识别（把「说不清的话」变成线索）
 *
 * 【为什么这是第一步，不是补充】
 * 失语症患者最典型的困境是：听得懂一切、想得明白，就是说不成句。
 * 他说出来的往往是断断续续的词：「水……那个……喝」。
 * 所以语音**不是**锦上添花的补充输入，而是最贴近患者真实表达方式的第一手线索。
 * 图标是后来加上去降低门槛的，语音才是他本来的出口。
 *
 * 【接口事实】（来源：华为云 SIS 官方文档，2026-02）
 *   endpoint : https://sis-ext.cn-north-4.myhuaweicloud.com    （华北-北京四）
 *              https://sis-ext.cn-east-3.myhuaweicloud.com     （华东-上海一）
 *   URI      : POST /v1/{project_id}/asr/short-audio
 *   认证     : X-Auth-Token: {TOKEN}   ← 注意：不是 Bearer API Key
 *   Token    : 需先用 AK/SK 或用户名密码换取（见 iam.js），有效期 24 小时
 *   请求体   : { config: { audio_format, property, add_punc }, data: "<base64 音频>" }
 *   响应体   : { result: { words: "识别出的文本" } }
 *   限制     : 音频 ≤1 分钟、Base64 后 ≤4MB；**仅支持北京/上海区域**
 *
 * 【关键设计：容忍识别不准】
 * SIS 对失语症患者的断续发音识别率必然不高 —— 这是客观现实，不是 bug。
 * 因此本 provider 的处理原则是：
 *   1. 识别结果**不做校正、不做补全**，原样交给上层
 *   2. 失败返回 null，上层降级为「只用图标线索」，不阻断表达
 *   3. 上层 prompt 已声明「语音碎片（识别可能不准，仅供参考）」，模型会自行斟酌
 * 换句话说：**不假装识别得准，而是让整条链路容忍不准**。
 */

/** 支持一句话识别的区域（官方明确只有这两个） */
export const SIS_ENDPOINTS = {
  'cn-north-4': 'https://sis-ext.cn-north-4.myhuaweicloud.com',
  'cn-east-3': 'https://sis-ext.cn-east-3.myhuaweicloud.com',
};

/** 音频格式支持范围（官方 audio_format 取值范围） */
export const SUPPORTED_AUDIO_FORMATS = [
  'pcm16k16bit', 'pcm8k16bit', 'ulaw16k8bit', 'ulaw8k8bit',
  'alaw16k8bit', 'alaw8k8bit', 'mp3', 'aac', 'wav', 'amr', 'amrwb', 'auto',
];

export function createSpeechProvider(cfg = {}) {
  const region = cfg.region || process.env.HW_SIS_REGION || 'cn-north-4';
  const endpoint =
    cfg.endpoint || process.env.HW_SIS_ENDPOINT || SIS_ENDPOINTS[region] || SIS_ENDPOINTS['cn-north-4'];
  const projectId = cfg.projectId || process.env.HW_PROJECT_ID || '';
  /** 语言模型特征串：语种_采样率_领域 */
  const property = cfg.property || process.env.HW_SIS_PROPERTY || 'chinese_16k_general';
  const addPunc = cfg.addPunc ?? (process.env.HW_SIS_ADD_PUNC ?? 'no') === 'yes';
  const timeoutMs = Number(cfg.timeoutMs || process.env.HW_SIS_TIMEOUT_MS || 20000);

  /**
   * Token 由外部注入（iam.js 换取并缓存）。
   * 本 provider 不自己管 Token 生命周期 —— 单一职责，也便于测试时注入假 Token。
   */
  let tokenProvider = cfg.tokenProvider || null;

  return {
    id: 'huawei-sis',

    /** 注入/替换 Token 提供者（供 iam.js 装配） */
    setTokenProvider(fn) {
      tokenProvider = fn;
    },

    /** 是否有能力调用：endpoint + projectId + 有 Token 来源 */
    available() {
      return Boolean(endpoint && projectId && tokenProvider);
    },

    /**
     * 识别一段短语音。
     *
     * @param {object} args
     *   audioBase64: 音频的裸 base64（不含 data: 前缀 —— 带前缀会报错）
     *   audioFormat: 音频格式，默认 wav
     * @returns {Promise<{text: string, raw: object}|null>} 失败返回 null，不抛异常
     *
     * 注意：**失败静默返回 null**。
     * 语音识别挂掉时，患者还可以用图标表达；核心「候选 + 确认」机制不受影响。
     */
    async recognize({ audioBase64, audioFormat = 'wav' } = {}) {
      if (!this.available()) return null;

      const data = stripDataUri(audioBase64);
      if (!data) return null;
      // 官方硬限制：base64 后 ≤4MB，超了直接放弃而不是等它报错
      if (data.length > 4 * 1024 * 1024) return null;

      // 格式白名单：SIS 对不支持的格式会报错，先挡一层
      const fmt = SUPPORTED_AUDIO_FORMATS.includes(audioFormat) ? audioFormat : 'auto';

      let token;
      try {
        token = await tokenProvider();
      } catch {
        return null;
      }
      if (!token) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(`${endpoint}/v1/${projectId}/asr/short-audio`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': token,
          },
          body: JSON.stringify({
            config: {
              audio_format: fmt,
              property,
              add_punc: addPunc ? 'yes' : 'no',
            },
            data,
          }),
          signal: controller.signal,
        });

        if (!res.ok) return null;
        const payload = await res.json();
        return normalizeResult(payload);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 归一化 SIS 响应。
 * 成功：{ result: { words: "文本" } }
 * 失败：{ error_code, error_msg }
 *
 * 返回 null 表示「没有可用识别结果」，让上层决定怎么办。
 */
export function normalizeResult(payload) {
  if (!payload || payload.error_code) return null;
  const text = payload?.result?.words ?? payload?.result?.text ?? '';
  const cleaned = String(text).trim();
  if (!cleaned) return null;
  return { text: cleaned, raw: payload.result };
}

/**
 * 剥离 base64 的 data URI 前缀。
 * 官方明确说明：携带 `data:audio/mp3;base64,` 类前缀会产生报错。
 */
export function stripDataUri(input) {
  if (!input || typeof input !== 'string') return '';
  return input.replace(/^data:audio\/[\w.+-]+;base64,/, '').trim();
}

/**
 * 把识别文本切成「语音碎片」。
 *
 * 为什么不直接整句塞进去？
 * 患者在澄清环节往往一次只蹦一两个词，而 SIS 可能把停顿合并成一句。
 * 切成碎片更贴近 prompt 里 voice_fragments 的语义（「碎片」本就是断续的），
 * 也让线索覆盖度的计算更细腻。
 *
 * 切分策略：先按标点切，过长（>12 字）再按停顿词/连词二次切。
 */
export function splitFragments(text, maxLen = 12) {
  const s = String(text || '').trim();
  if (!s) return [];

  const byPunc = s
    .split(/[，。！？、；：,\.!\?;:]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  for (const piece of byPunc) {
    if (piece.length <= maxLen) {
      out.push(piece);
      continue;
    }
    // 二次切分：在常见停顿/连接词处断开，保留语义边界
    const parts = piece
      .split(/(?:然后|那个|就是|这个|嗯|呃|然后呢)/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const p of parts) {
      if (p.length <= maxLen) out.push(p);
      else for (let i = 0; i < p.length; i += maxLen) out.push(p.slice(i, i + maxLen));
    }
  }
  return out.length ? out : [s];
}
