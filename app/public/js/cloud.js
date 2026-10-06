/**
 * 拾言 ReVoice · 云服务接入层（WorkBuddy Cloud Service）
 *
 * 职责：
 *   1. 初始化 WorkBuddyCloud 客户端（CDN 全局形式，本项目是无构建步骤的纯 HTML）
 *   2. 暴露登录 / 注册 / 登出 / 会话查询的统一接口
 *   3. 在云服务尚未就绪时**明确报错**，绝不静默降级成假登录
 *
 * ⚠️ 两条硬规则（来自云服务规格）：
 *   - `endpoint` 与 `publishableKey` 必须都取自 publicConfig，不得硬编码、不得从 location 取
 *   - 绝不伪造会话、绝不用 localStorage 造一个"假用户"——那等于告诉用户已登录而实际没有
 *
 * Web 端只支持邮箱登录（邮箱验证码 / 邮箱+密码）——
 * 手机短信与微信登录仅在微信小程序可用，本项目是 Web 应用，因此不生成那两条路径。
 */

const CDN_SDK = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

// publicConfig 由部署时注入（见 public/js/cloud-config.js）。
// 缺失时保持 null —— 明确表示「云服务未开通」，而不是假装可用。
let publicConfig = null;
let cloud = null;
let ready = false;
let initError = null;

/** 读取注入的配置（同目录 cloud-config.js 会挂到 window.__REVOICE_CLOUD__） */
function readConfig() {
  if (typeof window === 'undefined') return null;
  const c = window.__REVOICE_CLOUD__;
  if (!c || !c.endpoint || !c.publishableKey) return null;
  return c;
}

/** 动态加载 CDN SDK（只在需要登录时才加载，不拖慢患者端首屏） */
function loadSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('非浏览器环境'));
  if (window.WorkBuddyCloud) return Promise.resolve(window.WorkBuddyCloud);

  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CDN_SDK;
    s.async = true;
    s.onload = () => {
      if (window.WorkBuddyCloud) resolve(window.WorkBuddyCloud);
      else reject(new Error('SDK 已加载但未挂载全局对象'));
    };
    s.onerror = () => reject(new Error('云服务 SDK 加载失败，请检查网络'));
    document.head.appendChild(s);
  });
}

/**
 * 初始化云服务客户端。幂等，可重复调用。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function initCloud() {
  if (ready && cloud) return { ok: true };

  publicConfig = readConfig();
  if (!publicConfig) {
    initError = '云服务尚未开通：缺少 publicConfig。登录功能需要先开通云服务后端。';
    return { ok: false, reason: initError };
  }

  try {
    const sdk = await loadSdk();
    // endpoint 与 publishableKey 必须同时传入，两者都来自 publicConfig
    cloud = sdk.createWorkBuddyCloud({
      endpoint: publicConfig.endpoint,
      publishableKey: publicConfig.publishableKey,
    });
    ready = true;
    initError = null;
    return { ok: true };
  } catch (err) {
    initError = err?.message || '云服务初始化失败';
    return { ok: false, reason: initError };
  }
}

/** 云服务是否可用（供 UI 决定是显示登录表单还是提示未开通） */
export function isCloudReady() {
  return ready && !!cloud;
}

export function unavailableReason() {
  return initError;
}

function requireCloud() {
  if (!ready || !cloud) throw new Error(initError || '云服务未就绪');
  return cloud;
}

// ── 会话 ─────────────────────────────────────────────────────

/** 读取当前会话；未登录返回 null（不抛错） */
export async function getSession() {
  await initCloud();
  if (!ready) return null;
  const { data, error } = await cloud.auth.getSession();
  if (error || !data) return null;
  return data;
}

/** 服务端校验过的当前用户 */
export async function getUser() {
  await initCloud();
  if (!ready) return null;
  const { data, error } = await cloud.auth.getUser();
  if (error) return null;
  return data?.user ?? null;
}

/** 订阅登录态变化，返回取消订阅函数 */
export async function onAuthChange(cb) {
  await initCloud();
  if (!ready) return () => {};
  const unsub = cloud.auth.onAuthStateChange((event, session) => {
    cb(event, session?.user ?? null);
  });
  return typeof unsub === 'function' ? unsub : () => {};
}

// ── 登录方式（Web 端支持邮箱）────────────────────────────────

