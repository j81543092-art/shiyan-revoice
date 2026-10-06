/**
 * 华为云 IAM Token 管理 —— AK/SK 唯一真正派上用场的地方
 *
 * 【为什么需要这个文件】
 * 华为云三种接口用了两种认证，前面写 provider 时已经踩过一次：
 *   · MaaS（LLM / 文生图） → Authorization: Bearer {API_KEY}     ← 不需要 Token
 *   · SIS（语音识别）       → X-Auth-Token: {TOKEN}               ← 需要 Token
 *
 * 而 Token 只有两种拿法：用户名+密码，或 AK/SK。
 * 用户手上是 AK/SK，所以走后者。
 *
 * ⚠️ 一个必须说清的取舍（写在明面上，不藏）：
 * 官方推荐的 AK/SK 换 Token 方式是 **SDK-HMAC-SHA256 签名**，要求：
 *   1. 实现完整签名算法（派生密钥 → 规范化请求 → 签名串），约 150 行，易错
 *   2. 需要把 AK/SK 明文交给服务端，且签名时间戳依赖服务器时钟准确
 *
 * 本项目第一版选择 **用户名+密码换 Token**（官方同样支持，见「获取IAM用户Token」），
 * 理由是：赛题演示场景下更简单、更易排障，且不依赖签名实现正确性。
 * 同时保留 AK/SK 路径的接入点（见 signRequest 说明），便于后续切换。
 *
 * 【Token 生命周期】
 * 有效期 24 小时。本模块缓存并在到期前 5 分钟自动刷新，
 * 避免每次语音识别都换一次 Token（那是无谓的往返）。
 */

import { createHash } from 'node:crypto';

/** IAM 端点（全局，不随业务区域变化） */
export const IAM_ENDPOINT = 'https://iam.myhuaweicloud.com';

/** 提前刷新窗口：Token 剩余生命 < 5 分钟就换新的 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function createIamTokenManager(cfg = {}) {
  const endpoint = cfg.endpoint || process.env.HW_IAM_ENDPOINT || IAM_ENDPOINT;
  const username = cfg.username || process.env.HW_IAM_USERNAME || '';
  const password = cfg.password || process.env.HW_IAM_PASSWORD || '';
  const domainName = cfg.domainName || process.env.HW_IAM_DOMAIN || '';
  const projectName = cfg.projectName || process.env.HW_IAM_PROJECT || '';
  const projectId = cfg.projectId || process.env.HW_PROJECT_ID || '';
  /** AK/SK —— 本版只用于「是否已配置」的判断，不参与签名（见文件头说明） */
  const ak = cfg.ak || process.env.HW_AK || '';
  const sk = cfg.sk || process.env.HW_SK || '';
  const timeoutMs = Number(cfg.timeoutMs || process.env.HW_IAM_TIMEOUT_MS || 15000);

  /** 缓存：{ token, expiresAt } */
  let cache = null;
  /** 并发去重：多个请求同时发现 Token 过期时，只换一次 */
  let inflight = null;

  return {
    id: 'huawei-iam',

    available() {
      return Boolean(endpoint && username && password && domainName);
    },

    /**
     * 换取 Token（带缓存与并发去重）。
     * @returns {Promise<string|null>} 失败返回 null
     */
    async getToken() {
      if (cache && Date.now() < cache.expiresAt - REFRESH_MARGIN_MS) {
        return cache.token;
      }
      if (inflight) return inflight;

      inflight = this._fetchToken()
        .then((result) => {
          if (result) {
            cache = {
              token: result.token,
              // IAM 返回的 expires_at 是 ISO 字符串；解析失败则保守取 12 小时
              expiresAt: parseExpiry(result.expiresAt),
            };
          }
          return result?.token ?? null;
        })
        .finally(() => {
          inflight = null;
        });

      return inflight;
    },

    /** 强制失效（用于排障：Token 莫名 401 时可主动清缓存） */
    invalidate() {
      cache = null;
    },

    status() {
      return {
        hasUsername: Boolean(username),
        hasPassword: Boolean(password),
        hasDomain: Boolean(domainName),
        hasAkSk: Boolean(ak && sk),
        hasProjectId: Boolean(projectId),
        cached: Boolean(cache),
        expiresAt: cache ? new Date(cache.expiresAt).toISOString() : null,
      };
    },

    /** 实际发起 Token 请求 */
    async _fetchToken() {
      if (!this.available()) return null;

      // 请求体结构依据官方「获取IAM用户Token（使用密码）」
      const body = {
        auth: {
          identity: {
            methods: ['password'],
            password: {
              user: {
                name: username,
                password,
                domain: { name: domainName },
              },
            },
          },
          scope: projectName
            ? { project: { name: projectName } }
            : projectId
              ? { project: { id: projectId } }
              : { domain: { name: domainName } },
        },
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(`${endpoint}/v3/auth/tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=utf8' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) return null;

        // Token 在响应头 X-Subject-Token 里，不在响应体
        const token = res.headers.get('X-Subject-Token');
        if (!token) return null;

        let expiresAt = null;
        try {
          const payload = await res.json();
          expiresAt = payload?.token?.expires_at || null;
        } catch {
          // 响应体解析失败不影响 Token 本身可用
        }

        return { token, expiresAt };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 解析 IAM 的 expires_at（形如 2026-10-06T11:30:00.000000Z） */
function parseExpiry(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isFinite(t)) return t;
  // 解析失败时保守假设 12 小时后过期（官方是 24 小时，取一半更安全）
  return Date.now() + 12 * 60 * 60 * 1000;
}

/**
 * AK/SK 签名的接入点（本版未启用）。
 *
 * 说明清楚为什么留空：
 * 官方 SDK-HMAC-SHA256 签名需要正确实现派生密钥、规范化请求、签名串拼接四步，
 * 任何一步算错都会得到 401 且难以定位。在演示优先的前提下，本版选用
 * 用户名+密码换 Token。若后续要求纯 AK/SK（例如安全审计要求不得存密码），
 * 在这里补实现即可，上层 speech.js 无需改动 —— 它只依赖 tokenProvider 契约。
 *
 * @returns {never} 未实现
 */
export function signRequestWithAkSk() {
  throw new Error(
    '[iam] AK/SK 签名路径未实现。当前版本使用用户名+密码换 Token。' +
      '若需切换到 AK/SK，请在此实现 SDK-HMAC-SHA256 签名。',
  );
}

/** 计算字符串的 SHA256 十六进制摘要 —— 签名实现时会被用到，先留好工具 */
export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
