const $ = (id) => document.getElementById(id);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SECONDS = 10 * 60;
const TITLES = { full: 'Trascrizione completa', bullets: 'Riassunto per punti', short: 'Riassunto sintetico', todo: 'Cose da fare' };
const safeLS = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
};

let entry = null;        // file ricevuto (da IndexedDB)
let duration = null;     // secondi, dai metadati del player
let transcript = null;   // solo in memoria: cambiare modalità non richiama l'STT
let objectUrl = null;
let busy = false;

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
  } finally { db.close(); }
}

const fmtSize = (n) => (n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB' : (n / 1024 / 1024).toFixed(2) + ' MB');
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const setStatus = (msg, isErr) => { $('status').textContent = msg || ''; $('status').className = isErr ? 'err' : 'muted'; };
const show = (id, on) => { $(id).hidden = !on; };

function showView(view) { // 'idle' | 'pick' | 'result'
  show('pick', view === 'pick');
  show('result', view === 'result');
}

async function load() {
  const shared = new URLSearchParams(location.search).get('shared');
  try { entry = await idb('readonly', (s) => s.get('latest')); } catch (e) { setStatus('Errore IndexedDB: ' + e, true); return; }
  history.replaceState(null, '', location.pathname);
  if (shared === 'nofile') setStatus('Condivisione ricevuta ma senza file audio.', true);
  if (shared === 'error') setStatus('Errore nel leggere il file condiviso.', true);

  if (!entry) {
    showView('idle');
    if (!shared) setStatus('In attesa di un vocale. In WhatsApp: tieni premuto il vocale → Condividi → VoiceBrief.');
    return;
  }
  transcript = null;
  duration = null;
  $('f-name').textContent = entry.name || '(vuoto)';
  $('f-type').textContent = entry.type || '(vuoto)';
  $('f-size').textContent = fmtSize(entry.size);
  $('f-dur').textContent = '…';
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(entry.blob);
  const p = $('player');
  p.onloadedmetadata = () => {
    if (isFinite(p.duration)) { duration = p.duration; $('f-dur').textContent = fmtDur(duration); }
  };
  p.onerror = () => { $('f-dur').textContent = 'non leggibile'; };
  p.src = objectUrl;
  const last = safeLS.get('vb_mode') || 'bullets';
  const r = document.querySelector(`input[name=mode][value=${TITLES[last] ? last : 'bullets'}]`);
  r.checked = true;
  showView('pick');
  setStatus(shared === 'ok' ? 'Vocale ricevuto.' : '');
}

// --- rete ---
class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }

async function api(init) {
  if (!navigator.onLine) throw new ApiError('offline', 'Nessuna connessione. L’audio resta salvato: riprova appena torni online.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  let res;
  try {
    res = await fetch(self.VB.API_URL, { ...init, signal: ctl.signal, headers: init.headers });
  } catch {
    throw new ApiError('offline', 'Connessione assente o instabile. L’audio resta salvato: riprova.');
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'server', data.message || 'Errore del servizio. Riprova tra poco.');
  return data;
}

function normalizedFile() {
  const ogg = /\.(opus|ogg|oga)$/i.test(entry.name || '') || /ogg|opus/i.test(entry.type || '');
  if (ogg) return new File([entry.blob], 'audio.ogg', { type: 'audio/ogg' });
  return new File([entry.blob], entry.name || 'audio', { type: (entry.type || '').split(';')[0] });
}

async function getTranscript() {
  if (transcript !== null) return transcript;
  if (entry.size > MAX_BYTES) throw new ApiError('too_big', 'Audio oltre 10 MB.');
  if (duration && duration > MAX_SECONDS) throw new ApiError('too_long', 'Audio oltre 10 minuti.');
  const fd = new FormData();
  fd.append('audio', normalizedFile());
  const data = await api({ method: 'POST', body: fd });
  if (!data.text) throw new ApiError('empty', 'Nessun parlato riconosciuto nell’audio.');
  transcript = data.text;
  return transcript;
}

async function run() {
  if (busy) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  safeLS.set('vb_mode', mode);
  busy = true;
  $('go').disabled = true;
  setStatus('Elaboro…');
  try {
    const text = await getTranscript();
    const out = mode === 'full' ? text : (await api({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, text }) })).result;
    $('result-title').textContent = TITLES[mode];
    $('out').textContent = out || '(risultato vuoto)';
    show('share', !!navigator.share);
    showView('result');
    history.pushState({ v: 'result' }, '');
    setStatus('');
  } catch (e) {
    setStatus(e instanceof ApiError ? e.message : 'Errore imprevisto.', true);
    $('go').textContent = e.code === 'offline' ? 'Riprova' : 'Elabora';
  } finally {
    busy = false;
    $('go').disabled = false;
  }
}

// --- eventi ---
$('go').onclick = run;
$('again').onclick = () => {
  $('go').textContent = 'Elabora';
  if (history.state && history.state.v === 'result') history.back(); else showView('pick');
};
// il tasto/gesto indietro torna alla schermata precedente senza uscire dall'app
window.addEventListener('popstate', () => {
  if (!entry) return showView('idle');
  $('go').textContent = 'Elabora';
  showView(history.state && history.state.v === 'result' ? 'result' : 'pick');
});
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('out').textContent); setStatus('Copiato.'); } catch { setStatus('Copia non riuscita.', true); }
};
$('share').onclick = async () => {
  try { await navigator.share({ text: $('out').textContent }); } catch { /* annullato */ }
};
$('clear').onclick = async () => {
  await idb('readwrite', (s) => s.delete('latest'));
  entry = null; transcript = null;
  $('player').removeAttribute('src');
  showView('idle');
  setStatus('Audio eliminato. In attesa di un vocale.');
};
$('env').textContent =
  (matchMedia('(display-mode: standalone)').matches ? 'Installata' : 'Browser') + ' · v' + self.VB.VERSION;

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) show('update', true); });
  $('reload').onclick = () => location.reload();
}

load();
