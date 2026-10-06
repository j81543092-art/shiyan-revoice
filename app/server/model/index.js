/**
 * ModelProvider 适配层 —— 意图理解的模型侧
 *
 * 三种实现，同一契约：
 *   - huawei    华为云 MaaS / ModelArts Studio（答辩正式环境）
 *   - openai    任意 OpenAI 兼容接口（联调过渡）
 *   - rule      内置规则引擎（零依赖兜底，无凭证也能跑通全链路与评测）
 *
 * 选择顺序：显式 MODEL_PROVIDER > 检测到凭证 > rule
 * 这样「现在跑得通、拿到凭证直接换」两件事同时成立。
 */

import { createHuaweiProvider, HW_MAAS_DEFAULT_ENDPOINT } from './providers/huawei.js';
import { createOpenAICompatProvider } from './providers/openai-compat.js';
import { createRuleProvider } from './providers/rule-engine.js';

export function createModelProvider(config = {}) {
  const explicit = config.provider || process.env.MODEL_PROVIDER || '';

  const registry = {
    huawei: () => createHuaweiProvider(config.huawei || {}),
    openai: () => createOpenAICompatProvider(config.openai || {}),
    rule: () => createRuleProvider(config.rule || {}),
  };

  if (explicit && registry[explicit]) {
    return { ...registry[explicit](), id: explicit };
  }

  // 自动探测：有华为云 MaaS 凭证优先，其次 OpenAI 兼容，最后规则引擎
  // 华为云凭证名以 HW_MAAS_API_KEY 为准（Bearer API Key，非 AK/SK）
  if (process.env.HW_MAAS_API_KEY || process.env.HW_API_KEY) {
    return { ...registry.huawei(), id: 'huawei', autoDetected: true };
  }
  if (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY) {
    return { ...registry.openai(), id: 'openai', autoDetected: true };
  }

  return { ...registry.rule(), id: 'rule', autoDetected: true };
}

export const PROVIDER_CONTRACT = `
interface ModelProvider {
  id: string
  // 输入：已构建好的 prompt（system + user）
  // 输出：严格符合契约的 JSON 对象（见 prompt.js 的 OUTPUT_SCHEMA）
  //       -> { emergency_hint, emergency_reason, candidates[], clarification{} }
  async infer({ system, user, meta }): Promise<object>
  // 该 provider 是否可用（凭证齐备 / 无需凭证）
  available(): boolean
}
`;

/**
 * 华为云接入说明（给 B 与答辩用）
 *
 * 只调「模型推理」接口，认证是 Bearer API Key，不是 AK/SK 签名：
 *   1. 登录华为云 ModelArts Studio（MaaS）控制台
 *   2. 「API Key 管理」创建 API Key（仅创建时显示一次，务必保存）
 *   3. 「预置服务」开通目标模型，状态显示「开通」
 *   4. 在该服务「调用说明」页复制 endpoint 与 model 参数
 *   5. 写入环境变量：
 *        HW_MAAS_API_KEY=<你的 API Key>
 *        HW_MODEL_ENDPOINT=https://api.modelarts-maas.com/v2/chat/completions
 *        HW_MODEL=<调用说明页的 model 参数，如 DeepSeek-V3>
 *   6. 启动即自动选用 huawei provider（也可显式 MODEL_PROVIDER=huawei）
 *
 * 注意：AK/SK（SDK-HMAC-SHA256 签名）用于管控面 API（开通服务、查配额等），
 * 与推理接口无关，本项目不需要。
 */
export const HUAWEI_MAAS_NOTES = {
  authType: 'Bearer API Key（非 AK/SK 签名）',
  endpoint: HW_MAAS_DEFAULT_ENDPOINT,
  envKeys: ['HW_MAAS_API_KEY', 'HW_MODEL_ENDPOINT', 'HW_MODEL'],
};
