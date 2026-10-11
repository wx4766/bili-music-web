// Service Worker：网络优先 + 缓存兜底（离线时还能打开壳页面）
// 策略说明：不用"缓存优先"，避免发版后手机拿到旧 app.js —— 我们之前
// 踩过旧前端缓存的坑，这里宁可每次都走网络，断网才用缓存。
// 网关前缀：注册时 scope 就是 /app/bilimusic/，这里剥掉尾部斜杠得到前缀；
// 根路径部署时 scope 为 /，BASE 为空串，行为不变。
const BASE = (self.registration && self.registration.scope)
  ? new URL(self.registration.scope).pathname.replace(/\/+$/, '')
  : '';
const CACHE = 'bili-music-v15';
const SHELL = [BASE + '/', BASE + '/styles.css', BASE + '/app.js', BASE + '/manifest.json', BASE + '/apple-touch-icon.png', BASE + '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 网关登录态失效时，任何路径都会返回 200 + 纯文本 "invalid token" ——
// 旧版无差别 put 进缓存后，断网兜底回放的就是这份垃圾（白屏纯文字的根因）。
// 这里只允许"真资源"的内容类型进缓存。
function cacheable(res) {
  if (!res || !res.ok || res.status !== 200) return false;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  return /text\/css|javascript|application\/json|image\/|text\/html|font\//.test(ct);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API 和音频流永远直连网络，不缓存
  if (e.request.method !== 'GET' || url.pathname.startsWith(BASE + '/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match(BASE + '/')))
  );
});
