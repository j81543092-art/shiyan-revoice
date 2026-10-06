/**
 * 账号状态角标 —— 患者端 / 家属端共用
 *
 * 有会话时显示邮箱前缀并可进入账号页；无会话时显示「登录」。
 * 云服务未开通时静默降级为普通链接（不报错、不阻塞主流程）。
 */

import { initCloud, getSession } from './cloud.js';

(async function () {
  const link = document.getElementById('accountLink');
  const text = document.getElementById('accountText');
  const dot = document.getElementById('accountDot');
  if (!link || !text) return;

  try {
    const r = await initCloud();
    if (!r.ok) return; // 云服务未开通：保持「登录」，点击后登录页会给出明确说明

    const session = await getSession();
    const email = session?.user?.email;
    if (email) {
      text.textContent = email.split('@')[0];
      if (dot) dot.classList.add('on');
      link.href = '/account.html';
      link.title = '已登录：' + email;
    }
  } catch {
    // 角标是增强，失败不影响表达主流程
  }
})();
