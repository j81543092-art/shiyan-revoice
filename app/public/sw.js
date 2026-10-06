/**
 * 拾言 ReVoice · Service Worker
 *
 * 策略：
 *   · HTML 页面 → 网络优先（保证最新版），失败回退缓存（断网可用）
 *   · CSS/JS/图标 → 缓存优先（秒开），后台静默更新
 *   · API 请求 → 永终走网络（不缓存，数据实时性要求高）
 *   · 语音/图片 API → 不拦截，直接透传
 *
 * 版本号更新策略：每次部署改 CACHE_VERSION，触发 activate 清旧缓存。
 */

const CACHE_VERSION = 'revoice-v1-20261006';
const CORE_CACHE = `${CACHE_VERSION}-core`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const CORE_ASSETS = [
  './',
  './index.html',
  './login.html',
  './account.html',
  './caregiver.html',
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
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
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

  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirst(req));
    return;
  }

  if (STATIC_TYPES.has(req.destination)) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }
});

const STATIC_TYPES = new Set(['style', 'script', 'image', 'font', 'manifest']);

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(CORE_CACHE);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fallback = await caches.match('./index.html');
    return fallback || new Response('离线且无缓存', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) {
    fetch(req).then((fresh) => {
      caches.open(cacheName).then((c) => c.put(req, fresh));
    }).catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(cacheName);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});