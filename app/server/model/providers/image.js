/**
 * 华为云文生图 Provider —— 意图的「图形化表达」兜底通道
 *
 * 【为什么需要它】
 * 失语症患者认图比认字容易。把候选意图画成图，患者指认的门槛会显著降低。
 * 但文生图有两个现实问题：慢（5~15s）、按张计费。
 * 因此本通道的定位是 **兜底**：优先用本地图标库（秒级、离线可用），
 * 只有图标库覆盖不到的场景才调它。这个决策由上层 visual.js 做，本文件只负责调通接口。
 *
 * 【接口事实】（来源：华为云 MaaS 官方文档 model-call-023，2026-09）
 *   endpoint : https://api.modelarts-maas.com/v1/images/generations
 *   认证     : Authorization: Bearer {API_KEY}（与 LLM 同一个 Key）
 *   model    : qwen-image（纯文生图）/ qwen-image-edit-2509（改图）
 *   请求体   : { model, prompt, size, response_format, seed, watermark }
 *   响应体   : b64_json（base64 图片数据）
 *   约束     : prompt ≤800 字符；size 宽高须被 8 整除；仅「西南-贵阳一」区域支持
 *
 * 【双区域说明】
 * LLM（chat）在中国香港可用，但文生图**仅支持西南-贵阳一**。
 * 所以 endpoint 与 API Key 都可独立配置：同一账号的两个区域 Key 不同是正常的。
 */

/** 文生图接口默认地址（仅西南-贵阳一区域可用） */
export const HW_IMAGE_DEFAULT_ENDPOINT = 'https://api.modelarts-maas.com/v1/images/generations';

/** prompt 上游限制 800 字符，留出安全余量 */
const PROMPT_MAX = 760;

export function createImageProvider(cfg = {}) {
  const endpoint = cfg.endpoint || process.env.HW_IMAGE_ENDPOINT || HW_IMAGE_DEFAULT_ENDPOINT;
  // 允许与 LLM 用不同的 Key（双区域账号常见）；缺省回落到 LLM 的 Key
  const apiKey =
    cfg.apiKey ||
    process.env.HW_IMAGE_API_KEY ||
    process.env.HW_MAAS_API_KEY ||
    process.env.HW_API_KEY ||
    '';
  const model = cfg.model || process.env.HW_IMAGE_MODEL || 'qwen-image';
  const size = cfg.size || process.env.HW_IMAGE_SIZE || '1024x1024';
  /** 文生图本身耗时较长，超时要给足；但不能无限等，患者端不能卡死 */
  const timeoutMs = Number(cfg.timeoutMs || process.env.HW_IMAGE_TIMEOUT_MS || 45000);

  return {
    id: 'huawei-image',

    available() {
      return Boolean(endpoint && apiKey);
    },

    /**
     * 生成一张图。
     * @param {object} args
     *   prompt: 中文提示词（会被截断到安全长度）
     * @returns {Promise<string|null>} base64（不含 data: 前缀）；失败返回 null
     *
     * 注意：**失败不抛异常，返回 null**。
     * 图片通道是增强而非主链路，它挂掉不该影响「候选 + 确认」这个核心机制。
     */
    async generate({ prompt }) {
      if (!this.available()) return null;

      const safePrompt = String(prompt || '').slice(0, PROMPT_MAX);
      if (!safePrompt.trim()) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            prompt: safePrompt,
            size,
            response_format: 'b64_json',
            seed: Math.floor(Math.random() * 2147483647),
            watermark: false, // 患者端界面不放「AI生成」水印，避免干扰指认
          }),
          signal: controller.signal,
        });

        if (!res.ok) return null;
        const data = await res.json();
        return extractB64(data);
      } catch {
        // 超时 / 网络 / 解析失败 —— 一律静默返回 null，交上层用图标兜底
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 从响应里取出 base64 图片数据。
 * 兼容 b64_json 与 url 两种返回形态（官方目前仅支持 b64_json）。
 */
export function extractB64(data) {
  const item = data?.data?.[0] || data?.images?.[0] || data?.result?.[0];
  if (!item) return null;

  const b64 = item.b64_json || item.image_base64 || item.b64;
  if (typeof b64 === 'string' && b64.length > 0) {
    // 剥离可能存在的 data URI 前缀，统一返回裸 base64
    return b64.replace(/^data:image\/\w+;base64,/, '');
  }
  return null;
}

/**
 * 构造给文生图的提示词。
 *
 * 关键：**画面要能承载意图，且不含文字/诊断信息**。
 * 提示词写成「患者视角的第一人称场景」，而非抽象概念 —— 图好认。
 */
export function buildImagePrompt({ text, scenario, icons = [] }) {
  const scene = scenarioNameMap[scenario] || '';
  const parts = [
    '简洁的扁平化插画，用于失语症患者沟通辅助，画面清晰易识别',
    scene ? `场景：${scene}` : '',
    `要表达的意思：${text}`,
    icons.length ? `包含元素：${icons.join('、')}` : '',
    '整体温暖柔和，单人主体，构图居中，不要出现任何文字、字母或数字',
  ];
  return parts.filter(Boolean).join('。');
}

/** 场景 key → 画面场景名的映射（供提示词使用）—— 与 scenarios.js 的 key 严格对齐 */
const scenarioNameMap = {
  daily_life: '居家日常',
  food: '饮食用餐',
  toilet: '如厕护理',
  body: '身体不适',
  medication: '服药就医',
  emotion: '情绪社交',
  leisure: '休闲娱乐',
  outdoor: '外出行动',
  communication: '通讯联络',
  emergency: '紧急求助',
};
