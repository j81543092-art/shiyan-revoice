/**
 * Service Worker 注册 —— 在所有页面统一调用
 *
 * 仅在生产环境（https / localhost）注册，避免 file:// 打开时报错。
 * 更新检测：检测到新 SW 后自动激活，不等待用户关闭所有标签页 ——
 * 患者不会理解"关闭所有页面再打开"，必须无感更新。
 */
(function () {
  if (!('serviceWorker' in navigator)) return;

  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !isLocalhost) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              sw.postMessage('skipWaiting');
            }
          });
        });
      })
      .catch(() => {});
  });

  if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
  }
})();