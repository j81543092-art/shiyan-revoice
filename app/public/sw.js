/**
 * 拾言 ReVoice · Service Worker
 *
 * 策略：
 *   · HTML 页面 → 网络优先（保证最新版），失败回退缓存（断网可用）
 *   · CSS/JS/图标 → 缓存优先（秒开），后台静默更新
 *   · API 请求 → 永走网络（不缓存，数据实时性要求高）
 *   · 语音/图片 API → 不拦截，直接透传
 *
 * 版本号更新策略：每次部署改 CACHE_VERSION，触发 activate 清旧缓存。
 * 添加 engine/ 目录预缓存 → 支持端侧规则引擎离线兜底。
 */

const CACHE_VERSION = 'revoice-v2-20261011-visual';
const CORE_CACHE = `${CACHE_VERSION}-core`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const CORE_ASSETS = [
  './',
  './index.html',
  './login.html',
  './account.html',
  './caregiver.html',
  './offline.html',
  './css/app.css',
  './css/auth.css',
  './css/caregiver.css',
  './js/patient.js',
  './js/caregiver.js',
  './js/login.js',
  './js/cloud.js',
  './js/cloud-config.js',
  './js/session-badge.js',
  './js/speech-client.js',
  './js/sw-register.js',
  './js/network-status.js',
  './js/install-prompt.js',
  './js/api-local.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  // ARASAAC 候选配图（词表命中时用）
  './icons/arasaac/water.png',
  './icons/arasaac/eat.png',
  './icons/arasaac/cold.png',
  './icons/arasaac/hot.png',
  './icons/arasaac/pain.png',
  './icons/arasaac/toilet.png',
  './icons/arasaac/phone.png',
  './icons/arasaac/medicine.png',
  './icons/arasaac/sleep.png',
  './icons/arasaac/window.png',

  /* 规则引擎 —— 端侧离线兜底 */
  './engine/engine-lite.js',
  './engine/intents.js',
  './engine/scenarios.js',
  './engine/normalize.js',
  './engine/scoring.js',
  './engine/clarify.js',
  './engine/emergency.js',
  './engine/rule-engine.js',
  './engine/wording.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS).catch((err) => {
        console.warn('[SW] 预缓存部分资源失败，将按需拉取:', err.message);
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  /* 不拦截跨域请求 */
  if (url.origin !== self.location.origin) return;

  /* API 请求永走网络 */
  if (url.pathname.startsWith('/api/')) return;

  /* HTML 导航 → 网络优先，离线回落 index.html 或 offline.html */
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirst(req));
    return;
  }

  /* 静态资源 → 缓存优先 */
  if (STATIC_TYPES.has(req.destination)) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  /* 其他（如 engine JS 被 importScripts 加载）→ 缓存优先 */
  if (url.pathname.startsWith('/engine/')) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }
});

const STATIC_TYPES = new Set(['style', 'script', 'image', 'font', 'manifest']);

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    /* 只缓存成功响应 */
    if (fresh.ok) {
      const cache = await caches.open(CORE_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    /* 文档请求回落离线页 */
    const offline = await caches.match('./offline.html');
    return offline || new Response('离线且无缓存', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) {
    /* 后台静默更新 */
    fetch(req).then((fresh) => {
      if (fresh.ok) {
        caches.open(cacheName).then((c) => c.put(req, fresh));
      }
    }).catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetch(req);
    if (fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

/* ── 消息通道 ── */

self.addEventListener('message', (event) => {
  const data = event.data;

  if (data === 'skipWaiting') {
    self.skipWaiting();
    return;
  }

  /* 更新通知：新版 SW 就绪后告知所有客户端 */
  if (data && data.type === 'CHECK_VERSION') {
    self.clients.matchAll().then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: 'SW_VERSION',
          version: CACHE_VERSION,
        });
      });
    });
  }
});