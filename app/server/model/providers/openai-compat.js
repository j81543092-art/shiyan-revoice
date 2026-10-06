/**
 * OpenAI 兼容 Provider —— 联调过渡用
 *
 * 任何提供 /chat/completions 的服务都能接（含本地 vLLM / Ollama / 各类中转）。
 * 用途：在华为云凭证到位前，先验证 prompt v1 的真实表现、跑出第一组数字。
 */

import { extractJSON } from './huawei.js';

export function createOpenAICompatProvider(cfg = {}) {
  const baseUrl = (cfg.baseUrl || process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
  const model = cfg.model || process.env.LLM_MODEL || 'gpt-4o-mini';

  return {
    id: 'openai',

    available() {
      return Boolean(apiKey);
    },

    async infer({ system, user }) {
      if (!this.available()) {
        throw new Error('[openai] 缺少 OPENAI_API_KEY / LLM_API_KEY');
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });

      if (!res.ok) {
        throw new Error(`[openai] HTTP ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return extractJSON(data?.choices?.[0]?.message?.content ?? data);
    },
  };
}
