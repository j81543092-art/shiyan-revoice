/**
 * 华为云 Provider —— 答辩正式环境（华为云 MaaS / ModelArts Studio）
 *
 * 【为什么是 Bearer API Key 而不是 AK/SK 签名】
 * 华为云上有两套完全不同的认证，早先的实现把这两者搞混了：
 *   - 管控面 API（开通服务、查配额、IAM 操作）→ AK/SK + SDK-HMAC-SHA256 签名
 *   - 模型推理 API（本文件要调的）→ 华为云 MaaS 的 Chat 接口，
 *     认证就是 `Authorization: Bearer {API_KEY}`，接口格式 OpenAI 兼容。
 * 我们只调推理接口，所以走 Bearer 即可。AK/SK 在这里没有用武之地。
 *
 * 【接口事实】（来源：华为云 MaaS 官方文档 + 社区对接指南，2026-10）
 *   endpoint : https://api.modelarts-maas.com/v2/chat/completions
 *   认证     : Authorization: Bearer {MAAS_API_KEY}
 *   请求体   : { model, messages[{role,content}], temperature, max_tokens, stream }
 *   响应体   : OpenAI 风格 —— choices[0].message.content
 *   API Key  : 在 MaaS 控制台「API Key 管理」创建，仅创建时显示一次
 *
 * 【契约】
 *   available()  —— 凭证齐备才为 true，否则上层自动降级规则引擎，演示不中断
 *   infer()      —— 返回严格符合 OUTPUT_SCHEMA 的 JSON 对象
 *
 * 依据《A 角色学习手册》链 4 与资源清单：赛题规定 AI 能力由华为云提供，
 * 不去碰 fine-tuning / RAG / Agent 框架 —— A 的战场在提示词与评测。
 */

/** 华为云 MaaS 推理接口默认地址（可在 MaaS 控制台「调用说明」核对） */
export const HW_MAAS_DEFAULT_ENDPOINT = 'https://api.modelarts-maas.com/v2/chat/completions';

export function createHuaweiProvider(cfg = {}) {
  const endpoint =
    cfg.endpoint || process.env.HW_MODEL_ENDPOINT || HW_MAAS_DEFAULT_ENDPOINT;
  const apiKey =
    cfg.apiKey ||
    process.env.HW_MAAS_API_KEY ||
    process.env.HW_API_KEY ||
    '';
  // model 参数取自 MaaS 控制台「调用说明」页，不同模型系列名字不同。
  // ⚠️ 默认值不再是 'DeepSeek-V3' —— 实测本账号不存在该模型（404 ModelArts.81009）。
  // 默认值只能选一个「大概率存在」的，但真正可靠的做法是显式配置 HW_MODEL。
  const model = cfg.model || process.env.HW_MODEL || 'deepseek-v4.1-flash';
  const maxTokens = Number(cfg.maxTokens || process.env.HW_MAX_TOKENS || 1024);
  // 真实模型偶发慢（实测 2.7~5s，但有过 >30s 的情况）。
  // 超时过短会导致静默降级到规则引擎，评测结果失真且看不出原因 —— 给足余量。
  const timeoutMs = Number(cfg.timeoutMs || process.env.HW_TIMEOUT_MS || 45000);
  // 重试次数：只在「超时/网络错误」时重试，401/403/404 这类确定性错误不重试
  // （重试无意义，只会拖慢演示）。1 次重试即可覆盖绝大多数偶发抖动。
  const maxRetries = Number(cfg.maxRetries || process.env.HW_MAX_RETRIES || 1);

  return {
    id: 'huawei',

    available() {
      return Boolean(endpoint && apiKey);
    },

    async infer({ system, user }) {
      if (!this.available()) {
        throw new Error(
          '[huawei] 缺少凭证：请配置 HW_MAAS_API_KEY（华为云 MaaS 控制台「API Key 管理」创建），' +
            '可选 HW_MODEL_ENDPOINT / HW_MODEL；或改用 rule provider',
        );
      }

      const body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // 意图理解要稳不要创意；但部分模型不接受过低的 temperature，0.2 是安全值
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false,
      };

      // ── 带重试的请求 ──
      // 只重试「超时 / 网络抖动」这类**瞬时**故障；
      // 401/403/404 是确定性错误，重试纯属浪费患者时间，直接抛出。
      let lastErr = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // 每次重试都需新的 controller —— 旧的 abort 后不可复用
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          clearTimeout(timer);
          return await handleResponse(res);
        } catch (err) {
          clearTimeout(timer);
          const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError';
          const isRetryable = isTimeout || /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(err?.message || ''));
          lastErr = isTimeout
            ? new Error(`[huawei] 请求超时（${timeoutMs}ms，第 ${attempt + 1} 次）`)
            : new Error(`[huawei] 网络错误：${err?.message || err}`);
          if (!isRetryable || attempt === maxRetries) break;
          // 短暂退避后重试，避免连续打满对方的限流
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      throw lastErr || new Error('[huawei] 调用失败且无错误详情');

      /** 把响应转成严格 JSON —— 错误分流在这里统一处理 */
      async function handleResponse(res) {
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          // 区分「凭证错」与「服务侧问题」，便于排障
          const hint =
            res.status === 401 || res.status === 403
              ? '（API Key 无效／无该模型权限／模型未在「预置服务」开通 —— 到 MaaS 控制台核对）'
              : res.status === 429
                ? '（触发限流，已在 MaaS 控制台配置 QPS）'
                : res.status === 404
                  ? '（model 名不存在 —— 核对「调用说明」页的 model 参数）'
                  : '';
          throw new Error(`[huawei] HTTP ${res.status} ${detail.slice(0, 300)} ${hint}`.trim());
        }
        const data = await res.json();
        return parseStrictJSON(data);
      }
    },
  };
}

/**
 * 从响应里取出严格 JSON（模型可能包一层 markdown fence，做一次容错剥离）。
 * 输出结构契约见 prompt.js 的 OUTPUT_SCHEMA。
 *
 * 依次尝试：OpenAI 风格 choices → 华为云 result → 裸 content → 整个对象
 */
export function parseStrictJSON(data) {
  const raw =
    data?.choices?.[0]?.message?.content ??
    data?.result?.content ??
    data?.content ??
    (typeof data === 'string' ? data : JSON.stringify(data));

  return extractJSON(raw);
}

/** 剥离 ```json fence 与前后杂文字，只留第一个完整 JSON 对象 */
export function extractJSON(raw) {
  if (typeof raw === 'object' && raw !== null) return raw;
  const text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('[model] 响应中找不到 JSON 对象');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
