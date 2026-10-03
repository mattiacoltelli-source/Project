const $ = (id) => document.getElementById(id);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SECONDS = 10 * 60;
const TITLES = { full: 'Trascrizione completa', bullets: 'Riassunto per punti', short: 'Riassunto sintetico' };
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

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const setStatus = (msg, isErr) => { $('status').textContent = msg || ''; $('status').className = isErr ? 'err' : 'muted'; };
const show = (id, on) => { $(id).hidden = !on; };

function showView(view) { // 'idle' | 'pick' | 'result'
  show('pick', view === 'pick');
  show('result', view === 'result');
  show('brand', view !== 'result');
  if (view !== 'pick') pausePlayer();
}

// --- player ---
const player = $('player');
function resetPlayer() {
  duration = null;
  $('fill').style.width = '0';
  $('t-cur').textContent = '0:00';
  $('t-dur').textContent = '–:––';
  syncPlayIcon();
}
function pausePlayer() { if (!player.paused) player.pause(); }
function syncPlayIcon() {
  const playing = !player.paused;
  $('play').querySelector('.i-play').hidden = playing;
  $('play').querySelector('.i-pause').hidden = !playing;
  $('play').setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
}
function seekTo(clientX) {
  const r = $('bar').getBoundingClientRect();
  if (duration) player.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
}
player.onloadedmetadata = () => {
  if (isFinite(player.duration)) { duration = player.duration; $('t-dur').textContent = fmtDur(duration); }
};
player.ontimeupdate = () => {
  $('t-cur').textContent = fmtDur(player.currentTime);
  if (duration) $('fill').style.width = Math.min(100, (player.currentTime / duration) * 100) + '%';
};
player.onplay = player.onpause = syncPlayIcon;
player.onended = () => { player.currentTime = 0; $('fill').style.width = '0'; syncPlayIcon(); };
player.onerror = () => setStatus('Il browser non riesce a riprodurre questo audio.', true);
$('play').onclick = () => { if (player.paused) player.play().catch(() => {}); else player.pause(); };
$('bar').onpointerdown = (e) => { seekTo(e.clientX); $('bar').setPointerCapture(e.pointerId); $('bar').onpointermove = (m) => seekTo(m.clientX); };
$('bar').onpointerup = () => { $('bar').onpointermove = null; };
$('bar').onkeydown = (e) => {
  if (e.key === 'ArrowRight') player.currentTime += 5;
  if (e.key === 'ArrowLeft') player.currentTime -= 5;
};

// --- risultato ---
let lastOutput = '';
function renderResult(mode, text) {
  lastOutput = text;
  const box = $('out');
  box.textContent = '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const m = /^([-*•]|\d+[.)])\s+(.*)$/.exec(l);
    const el = document.createElement(m ? 'div' : 'p');
    if (m) el.className = 'item';
    el.textContent = (m ? m[2] : l).replace(/\*\*/g, '');
    box.appendChild(el);
  }
  $('result-title').textContent = TITLES[mode];
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
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(entry.blob);
  resetPlayer();
  $('player').src = objectUrl;
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
  $('go').textContent = 'Elaboro…';
  setStatus('');
  try {
    const text = await getTranscript();
    const out = mode === 'full' ? text : (await api({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, text }) })).result;
    renderResult(mode, out || '(risultato vuoto)');
    show('share', !!navigator.share);
    showView('result');
    history.pushState({ v: 'result' }, '');
    setStatus('');
  } catch (e) {
    setStatus(e instanceof ApiError ? e.message : 'Errore imprevisto.', true);
    $('go').textContent = e.code === 'offline' ? 'Riprova' : 'Elabora';
  } finally {
    busy = false;
    if ($('go').textContent === 'Elaboro…') $('go').textContent = 'Elabora';
    $('go').disabled = false;
  }
}

// --- eventi ---
$('go').onclick = run;
const goBack = () => {
  $('go').textContent = 'Elabora';
  if (history.state && history.state.v === 'result') history.back(); else showView('pick');
};
$('again').onclick = goBack;
$('back').onclick = goBack;
// il tasto/gesto indietro torna alla schermata precedente senza uscire dall'app
window.addEventListener('popstate', () => {
  if (!entry) return showView('idle');
  $('go').textContent = 'Elabora';
  showView(history.state && history.state.v === 'result' ? 'result' : 'pick');
});
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(lastOutput); setStatus('Copiato.'); } catch { setStatus('Copia non riuscita.', true); }
};
$('share').onclick = async () => {
  try { await navigator.share({ text: lastOutput }); } catch { /* annullato */ }
};
$('clear').onclick = async () => {
  await idb('readwrite', (s) => s.delete('latest'));
  entry = null; transcript = null;
  pausePlayer();
  player.removeAttribute('src');
  resetPlayer();
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
