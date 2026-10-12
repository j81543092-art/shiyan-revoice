/**
 * 拾言 ReVoice · Service Worker 注册 + 更新通知
 *
 * 职责：
 *   · 注册 Service Worker（生产环境 https / localhost）
 *   · 自动检测新版本，静默激活
 *   · 新版本激活后弹出更新提示条（非侵入式）
 *   · 患者端与家属端使用相同逻辑
 */

(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && location.protocol !== 'http:' && !isLocalhost) return;

  let newVersionReady = false;
  let updateToast = null;

  /* ── 更新提示 UI ── */

  function showUpdateToast() {
    if (updateToast) return;

    updateToast = document.createElement('div');
    updateToast.className = 'update-toast';
    updateToast.setAttribute('role', 'alert');
    updateToast.innerHTML = `
      <span class="update-toast__text">&#x2728; 有新版本可用</span>
      <button class="update-toast__btn" id="updateNowBtn">立即更新</button>
      <button class="update-toast__close" aria-label="关闭">&times;</button>
    `;
    document.body.appendChild(updateToast);

    updateToast.querySelector('#updateNowBtn').addEventListener('click', () => {
      hideUpdateToast();
      newVersionReady = false;
      /* 通知 SW 跳过等待 → 触发 controllerchange → 页面刷新 */
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage('skipWaiting');
      }
    });

    updateToast.querySelector('.update-toast__close').addEventListener('click', () => {
      hideUpdateToast();
      /* 1 小时内不再提示 */
      try { localStorage.setItem('revoice_update_dismissed', Date.now().toString()); } catch {}
    });
  }

  function hideUpdateToast() {
    if (!updateToast) return;
    updateToast.classList.add('update-toast--hidden');
    setTimeout(() => {
      if (updateToast) updateToast.remove();
      updateToast = null;
    }, 400);
  }

  /* ── SW 消息监听 ── */

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'SW_VERSION') return;

    /* 检查是否在 1 小时内被用户关闭过 */
    try {
      const dismissed = localStorage.getItem('revoice_update_dismissed');
      if (dismissed && (Date.now() - Number(dismissed)) < 3600000) return;
    } catch {}

    newVersionReady = true;
    showUpdateToast();
  });

  /* ── 注册 ── */

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        /* 监听新 SW 安装完成 */
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;

          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              /* 版本检测：通知客户端 */
              if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'CHECK_VERSION' });
              }
            }
          });
        });

        /* 每 60 分钟检查一次更新 */
        setInterval(() => {
          reg.update().catch(() => {});
        }, 60 * 60 * 1000);
      })
      .catch(() => {});
  });

  /* ── 页面刷新控制 ── */

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });

})();