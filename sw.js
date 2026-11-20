const V = 'xjp-v1';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/db.js', 'js/tokenizer.js', 'js/deepseek.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 内容包：网络优先
  if (url.pathname.includes('/packs/')) {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(req, c)); return r; }).catch(() => caches.match(req)));
    return;
  }
  // kuromoji 词典 / CDN：缓存优先（只下载一次）
  if (url.hostname.includes('jsdelivr')) {
    e.respondWith(caches.match(req).then(m => m || fetch(req).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(req, c)); return r; })));
    return;
  }
  // 同源静态文件：stale-while-revalidate
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then(m => {
      const net = fetch(req).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(req, c)); return r; }).catch(() => m);
      return m || net;
    }));
  }
});
