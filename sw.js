const VERSION = 'v1';
const CACHE = 'voicebrief-' + VERSION;
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png'];
const SHARE_PATH = new URL('share-target', self.registration.scope).pathname;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('voicebrief', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveShared(entry) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(entry, 'latest');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function handleShare(request) {
  let status = 'ok';
  try {
    const form = await request.formData();
    const file = form.getAll('audio').find((f) => f instanceof File);
    if (!file) throw new Error('nofile');
    await saveShared({ blob: file, name: file.name, type: file.type, size: file.size, receivedAt: Date.now() });
  } catch (e) {
    status = e && e.message === 'nofile' ? 'nofile' : 'error';
  }
  return Response.redirect(new URL('./?shared=' + status, self.registration.scope).href, 303);
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === SHARE_PATH) {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // network-first con fallback cache (HTML e asset): niente versioni vecchie bloccate
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