/** 邮箱 + 密码登录 */
export async function signInWithPassword(email, password) {
  const c = requireCloud();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, reason: '账号或密码不正确' };
  return { ok: true, user: data?.user ?? null };
}

// 验证码挑战保存在模块作用域，不放在事件处理器里 —— 这样「获取验证码」与
// 「提交」可以是两次独立操作，重试错误验证码时不会重复发信。
let pendingOtp = null;

/** 发送邮箱验证码（对应 UI 的「获取验证码 / 重新发送」） */
export async function sendEmailCode(email) {
  const c = requireCloud();
  const sent = await c.auth.sendOtp({ email });
  if (sent.error) return { ok: false, reason: sent.error.message || '验证码发送失败' };

  pendingOtp = {
    email,
    verificationId: sent.data.verificationId,
    isExistingUser: sent.data.isExistingUser,
  };
  return { ok: true, isExistingUser: sent.data.isExistingUser };
}

/** 清除待验证的验证码挑战（切换邮箱或登录成功后调用） */
export function clearPendingOtp() {
  pendingOtp = null;
}

/**
 * 用验证码登录 / 注册。
 * 新用户必须带 password（邮箱注册强制要求密码）；
 * 已存在用户仅凭验证码即可登录。
 */
export async function submitEmailOtp(email, code, password) {
  const c = requireCloud();
  const pending = pendingOtp;
  if (!pending || pending.email !== email) {
    return { ok: false, reason: '请先为当前邮箱获取验证码' };
  }

  const completed = await c.auth.verifyOtp({
    email: pending.email,
    verificationId: pending.verificationId,
    isExistingUser: pending.isExistingUser,
    token: code,
    password: pending.isExistingUser ? undefined : password,
  });
  if (completed.error) {
    return { ok: false, reason: completed.error.message || '验证码不正确' };
  }
  pendingOtp = null;
  return { ok: true, user: completed.data?.user ?? null };
}

/** 忘记密码：发送重置验证码，再用 nonce + 新密码完成重置 */
export async function resetPasswordForEmail(email) {
  const c = requireCloud();
  const started = await c.auth.resetPasswordForEmail(email);
  if (started.error) return { ok: false, reason: started.error.message || '发送失败' };
  return { ok: true, challenge: started.data };
}

/** 完成密码重置（登录态也随之建立） */
export async function completePasswordReset(challenge, code, newPassword) {
  const completed = await challenge.updateUser({ nonce: code, password: newPassword });
  if (completed.error) return { ok: false, reason: completed.error.message || '重置失败' };
  return { ok: true, user: completed.data?.user ?? null };
}

/** 已登录状态下修改密码 */
export async function changePassword(oldPassword, newPassword) {
  const c = requireCloud();
  const r = await c.auth.resetPasswordForOld({ oldPassword, newPassword });
  if (r.error) return { ok: false, reason: r.error.message || '修改失败' };
  return { ok: true };
}

/** 登出 */
export async function signOut() {
  if (!ready || !cloud) return { ok: true };
  const { error } = await cloud.auth.signOut();
  if (error) return { ok: false, reason: error.message || '登出失败' };
  return { ok: true };
}

// ── 数据（按用户隔离，RLS 在服务端强制）──────────────────────

/**
 * 保存一次确认后的表达。
 * 注意：不传 owner_id —— 由数据库 DEFAULT auth.uid() 填充，RLS 负责隔离。
 */
export async function saveExpression(record) {
  const c = requireCloud();
  const { data, error } = await c.database
    .from('expressions')
    .insert({
      final_text: record.finalText,
      scenario_key: record.scenarioKey || null,
      confidence: record.confidence ?? null,
      clues: record.clues || {},
      clarify_rounds: record.clarifyRounds || 0,
      via_emergency: !!record.viaEmergency,
    })
    .select();

  if (error) {
    if (error.code === '42P01') return { ok: false, reason: '数据表尚未创建' };
    if (error.code === '42501') return { ok: false, reason: '无权写入该记录' };
    return { ok: false, reason: error.message || '保存失败' };
  }
  return { ok: true, row: data?.[0] ?? null };
}

/** 读取本人最近的表达记录 */
export async function listExpressions(limit = 20) {
  const c = requireCloud();
  const { data, error } = await c.database
    .from('expressions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { ok: false, reason: error.message, rows: [] };
  return { ok: true, rows: data || [] };
}

export { pendingOtp };
