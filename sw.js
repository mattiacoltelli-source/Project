importScripts('config.js');
const CACHE = 'voicebrief-' + self.VB.VERSION;
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png'];
const SHARE_PATH = new URL('share-target', self.registration.scope).pathname;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('voicebrief', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const MAX_ITEMS = 10;
const GROUP_WINDOW = 30 * 60 * 1000; // un vocale condiviso entro 30 minuti si aggiunge al gruppo ancora aperto

// i vocali condivisi si accumulano in un gruppo ('group'); dopo "Elabora" il gruppo si chiude e il prossimo vocale ne apre uno nuovo
async function addShared(files) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      const st = tx.objectStore('files');
      let status = 'ok';
      const get = st.get('group');
      get.onsuccess = () => {
        const now = Date.now();
        let group = get.result;
        if (!(group && group.open && now - group.updated < GROUP_WINDOW)) group = { items: [], open: true, updated: now };
        let added = 0;
        for (const f of files) {
          if (group.items.some((i) => i.name === f.name && i.size === f.size)) { status = 'dup'; continue; }
          if (group.items.length >= MAX_ITEMS) { status = 'full'; break; }
          group.items.push({ id: crypto.randomUUID(), blob: f, name: f.name, type: f.type, size: f.size, receivedAt: now });
          added++;
        }
        if (added) status = 'ok';
        group.updated = now;
        st.put(group, 'group');
        st.delete('latest');
      };
      tx.oncomplete = () => resolve(status);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function handleShare(request) {
  let status = 'ok';
  try {
    const form = await request.formData();
    const files = form.getAll('audio').filter((f) => f instanceof File);
    if (!files.length) throw new Error('nofile');
    status = await addShared(files);
  } catch (e) {
    status = e && e.message === 'nofile' ? 'nofile' : 'error';
  }
  return Response.redirect(new URL('./?shared=' + status, self.registration.scope).href, 303);
}

self.addEventListener('install', (e) => {
  // 'reload' salta la cache HTTP del browser: la nuova versione salva file freschi, mai quelli vecchi
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => fetch(new Request(u, { cache: 'reload' })).then((r) => (r.ok ? c.put(u, r) : null)))))
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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === SHARE_PATH) {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // network-first con fallback cache; 'no-cache' = riconvalida sempre col server (niente file vecchi dalla cache HTTP di 10 min)
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
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
