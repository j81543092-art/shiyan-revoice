/**
 * 登录页逻辑
 *
 * 关键约束（对照 Auth 规格的完成标准）：
 *   - 「获取验证码」与「提交」是两个独立处理器；重试错误验证码不重复发信
 *   - 验证码挑战保存在模块状态，不放在事件处理器里
 *   - 邮箱注册必须带密码（新用户）；老用户仅验证码即可
 *   - 不在文案里暴露「该邮箱是否已注册」
 */

import {
  initCloud, signInWithPassword, sendEmailCode, submitEmailOtp, clearPendingOtp,
  resetPasswordForEmail, completePasswordReset, getSession,
} from './cloud.js';

const $ = (id) => document.getElementById(id);

// ══ 初始化：云服务不可用则明确提示，不假装可用 ══
(async function init() {
  const r = await initCloud();
  if (!r.ok) {
    $('cloudNoticeBody').textContent = r.reason || '云服务未就绪';
    $('cloudNotice').hidden = false;
    return;
  }
  // 已登录则直接回首页
  const session = await getSession();
  if (session) { location.replace('/'); return; }
  $('authCard').hidden = false;
})();

// ══ 视图切换 ══
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) { showView(goto.dataset.goto); return; }

  const tab = e.target.closest('.tab');
  if (tab) showView(tab.dataset.view);
});

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  setMsg('');
}

function setMsg(text, kind = 'error') {
  const m = $('msg');
  m.textContent = text || '';
  m.className = 'msg' + (text ? ' show ' + kind : '');
}

function busy(btn, on, label) {
  if (!btn) return;
  btn.disabled = on;
  if (on) { btn.dataset._label = btn.textContent; btn.textContent = label || '请稍候…'; }
  else if (btn.dataset._label) { btn.textContent = btn.dataset._label; delete btn.dataset._label; }
}

/** 发送验证码倒计时（只作用于发送按钮，不影响提交按钮） */
function countdown(btn, seconds = 60) {
  const original = btn.dataset._label || btn.textContent;
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `${left}s 后重发`;
  const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = original; }
    else btn.textContent = `${left}s 后重发`;
  }, 1000);
}

// ══ 邮箱 + 密码登录 ══
$('view-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  busy(btn, true);
  const r = await signInWithPassword($('loginEmail').value.trim(), $('loginPassword').value);
  busy(btn, false);
  if (!r.ok) { setMsg(r.reason); return; }
  location.replace('/');
});

// ══ 验证码登录：获取 ══
$('sendOtpBtn').addEventListener('click', async () => {
  const email = $('otpEmail').value.trim();
  if (!email) { setMsg('请先填写邮箱'); return; }
  const btn = $('sendOtpBtn');
  busy(btn, true, '发送中…');
  const r = await sendEmailCode(email);
  busy(btn, false);
  if (!r.ok) { setMsg(r.reason); return; }

  // 新用户才显示「设置密码」——但文案不暴露该邮箱是否已注册
  $('otpPasswordField').hidden = !!r.isExistingUser;
  setMsg('验证码已发送，请查收邮箱', 'ok');
  countdown(btn);
});

// ══ 验证码登录：提交（不重新发信）══
$('view-otp').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('otpEmail').value.trim();
  const code = $('otpCode').value.trim();
  const pwd = $('otpPassword').value;
  if (!code) { setMsg('请输入验证码'); return; }

  const needPwd = !$('otpPasswordField').hidden;
  if (needPwd && !pwd) { setMsg('新账号需要设置密码'); return; }

  const btn = e.target.querySelector('button[type=submit]');
  busy(btn, true);
  const r = await submitEmailOtp(email, code, pwd);
  busy(btn, false);
  if (!r.ok) { setMsg(r.reason); return; }
  location.replace('/');
});

// ══ 注册 ══
$('suSendBtn').addEventListener('click', async () => {
  const email = $('suEmail').value.trim();
  if (!email) { setMsg('请先填写邮箱'); return; }
  const btn = $('suSendBtn');
  busy(btn, true, '发送中…');
  const r = await sendEmailCode(email);
  busy(btn, false);
  if (!r.ok) { setMsg(r.reason); return; }
  setMsg('验证码已发送，请查收邮箱', 'ok');
  countdown(btn);
});

$('view-signup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('suEmail').value.trim();
  const code = $('suCode').value.trim();
  const pwd = $('suPassword').value;

  const btn = e.target.querySelector('button[type=submit]');
  busy(btn, true);
  const r = await submitEmailOtp(email, code, pwd);
  busy(btn, false);

  if (!r.ok) {
    // 若其实是老用户，按规格给中性文案并引导去登录，不暴露账号是否存在
    setMsg(r.reason);
    return;
  }
  location.replace('/');
});

// ══ 忘记密码 ══
let fgChallenge = null;

$('toForgot').addEventListener('click', () => showView('forgot'));

$('fgSendBtn').addEventListener('click', async () => {
  const email = $('fgEmail').value.trim();
  if (!email) { setMsg('请先填写邮箱'); return; }
  const btn = $('fgSendBtn');
  busy(btn, true, '发送中…');
  const r = await resetPasswordForEmail(email);
  busy(btn, false);
  if (!r.ok) { setMsg(r.reason); return; }

  fgChallenge = r.challenge;
  $('fgStep2').hidden = false;
  $('fgStep3').hidden = false;
  $('fgSubmit').hidden = false;
  setMsg('重置验证码已发送', 'ok');
});

$('view-forgot').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!fgChallenge) { setMsg('请先发送重置验证码'); return; }
  const code = $('fgCode').value.trim();
  const pwd = $('fgNewPassword').value;
  if (!code || !pwd) { setMsg('请填写验证码与新密码'); return; }

  const btn = $('fgSubmit');
  busy(btn, true);
  const r = await completePasswordReset(fgChallenge, code, pwd);
  busy(btn, false);
  if (!r.ok) { setMsg(r.reason); return; }
  location.replace('/');
});

// 切换邮箱后旧的验证码挑战作废
$('otpEmail').addEventListener('input', clearPendingOtp);
$('suEmail').addEventListener('input', clearPendingOtp);
