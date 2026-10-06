/**
 * 语音适配层 —— 与 model/index.js 同一套思路
 *
 * 对外只暴露一个 createSpeechRecognizer()，上层不关心背后是
 * 华为云 SIS 还是别的实现，也不关心 Token 怎么来的。
 *
 * 无凭证时 available() 为 false，上层自动跳过语音、只用图标与文字线索 —— 演示不中断。
 */

import { createSpeechProvider, splitFragments } from './providers/speech.js';
import { createIamTokenManager } from './providers/iam.js';

export function createSpeechRecognizer(config = {}) {
  const iam = createIamTokenManager(config.iam || {});
  const speech = createSpeechProvider(config.speech || {});

  // 把 Token 来源接上（speech 只依赖「一个返回 Token 的函数」这个契约）
  speech.setTokenProvider(() => iam.getToken());

  return {
    id: 'huawei-sis',
    iam,
    speech,

    available() {
      return speech.available() && iam.available();
    },

    /**
     * 识别一段语音并切成线索碎片。
     *
     * @returns {Promise<{text, fragments, ok:boolean, reason?:string}>}
     *   永远不抛异常 —— 语音是线索来源之一，不是唯一来源，失败就让位给图标
     */
    async transcribe({ audioBase64, audioFormat = 'wav' } = {}) {
      if (!iam.available()) {
        return { ok: false, reason: 'IAM 凭证未配置（需要 HW_IAM_USERNAME / HW_IAM_PASSWORD / HW_IAM_DOMAIN）', text: '', fragments: [] };
      }
      if (!speech.available()) {
        return { ok: false, reason: 'SIS 未配置（需要 HW_PROJECT_ID，以及 HW_SIS_REGION 或 HW_SIS_ENDPOINT）', text: '', fragments: [] };
      }

      const result = await speech.recognize({ audioBase64, audioFormat });
      if (!result) {
        // 识别失败：可能是网络、Token、音频格式、或确实没听清
        return { ok: false, reason: '识别未返回结果（音频格式不支持 / Token 失效 / 未听清）', text: '', fragments: [] };
      }

      return {
        ok: true,
        text: result.text,
        fragments: splitFragments(result.text),
        raw: result.raw,
      };
    },

    status() {
      return {
        available: this.available(),
        iam: iam.status(),
        property: process.env.HW_SIS_PROPERTY || 'chinese_16k_general',
        region: process.env.HW_SIS_REGION || 'cn-north-4',
      };
    },
  };
}

export { splitFragments };
