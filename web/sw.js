const CACHE='kalo-native-v15-crop-priority-scroll-latest';
const APP_SHELL=[
  './',
  './index.html',
  './styles.css?v=1.6.2',
  './app.js?v=1.6.2',
  './config.js',
  './crypto.js',
  './webrtc.js',
  './storage.js',
  './call.js',
  './vendor/qrcode.min.js',
  './vendor/qr-scanner.min.js',
  './vendor/qr-scanner-worker.min.js',
  './icon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install',(event)=>{
  event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(APP_SHELL)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate',(event)=>{
  event.waitUntil(
    caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key!==CACHE).map((key)=>caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch',(event)=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;

  event.respondWith(
    fetch(request)
      .then((response)=>{
        const copy=response.clone();
        caches.open(CACHE).then((cache)=>cache.put(request,copy)).catch(()=>{});
        return response;
      })
      .catch(()=>caches.match(request).then((cached)=>cached||caches.match('./index.html')))
  );
});
