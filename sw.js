// Simple offline cache for core assets
const CACHE = 'weerfomo-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png'
];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
});
self.addEventListener('fetch', e=>{
  const {request} = e;
  e.respondWith(
    caches.match(request).then(r=> r || fetch(request).then(res=>{
      const copy = res.clone();
      caches.open(CACHE).then(c=>c.put(request, copy)).catch(()=>{});
      return res;
    }).catch(()=>r))
  );
});
