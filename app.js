const $ = (id) => document.getElementById(id);
let objectUrl = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('voicebrief', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const fmtSize = (n) => (n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1024 / 1024).toFixed(2) + ' MB') + ' (' + n + ' byte)';

async function render() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('shared');
  let entry = null;
  try { entry = await idb('readonly', (s) => s.get('latest')); } catch (e) { $('status').textContent = 'Errore IndexedDB: ' + e; return; }

  if (shared === 'nofile') $('status').textContent = 'Condivisione ricevuta ma senza file audio.';
  else if (shared === 'error') $('status').textContent = 'Errore nel leggere il file condiviso.';
  else if (entry) $('status').textContent = shared === 'ok' ? 'File ricevuto dalla condivisione.' : 'Ultimo file salvato.';

  $('file').hidden = !entry;
  if (!entry) return;
  const name = entry.name || '(vuoto)';
  const dot = name.lastIndexOf('.');
  $('f-name').textContent = name;
  $('f-type').textContent = entry.type || '(vuoto)';
  $('f-ext').textContent = dot >= 0 ? name.slice(dot) : '(nessuna)';
  $('f-size').textContent = fmtSize(entry.size);
  $('f-time').textContent = new Date(entry.receivedAt).toLocaleString('it-IT');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(entry.blob);
  $('player').src = objectUrl;
  $('play-err').hidden = true;
  $('player').onerror = () => {
    $('play-err').textContent = 'Il browser non riesce a riprodurre il file.';
    $('play-err').hidden = false;
  };
  if (shared) history.replaceState(null, '', location.pathname);
}

$('clear').onclick = async () => {
  await idb('readwrite', (s) => s.delete('latest'));
  $('player').removeAttribute('src');
  $('status').textContent = 'File eliminato. In attesa di un vocale.';
  $('file').hidden = true;
};

$('env').textContent =
  (matchMedia('(display-mode: standalone)').matches ? 'Installata (standalone)' : 'Browser (non installata)') + ' · v1';

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { reg.update().catch(() => {}); render(); }
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) $('update').hidden = false;
  });
  $('reload').onclick = () => location.reload();
} else {
  $('status').textContent = 'Service worker non supportato: Share Target non disponibile.';
}

render();
