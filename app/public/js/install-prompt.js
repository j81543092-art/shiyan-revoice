/**
 * 拾言 ReVoice · PWA 安装引导
 *
 * 职责：
 *   · 监听 beforeinstallprompt 事件，提供自定义安装按钮
 *   · 检测是否已安装（standalone / fullscreen 模式）
 *   · iOS Safari 特殊适配（无 beforeinstallprompt，展示引导说明）
 *   · 安装成功后隐藏引导
 *
 * 设计原则：
 *   · 不打扰患者 —— 仅在底部轻提示，不弹遮挡内容的模态框
 *   · 不反复出现 —— 24h 内不再重复提示
 *   · iOS 需要特殊引导 —— 展示"点击分享 → 添加到主屏幕"动效
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'revoice_install_dismissed';
  const DISMISS_TTL = 24 * 60 * 60 * 1000; // 24 小时

  let deferredPrompt = null;

  /* ── 状态检测 ── */

  function isInstalled() {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (navigator.standalone) return true; // iOS Safari
    return false;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent);
  }

  function isRecentlyDismissed() {
    try {
      const ts = localStorage.getItem(STORAGE_KEY);
      if (!ts) return false;
      return (Date.now() - Number(ts)) < DISMISS_TTL;
    } catch { return false; }
  }

  function shouldShowPrompt() {
    if (isInstalled()) return false;
    if (isRecentlyDismissed()) return false;
    return true;
  }

  /* ── UI 构建 ── */

  function buildBanner() {
    const banner = document.createElement('div');
    banner.className = 'install-banner';
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-label', '可以安装到桌面');

    if (isIOS()) {
      banner.innerHTML = `
        <div class="install-banner__inner install-banner__inner--ios">
          <span class="install-banner__icon">📱</span>
          <span class="install-banner__text">添加到主屏幕，使用更方便</span>
          <button class="install-banner__close" aria-label="关闭">&times;</button>
        </div>
        <div class="install-banner__ios-guide">
          点击 <span class="install-banner__share-icon">&#x2382;</span> 分享 → 添加到主屏幕
        </div>
      `;
      // iOS 点击内层触发 guide 展开
      banner.querySelector('.install-banner__inner').addEventListener('click', () => {
        const guide = banner.querySelector('.install-banner__ios-guide');
        guide.classList.toggle('visible');
      });
    } else {
      banner.innerHTML = `
        <div class="install-banner__inner">
          <span class="install-banner__icon">📱</span>
          <span class="install-banner__text">安装拾言，离线也能用</span>
          <button class="install-banner__action" id="installBtn">安装</button>
          <button class="install-banner__close" aria-label="关闭">&times;</button>
        </div>
      `;
      banner.querySelector('#installBtn').addEventListener('click', triggerInstall);
    }

    banner.querySelector('.install-banner__close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });

    return banner;
  }

  /* ── 安装触发 ── */

  async function triggerInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (choice.outcome === 'accepted') {
      hideBanner();
    }
  }

  function dismiss() {
    hideBanner();
    try { localStorage.setItem(STORAGE_KEY, Date.now().toString()); } catch {}
  }

  function hideBanner() {
    const banner = document.querySelector('.install-banner');
    if (banner) {
      banner.classList.add('install-banner--hidden');
      setTimeout(() => banner.remove(), 400);
    }
  }

  function showBanner() {
    if (!shouldShowPrompt()) return;
    // 延迟出现，不抢页面加载的注意力
    setTimeout(() => {
      if (!shouldShowPrompt()) return;
      document.body.appendChild(buildBanner());
    }, 3000);
  }

  /* ── 入口 ── */

  if (isInstalled()) return;

  // Android / Chrome 等支持 beforeinstallprompt 的浏览器
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showBanner();
  });

  // iOS / 不支持 beforeinstallprompt 的浏览器
  window.addEventListener('load', () => {
    // 延迟检查，给 beforeinstallprompt 机会先触发
    setTimeout(() => {
      if (!deferredPrompt && shouldShowPrompt() && !document.querySelector('.install-banner')) {
        // 对非 iOS 也尝试展示（某些浏览器可能不支持 beforeinstallprompt）
        showBanner();
      }
    }, 5000);
  });

  // 安装成功后自动隐藏
  window.matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
    if (e.matches) hideBanner();
  });
})();