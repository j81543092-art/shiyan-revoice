/**
 * 拾言 ReVoice · 网络状态检测
 *
 * 职责：
 *   · 监听 online/offline 事件，顶部横幅提示
 *   · 离线时在 UI 中注入离线标识
 *   · 恢复在线时自动重试挂起的操作
 *   · 暴露全局 __revoiceNetwork 状态供其他模块查询
 *
 * 设计原则：
 *   · 离线是常态场景之一（失语症患者可能在医院信号弱的环境使用）
 *   · 提示不打断操作 —— 顶部小横幅，不弹模态框
 *   · 恢复在线时自动重连，无需用户手动操作
 */

(function () {
  'use strict';

  /* ── 公开状态 ── */

  window.__revoiceNetwork = {
    online: navigator.onLine,
    listeners: [],
    onChange(fn) { this.listeners.push(fn); },
    offChange(fn) {
      this.listeners = this.listeners.filter((l) => l !== fn);
    }
  };

  function setOnline(val) {
    if (window.__revoiceNetwork.online === val) return;
    window.__revoiceNetwork.online = val;
    window.__revoiceNetwork.listeners.forEach((fn) => fn(val));
  }

  /* ── UI 构建 ── */

  let banner = null;

  function getBanner() {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'network-banner';
      banner.setAttribute('role', 'alert');
      banner.setAttribute('aria-live', 'polite');
      document.body.prepend(banner);
    }
    return banner;
  }

  function showOffline() {
    const b = getBanner();
    b.innerHTML = '<span class="network-banner__icon">&#x26A0;</span> 当前离线，部分功能不可用';
    b.className = 'network-banner network-banner--offline';
    b.hidden = false;
  }

  function showOnline() {
    const b = getBanner();
    b.innerHTML = '<span class="network-banner__icon">&#x2713;</span> 网络已恢复';
    b.className = 'network-banner network-banner--online';
    b.hidden = false;
    // 3 秒后自动收起
    setTimeout(() => { b.hidden = true; }, 3000);
  }

  /* ── 离线待发队列 ── */

  const PENDING_KEY = 'revoice_pending_actions';

  window.__revoiceQueue = {
    /**
     * 添加离线待发操作
     * @param {object} action { type: string, payload: object }
     */
    enqueue(action) {
      try {
        const list = this.getAll();
        list.push({ ...action, queuedAt: Date.now() });
        localStorage.setItem(PENDING_KEY, JSON.stringify(list));
      } catch {}
    },

    /** 获取全部待发操作 */
    getAll() {
      try {
        return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      } catch { return []; }
    },

    /** 清空队列 */
    clear() {
      try { localStorage.removeItem(PENDING_KEY); } catch {}
    },

    /** 队列长度 */
    get length() { return this.getAll().length; }
  };

  /* ── 自动重试 ── */

  async function retryPending() {
    const queue = window.__revoiceQueue.getAll();
    if (queue.length === 0) return;

    // 离线队列的重试由各业务模块自己处理，
    // 这里只通知有挂起的操作
    window.dispatchEvent(new CustomEvent('revoice:network-restored', {
      detail: { pendingCount: queue.length }
    }));
  }

  /* ── 入口 ── */

  window.addEventListener('online', () => {
    setOnline(true);
    showOnline();
    retryPending();
  });

  window.addEventListener('offline', () => {
    setOnline(false);
    showOffline();
  });

  // 初始状态
  if (!navigator.onLine) {
    // 稍延迟，确保 DOM 已就绪
    setTimeout(showOffline, 500);
    setOnline(false);
  }
})();