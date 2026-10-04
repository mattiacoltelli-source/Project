const $ = (id) => document.getElementById(id);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SECONDS = 10 * 60;
const TITLES = { bullets: 'Riassunto per punti', clean: 'Testo pulito', summary: 'Riassunto', comment: 'Commento', translate: 'Traduzione' };
const safeLS = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
};

const MAX_ITEMS = 10;                 // vocali per gruppo
const MAX_TOTAL_SECONDS = 10 * 60;    // durata totale del gruppo
let items = [];          // vocali del gruppo in ordine cronologico (da IndexedDB)
let curIdx = 0;          // vocale caricato nel player
let duration = null;     // secondi del vocale nel player
const jobs = new Map();    // id -> richiesta di trascrizione in corso
const evCache = new Map(); // id -> impegni estratti ([] = nessuno), solo in memoria
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

// gruppo di vocali: { items, open, updated } sotto la chiave 'group' (compatibile col vecchio 'latest')
async function readGroup() {
  const g = await idb('readonly', (s) => s.get('group'));
  if (g && Array.isArray(g.items)) return g;
  const old = await idb('readonly', (s) => s.get('latest'));
  if (old) return { items: [{ id: 'old', ...old }], open: false, updated: old.receivedAt || Date.now() };
  return null;
}
// scrive il gruppo mantenendo l'attesa di "Aggiungi un altro vocale" (append) se non viene passata
const writeGroup = (list, open, append) => idb('readwrite', (s) => {
  const get = s.get('group');
  get.onsuccess = () => {
    const prev = get.result;
    s.put({ items: list, open, updated: Date.now(), append: append !== undefined ? append : (prev && prev.append) || 0 }, 'group');
    s.delete('latest');
  };
  return get;
});
// aggiorna un solo vocale (es. la trascrizione) senza sovrascrivere ciò che nel frattempo è stato aggiunto
function patchItem(id, fields) {
  return idb('readwrite', (s) => {
    const get = s.get('group');
    get.onsuccess = () => {
      const g = get.result;
      const it = g && g.items.find((i) => i.id === id);
      if (it) { Object.assign(it, fields); s.put(g, 'group'); }
    };
    return get;
  });
}

// ordine cronologico dai nomi WhatsApp (PTT-20261003-WA0007 / WhatsApp Ptt 2026-10-03 at 14.22.11); gli altri in fondo, nell'ordine di arrivo
function chronoKey(it) {
  const name = it.name || '';
  let m = /(20\d{2})(\d{2})(\d{2})-WA(\d+)/i.exec(name);
  if (m) return [Number(m[1] + m[2] + m[3]), Number(m[4])];
  m = /(20\d{2})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})\.(\d{2})/i.exec(name);
  if (m) return [Number(m[1] + m[2] + m[3]), Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6])];
  return null;
}
function sortItems(list) {
  const keyed = [], plain = [];
  list.forEach((it, i) => { const k = chronoKey(it); (k ? keyed : plain).push({ it, k, i }); });
  keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i);
  plain.sort((a, b) => (a.it.receivedAt || 0) - (b.it.receivedAt || 0) || a.i - b.i);
  return [...keyed, ...plain].map((x) => x.it);
}
const itemDate = (it) => {
  const m = /(20\d{2})-?(\d{2})-?(\d{2})/.exec(it.name || '');
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' }).format(d) : '';
};
const totalSeconds = () => items.reduce((n, i) => n + (i.duration || 0), 0);
function probeDuration(blob) { // durata di un file (per l'elenco e il limite totale)
  return new Promise((res) => {
    const a = new Audio();
    const u = URL.createObjectURL(blob);
    const t = setTimeout(() => done(null), 4000);
    function done(v) { clearTimeout(t); a.removeAttribute('src'); URL.revokeObjectURL(u); res(v); }
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (isFinite(a.duration) && a.duration > 0) done(a.duration);
      else if (a.duration === Infinity) { a.ontimeupdate = () => done(isFinite(a.duration) ? a.duration : null); a.currentTime = 1e101; }
      else done(null);
    };
    a.onerror = () => done(null);
    a.src = u;
  });
}

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const setStatus = (msg, isErr) => { $('status').textContent = msg || ''; $('status').classList.toggle('err', !!isErr); };
const show = (id, on) => { $(id).hidden = !on; };

let curView = 'idle';
let installEvent = null; // beforeinstallprompt (Android/Chrome)
function showView(view) { // 'idle' | 'pick' | 'recording' | 'working' | 'result'
  show('idle', view === 'idle');
  show('recording', view === 'recording');
  show('working', view === 'working');
  show('pick', view === 'pick');
  show('result', view === 'result');
  show('brand', view !== 'result');
  curView = view;
  updateInstall();
  show('rec-start', view === 'idle'); // registrare è un'opzione secondaria, solo da qui
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
let raf = 0;
function paint() {
  $('t-cur').textContent = fmtDur(player.currentTime);
  if (duration) $('fill').style.width = Math.min(100, (player.currentTime / duration) * 100) + '%';
}
function loop() { paint(); raf = player.paused ? 0 : requestAnimationFrame(loop); }
function syncPlayIcon() {
  const playing = !player.paused;
  $('play').classList.toggle('playing', playing);
  $('play').setAttribute('aria-label', playing ? 'Pausa' : 'Riproduci');
  if (playing && !raf) raf = requestAnimationFrame(loop);
}
function seekTo(clientX) {
  const r = $('bar').getBoundingClientRect();
  if (duration) player.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
}
player.onloadedmetadata = () => {
  if (player.duration === Infinity) { // webm di MediaRecorder senza durata: la faccio calcolare al browser
    const fix = () => { player.removeEventListener('timeupdate', fix); player.currentTime = 0; };
    player.addEventListener('timeupdate', fix);
    player.currentTime = 1e101;
    return;
  }
  if (isFinite(player.duration)) { duration = player.duration; $('t-dur').textContent = fmtDur(duration); }
};
player.ondurationchange = () => {
  if (isFinite(player.duration) && player.duration > 0) { duration = player.duration; $('t-dur').textContent = fmtDur(duration); }
};
player.ontimeupdate = paint;
player.onplay = player.onpause = syncPlayIcon;
player.onended = () => { player.currentTime = 0; paint(); syncPlayIcon(); };
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
  const rows = text.split('\n').filter((l) => l.trim());
  const lines = rows.map((l) => l.trim());
  let hasComment = false;
  let lastItem = null;
  for (const [i, l] of lines.entries()) {
    const cm = /^💬\s*(.+)$/.exec(l);
    if (cm) { // commento in coda al paragrafo: riga a parte, in corsivo e con una barra, così si capisce che è un'opinione
      const el = document.createElement('div');
      el.className = 'c-line';
      el.textContent = '💬 ' + cm[1].replace(/\*\*/g, '');
      box.appendChild(el);
      hasComment = true;
      continue;
    }
    const b = i === 0 ? /^in breve\s*[:\-–]\s*(.+)$/i.exec(l) : null;
    if (b) { // riga "In breve" in cima, separata dai punti
      const el = document.createElement('div');
      el.className = 'brief';
      const lab = document.createElement('small');
      lab.textContent = 'In breve';
      const txt = document.createElement('span');
      txt.textContent = b[1].replace(/\*\*/g, '');
      el.append(lab, txt);
      box.appendChild(el);
      continue;
    }
    const m = /^([-*•]|\d+[.)])\s+(.*)$/.exec(l);
    if (!m && lastItem && /^\s{2,}/.test(rows[i])) { // riga di dettaglio rientrata: sotto il suo punto
      const sub = document.createElement('small');
      sub.textContent = l.replace(/\*\*/g, '');
      lastItem.appendChild(sub);
      continue;
    }
    const el = document.createElement(m ? 'div' : 'p');
    if (m) {
      el.className = 'item';
      const t = document.createElement('span');
      t.textContent = m[2].replace(/\*\*/g, '');
      el.appendChild(t);
      lastItem = t;
    } else {
      el.textContent = l.replace(/\*\*/g, '');
      lastItem = null;
    }
    box.appendChild(el);
  }
  if (hasComment && currentTone() !== 'sharp') {
    const note = document.createElement('p');
    note.className = 'c-note';
    note.textContent = 'I commenti sono opinioni generate dall’AI: non sono consigli finanziari, legali o medici.';
    box.appendChild(note);
  }
  $('result-title').textContent = TITLES[mode];
}
// tono del commento (Serio / Pungente), ricordato sul telefono
const currentTone = () => (safeLS.get('vb_tone') === 'sharp' ? 'sharp' : 'serious');
function syncTone() {
  const on = document.querySelector('input[name=mode]:checked');
  show('tone', !!on && on.value === 'comment');
  document.querySelectorAll('#tone button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tone === currentTone())));
}
document.querySelectorAll('#tone button').forEach((b) => { b.onclick = () => { safeLS.set('vb_tone', b.dataset.tone); syncTone(); }; });
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncTone));

// registrazione fatta nell'app (nome 'registrazione-…'): la traduzione va in inglese, per scrivere a qualcuno in inglese
const isRecording = (e) => !!e && /^registrazione-/.test(e.name || '');

function selectItem(i) {
  curIdx = i;
  const it = items[i];
  duration = it.duration || null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(it.blob);
  resetPlayer();
  duration = it.duration || null;
  $('player').src = objectUrl;
  if (duration) $('t-dur').textContent = fmtDur(duration);
}
let waitUntil = 0; // fino a quando l'app aspetta il prossimo vocale da aggiungere
let waitTimer = 0;
function renderWait() {
  const waiting = waitUntil > Date.now();
  show('waiting', waiting);
  const canAdd = items.length < MAX_ITEMS && !(items.length === 1 && isRecording(items[0]));
  show('add-more', !waiting && canAdd);
  clearTimeout(waitTimer);
  if (waiting) waitTimer = setTimeout(() => { waitUntil = 0; renderWait(); }, waitUntil - Date.now() + 50);
}
// il link nativo (intent://) apre WhatsApp: deve partire dal tocco, quindi qui non si aspetta nulla prima della navigazione
function addMore(e) {
  if (busy) { e.preventDefault(); return; }
  waitUntil = Date.now() + 10 * 60 * 1000;
  writeGroup(items, true, waitUntil).catch(() => {});
  setTimeout(renderWait, 300); // dopo, così il tocco non perde il suo link
}
async function cancelWait() {
  waitUntil = 0;
  try { await writeGroup(items, true, 0); } catch { /* ignora */ }
  renderWait();
}
function renderGroup() {
  renderWait();
  show('group', items.length > 1);
  $('clear').textContent = items.length > 1 ? 'Elimina tutti i vocali' : 'Elimina audio';
  $('pick-title').textContent = items.length > 1 ? 'Come vuoi elaborarli?' : 'Come vuoi elaborarlo?';
  if (items.length < 2) return;
  $('group-count').textContent = `${items.length} di ${MAX_ITEMS}`;
  $('group-total').textContent = fmtDur(totalSeconds());
  const list = $('group-list');
  list.textContent = '';
  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.className = 'g-row' + (i === curIdx ? ' on' : '');
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'g-main';
    const d = itemDate(it);
    main.textContent = `Vocale ${i + 1}` + (d ? ` · ${d}` : '');
    main.onclick = () => { selectItem(i); renderGroup(); };
    const dur = document.createElement('span');
    dur.className = 'g-dur';
    dur.textContent = it.duration ? fmtDur(it.duration) : '–:––';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'g-x';
    x.textContent = '×';
    x.setAttribute('aria-label', `Togli il vocale ${i + 1}`);
    x.onclick = () => removeItem(it.id);
    li.append(main, dur, x);
    list.appendChild(li);
  });
}
async function removeItem(id) {
  if (busy) return;
  items = items.filter((i) => i.id !== id);
  jobs.delete(id);
  evCache.delete(id);
  if (!items.length) return clearAll();
  try { await writeGroup(items, true); } catch { /* resta in memoria */ }
  selectItem(Math.min(curIdx, items.length - 1));
  renderGroup();
}

$('add-more').onclick = addMore;
$('wait-open').onclick = () => { waitUntil = Date.now() + 10 * 60 * 1000; writeGroup(items, true, waitUntil).catch(() => {}); }; // rinnova l'attesa e riapre WhatsApp
$('wait-cancel').onclick = cancelWait;
async function load(forced) {
  const shared = forced || new URLSearchParams(location.search).get('shared');
  let group;
  try { group = await readGroup(); } catch (e) { setStatus('Errore IndexedDB: ' + e, true); return; }
  history.replaceState(null, '', location.pathname);
  if (shared === 'nofile') setStatus('Condivisione ricevuta ma senza file audio.', true);
  if (shared === 'error') setStatus('Errore nel leggere il file condiviso.', true);

  items = group ? sortItems(group.items) : [];
  const ids = new Set(items.map((i) => i.id));
  for (const id of [...jobs.keys()]) if (!ids.has(id)) jobs.delete(id);
  for (const id of [...evCache.keys()]) if (!ids.has(id)) evCache.delete(id);
  if (!items.length) {
    show('group', false);
    showView('idle');
    return;
  }
  // durata di ogni vocale (serve all'elenco e al limite totale); se si supera il limite si toglie l'ultimo arrivato
  let dirty = false;
  await Promise.all(items.filter((i) => !i.duration).map(async (i) => { const d = await probeDuration(i.blob); if (d) { i.duration = d; dirty = true; } }));
  let trimmed = false;
  while (items.length > 1 && totalSeconds() > MAX_TOTAL_SECONDS) {
    let k = 0;
    items.forEach((it, i) => { if ((it.receivedAt || 0) >= (items[k].receivedAt || 0)) k = i; });
    items.splice(k, 1);
    trimmed = true;
  }
  if (dirty || trimmed) { try { await writeGroup(items, group.open); } catch { /* ignora */ } }
  curIdx = 0;
  selectItem(0);
  const isRec = items.length === 1 && isRecording(items[0]);
  $('tr-sub').textContent = isRec ? 'In inglese' : 'Sempre in italiano';
  const last = safeLS.get('vb_mode') || 'bullets';
  const r = document.querySelector(`input[name=mode][value=${TITLES[last] ? last : 'bullets'}]`);
  r.checked = true;
  syncTone();
  waitUntil = group && group.open && group.append > Date.now() && shared !== 'ok' ? group.append : 0;
  renderGroup();
  showView('pick');
  if (trimmed) setStatus('Limite di 10 minuti totali: l’ultimo vocale non è stato aggiunto.', true);
  else if (shared === 'full') setStatus(`Hai già ${MAX_ITEMS} vocali: elaborali o ricomincia.`, true);
  else if (shared === 'dup') setStatus('Questo vocale è già nell’elenco.');
  else if (shared === 'new') setStatus('Nuovo vocale: ha sostituito il precedente.');
  else if (shared === 'ok') setStatus(items.length > 1 ? `Vocale aggiunto (${items.length} di ${MAX_ITEMS}).` : 'Vocale ricevuto.');
  else setStatus(shared === 'rec' ? 'Registrazione pronta.' : '');
  // appena arriva dalla condivisione parte la trascrizione, mentre scegli la modalità; errori ignorati (si ritenta con "Elabora")
  if (shared === 'ok' || shared === 'new' || shared === 'rec') items.filter((i) => !i.text).forEach((i) => getTranscript(i).catch(() => {}));
}

// --- rete ---
const ctls = new Set();   // richieste in corso (per Annulla)
let cancelled = false;
class ApiError extends Error { constructor(code, message) { super(message); this.code = code; } }

async function api(init) {
  if (!navigator.onLine) throw new ApiError('offline', 'Nessuna connessione. L’audio resta salvato: riprova appena torni online.');
  const ctl = new AbortController();
  ctls.add(ctl);
  const timer = setTimeout(() => ctl.abort(), 120000);
  let res;
  try {
    res = await fetch(self.VB.API_URL, { ...init, signal: ctl.signal, headers: init.headers });
  } catch {
    if (cancelled) throw new ApiError('cancelled', '');
    throw new ApiError('offline', 'Connessione assente o instabile. L’audio resta salvato: riprova.');
  } finally { clearTimeout(timer); ctls.delete(ctl); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'server', data.message || 'Errore del servizio. Riprova tra poco.');
  return data;
}

function normalizedFile(it) {
  const ogg = /\.(opus|ogg|oga)$/i.test(it.name || '') || /^audio\/(ogg|opus)/i.test(it.type || '');
  if (ogg) return new File([it.blob], 'audio.ogg', { type: 'audio/ogg' });
  return new File([it.blob], it.name || 'audio', { type: (it.type || '').split(';')[0] });
}

// la trascrizione può partire in anticipo (appena arriva il vocale): una sola richiesta per vocale, salvata sul telefono
function getTranscript(it) {
  if (it.text) return Promise.resolve(it.text);
  let job = jobs.get(it.id);
  if (job) return job;
  job = (async () => {
    if (it.size > MAX_BYTES) throw new ApiError('too_big', 'Audio oltre 10 MB.');
    if (it.duration && it.duration > MAX_SECONDS) throw new ApiError('too_long', 'Audio oltre 10 minuti.');
    const fd = new FormData();
    fd.append('audio', normalizedFile(it));
    const data = await api({ method: 'POST', body: fd });
    if (!data.text) throw new ApiError('empty', 'Nessun parlato riconosciuto nell’audio.');
    it.text = data.text;
    patchItem(it.id, { text: data.text }).catch(() => {});
    return data.text;
  })().finally(() => { if (jobs.get(it.id) === job) jobs.delete(it.id); });
  jobs.set(it.id, job);
  return job;
}

// appuntamento (dove/quando/con chi): chiamata leggera, mai bloccante; uno per vocale, con la data di quel vocale
async function getEvent(it, text) {
  if (evCache.has(it.id)) return evCache.get(it.id);
  try {
    const data = await api({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'event', text }) });
    evCache.set(it.id, Array.isArray(data.events) ? data.events : (data.event ? [data.event] : []));
  } catch { return null; } // non salvo l'errore: riprova alla prossima elaborazione
  return evCache.get(it.id);
}

// --- data esatta per "domani", "sabato", ... (calcolata qui, non dal modello) ---
const DAYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const noAccents = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const EXPLICIT_DATE = /\d{1,2}\s*(\/|-)\s*\d{1,2}|\d{1,2}\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/i;
// giorno in cui il vocale è stato inviato: dal nome WhatsApp (PTT-20261003-...), altrimenti dalla ricezione
function referenceDate(it) {
  const m = /(20\d{2})(\d{2})(\d{2})/.exec((it && it.name) || '');
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]) return d;
  }
  const r = new Date((it && it.receivedAt) || Date.now());
  return new Date(r.getFullYear(), r.getMonth(), r.getDate());
}
function resolveDay(text, ref) {
  if (EXPLICIT_DATE.test(text)) return null;
  const m = /(?<!\p{L})(dopodomani|domani|domattina|oggi|stasera|stanotte|lunedì|lunedi|martedì|martedi|mercoledì|mercoledi|giovedì|giovedi|venerdì|venerdi|sabato|domenica|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?!\p{L})/iu.exec(text);
  if (!m) return null;
  const EN = { tomorrow: 'domani', today: 'oggi', tonight: 'stasera', monday: 'lunedi', tuesday: 'martedi', wednesday: 'mercoledi', thursday: 'giovedi', friday: 'venerdi', saturday: 'sabato', sunday: 'domenica' };
  const w0 = noAccents(m[1]);
  const w = EN[w0] || w0;
  let add;
  if (w === 'dopodomani') add = 2;
  else if (w === 'domani' || w === 'domattina') add = 1;
  else if (w === 'oggi' || w === 'stasera' || w === 'stanotte') add = 0;
  else add = ((DAYS.indexOf(w) - ref.getDay() + 6) % 7) + 1; // prossimo giorno con quel nome
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + add);
  const s = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const EV_FIELDS = [['what', 'Cosa'], ['when', 'Quando'], ['where', 'Dove'], ['party', 'Per'], ['who', 'Con chi']];
// --- orari: solo formattazione ("alle venti" / "alle 20" / "alle otto e mezza" -> "alle 20:00" / "alle 8:30"), nessuna deduzione ---
const UNITS_IT = { zero: 0, uno: 1, una: 1, un: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9 };
const TEENS_IT = { dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19 };
const TENS_IT = { venti: 20, trenta: 30, quaranta: 40, cinquanta: 50 };
function numIT(w) { // "20" | "venti" | "ventidue" | "trentacinque" -> numero, altrimenti null
  w = noAccents(w);
  if (/^\d{1,2}$/.test(w)) return Number(w);
  if (w in UNITS_IT) return UNITS_IT[w];
  if (w in TEENS_IT) return TEENS_IT[w];
  for (const [t, v] of Object.entries(TENS_IT)) {
    if (w === t) return v;
    for (const [u, n] of Object.entries(UNITS_IT)) {
      if (n > 0 && (w === t + u || ((u === 'uno' || u === 'otto') && w === t.slice(0, -1) + u))) return v + n;
    }
  }
  return null;
}
const pad2 = (n) => String(n).padStart(2, '0');
function formatTimes(text) {
  let out = text.replace(/\ball['’]\s*una\b/gi, 'alle 1');
  // "alle|ore" + ora (cifre o parole) + eventuali minuti ("18:30", "18.30", "e mezza", "e un quarto", "e 30")
  out = out.replace(/\b(alle|dalle|ore)\s+(?:ore\s+)?(\d{1,2})[:.](\d{2})\b/gi, (m, p, h, mi) => (Number(h) <= 24 && Number(mi) < 60 ? `${p} ${Number(h)}:${mi}` : m));
  out = out.replace(/\b(alle|dalle|ore)\s+(?:ore\s+)?([\p{L}\d]+)(?:\s+e\s+(mezza|mezzo|un quarto|[\p{L}\d]+))?(?![\p{L}\d:.])/giu, (m, p, hw, mw) => {
    const h = numIT(hw);
    if (h === null || h > 24) return m;
    let mi = 0, used = true;
    if (mw) {
      const w = noAccents(mw);
      if (w === 'mezza' || w === 'mezzo') mi = 30;
      else if (w === 'un quarto') mi = 15;
      else { const n = numIT(w); if (n !== null && n < 60 && (w.length > 2 || /^\d{2}$/.test(w))) mi = n; else used = false; }
    }
    return `${p} ${h}:${pad2(mi)}` + (mw && !used ? ' e ' + mw : '');
  });
  return out;
}
// solo formattazione, nessuna deduzione: "20" -> "alle 20:00"; "per quattro" -> "quattro" (l'etichetta è già "Per")
function evValue(k, v) {
  if (k === 'when') {
    if (/^\d{1,2}([:.]\d{2})?$/.test(v)) v = 'alle ' + v;
    return formatTimes(v);
  }
  if (k === 'party') return v.replace(/^per\s+/i, '');
  return v;
}
// una card per impegno (max 5 in tutto); le righe mancanti non esistono proprio. Ogni impegno ha la data di riferimento del suo vocale
function renderEvents(list) {
  const box = $('events');
  box.textContent = '';
  let n = 0;
  const seen = new Set();
  for (const { ev, ref } of list || []) {
    if (n >= 5) break;
    const rows = EV_FIELDS.filter(([k]) => ev[k]);
    if (!rows.length) continue;
    const key = [ev.what, ev.when, ev.where].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const card = $('ev-tpl').content.firstElementChild.cloneNode(true);
    const title = ev.kind === 'booking' ? 'Prenotazione' : 'Appuntamento';
    card.querySelector('.ev-title').textContent = title;
    let hint = null;
    for (const row of [...card.querySelectorAll('.ev-row')]) {
      const k = row.dataset.k;
      if (!ev[k]) { row.remove(); continue; }
      row.querySelector('b').textContent = evValue(k, ev[k]);
      if (k === 'when') {
        hint = resolveDay(ev.when, ref);
        const d = row.querySelector('.ev-date');
        d.hidden = !hint;
        d.textContent = hint || '';
      }
    }
    box.appendChild(card);
    lastOutput += `\n\n${title}\n` + rows.map(([k, label]) => `${label}: ${evValue(k, ev[k])}${k === 'when' && hint ? ` (${hint.toLowerCase()})` : ''}`).join('\n');
    n++;
  }
  show('events', n > 0);
  show('ev-note', n > 0);
}

const setStep = (n, state) => { $('ws-' + n).dataset.state = state; };
const SUM_LABELS = { bullets: 'Preparo il riassunto per punti', clean: 'Pulisco il testo', summary: 'Scrivo il riassunto', comment: 'Scrivo riassunto e commento', translate: 'Traduco il testo' };

async function run() {
  if (busy) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  safeLS.set('vb_mode', mode);
  busy = true;
  cancelled = false;
  setStatus('');
  $('ws-2-label').textContent = SUM_LABELS[mode] || '';
  const allDone = items.every((i) => i.text);
  setStep(1, allDone ? 'done' : 'active');
  setStep(2, allDone ? 'active' : 'pending');
  showView('working');
  history.pushState({ v: 'working' }, '');
  writeGroup(items, false).catch(() => {}); // il gruppo si chiude: la prossima condivisione ne apre uno nuovo
  try {
    // una trascrizione fallita non blocca le altre
    const settled = await Promise.allSettled(items.map((it) => getTranscript(it)));
    if (cancelled) throw new ApiError('cancelled', '');
    const good = items.map((it, i) => ({ it, i, text: settled[i].status === 'fulfilled' ? settled[i].value : null })).filter((x) => x.text);
    const failed = items.length - good.length;
    if (!good.length) throw (settled.find((r) => r.status === 'rejected') || {}).reason || new ApiError('empty', 'Nessun parlato riconosciuto.');
    setStep(1, 'done');
    setStep(2, 'active');
    const multi = good.length > 1;
    const combined = good.map((x) => x.text).join('\n\n');
    let notice = '';
    const [out, evs] = await Promise.all([
      api({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, text: combined, seconds: totalSeconds() || undefined, parts: multi ? good.length : undefined, tone: mode === 'comment' ? currentTone() : undefined, target: items.length === 1 && isRecording(items[0]) ? 'en' : 'it' }) }).then((d) => { notice = d.notice || ''; return d.result; }),
      Promise.all(good.map((x) => getEvent(x.it, x.text))),
    ]);
    if (cancelled) throw new ApiError('cancelled', '');
    renderResult(mode, out || '(risultato vuoto)');
    renderEvents(good.flatMap((x, k) => (evs[k] || []).map((ev) => ({ ev, ref: referenceDate(x.it) }))));
    show('share', !!navigator.share);
    showView('result');
    history.replaceState({ v: 'result' }, '');
    if (failed) notice = (notice ? notice + ' ' : '') + (failed === 1 ? '1 vocale non è stato trascritto.' : `${failed} vocali non sono stati trascritti.`);
    setStatus(notice);
  } catch (e) {
    showView('pick');
    if (history.state && history.state.v === 'working') { ignorePop = true; history.back(); }
    if (e.code !== 'cancelled') setStatus(e instanceof ApiError ? e.message : 'Errore imprevisto.', true);
    $('go').textContent = e.code === 'offline' ? 'Riprova' : 'Elabora';
  } finally {
    busy = false;
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
let ignorePop = false;
function cancelRun() { cancelled = true; ctls.forEach((c) => c.abort()); }
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; return; }
  if (rec) { cancelRecording(); return; } // indietro durante la registrazione = annulla
  if (busy) { cancelRun(); return; } // indietro durante l'elaborazione = annulla
  if (!items.length) return showView('idle');
  $('go').textContent = 'Elabora';
  showView(history.state && history.state.v === 'result' ? 'result' : 'pick');
});
$('cancel').onclick = () => history.back();
// --- registrazione ---
const REC_MAX = 600; // 10 minuti, come il limite del servizio
let rec = null;      // registrazione in corso
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function pickMime() {
  if (!window.MediaRecorder) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
function popHistory() { // toglie dalla cronologia la voce "registrazione" e aspetta che sia fatto
  return new Promise((res) => {
    if (!(history.state && history.state.v === 'recording')) return res();
    ignorePop = true;
    window.addEventListener('popstate', () => res(), { once: true });
    history.back();
  });
}
async function startRecording() {
  if (busy || rec) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { setStatus('Questo browser non supporta la registrazione.', true); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { setStatus('Non riesco a usare il microfono: controlla il permesso del sito.', true); return; }
  const mime = pickMime();
  let recorder;
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch { stream.getTracks().forEach((t) => t.stop()); setStatus('Registrazione non disponibile su questo telefono.', true); return; }
  rec = { recorder, stream, chunks: [], start: Date.now(), mime: recorder.mimeType || mime, cancelled: false, interrupted: false, timer: 0, lock: null };
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  recorder.onstop = finishRecording;
  const track = stream.getAudioTracks()[0];
  if (track) track.onended = () => { if (rec && rec.recorder.state === 'recording') { rec.interrupted = true; rec.recorder.stop(); } };
  recorder.start(1000);
  try { rec.lock = await navigator.wakeLock.request('screen'); } catch { /* facoltativo */ }
  $('rec-time').textContent = '0:00';
  setStatus('');
  showView('recording');
  history.pushState({ v: 'recording' }, '');
  rec.timer = setInterval(() => {
    const s = (Date.now() - rec.start) / 1000;
    $('rec-time').textContent = fmtT(s);
    if (s >= REC_MAX) stopRecording();
  }, 250);
}
function stopRecording() { if (rec && rec.recorder.state === 'recording') rec.recorder.stop(); }
function cancelRecording() { if (rec) { rec.cancelled = true; stopRecording(); } }
async function finishRecording() {
  const r = rec;
  if (!r) return;
  clearInterval(r.timer);
  r.stream.getTracks().forEach((t) => t.stop());
  try { if (r.lock) r.lock.release(); } catch { /* ignora */ }
  rec = null;
  const secs = Math.min(REC_MAX, (Date.now() - r.start) / 1000);
  const blob = new Blob(r.chunks, { type: r.mime || 'audio/webm' });
  await popHistory();
  const back = () => showView(items.length ? 'pick' : 'idle');
  if (r.cancelled) { back(); return; }
  if (secs < 1 || blob.size < 1000) { back(); setStatus('Registrazione troppo breve.', true); return; }
  const ext = /mp4/i.test(blob.type) ? 'm4a' : /ogg/i.test(blob.type) ? 'ogg' : 'webm';
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `registrazione-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`;
  try {
    await writeGroup([{ id: crypto.randomUUID(), blob, name, type: blob.type, size: blob.size, receivedAt: Date.now(), duration: secs }], false);
  } catch { back(); setStatus('Non riesco a salvare la registrazione.', true); return; }
  await load('rec');
  if (r.interrupted) setStatus('Registrazione interrotta: ho tenuto la parte registrata.');
}
$('rec-start').onclick = startRecording;
$('rec-again').onclick = startRecording;
$('rec-stop').onclick = stopRecording;
$('rec-cancel').onclick = () => history.back();

$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(lastOutput); setStatus('Copiato.'); } catch { setStatus('Copia non riuscita.', true); }
};
$('share').onclick = async () => {
  try { await navigator.share({ text: lastOutput }); } catch { /* annullato */ }
};
async function clearAll() {
  await idb('readwrite', (s) => { s.delete('group'); s.delete('latest'); });
  items = [];
  jobs.clear();
  evCache.clear();
  pausePlayer();
  player.removeAttribute('src');
  resetPlayer();
  show('group', false);
  showView('idle');
  setStatus('Audio eliminato.');
}
$('clear').onclick = () => { if (!busy) clearAll(); };
// --- invito a installare (solo chi apre il link da browser) ---
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const installSnoozed = () => Date.now() - Number(safeLS.get('vb_install_x') || 0) < 7 * 864e5;
function updateInstall() {
  const can = !isStandalone() && !installSnoozed() && (installEvent || isIOS());
  if (can) {
    $('install-msg').textContent = installEvent
      ? 'Installa VoiceBrief: la trovi tra le app e ci condividi i vocali di WhatsApp.'
      : 'Per installarla: tocca Condividi, poi «Aggiungi alla schermata Home».';
    show('install-btn', !!installEvent);
  }
  show('install', !!can && curView === 'idle');
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; updateInstall(); });
window.addEventListener('appinstalled', () => { installEvent = null; show('install', false); });
$('install-btn').onclick = async () => {
  if (!installEvent) return;
  const ev = installEvent;
  installEvent = null;
  show('install', false);
  try { await ev.prompt(); await ev.userChoice; } catch { /* annullato */ }
};
$('install-x').onclick = () => { safeLS.set('vb_install_x', String(Date.now())); show('install', false); };
updateInstall();
$('env').textContent =
  (matchMedia('(display-mode: standalone)').matches ? 'Installata' : 'Browser') + ' · v' + self.VB.VERSION;

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let updateReady = false;
  // niente cache HTTP per sw.js e per i file importati: gli aggiornamenti si vedono subito
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { reg.update().catch(() => {}); checkVersion(); } });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { updateReady = true; if (hadController) checkVersion(); });
  // controllo diretto della versione pubblicata: non dipende dal ciclo di vita del service worker
  async function checkVersion() {
    try {
      const t = await (await fetch('config.js', { cache: 'no-store' })).text();
      const m = /VERSION:\s*'([^']+)'/.exec(t);
      if (m && m[1] !== self.VB.VERSION) show('update', true);
    } catch { /* offline: riprova alla prossima apertura */ }
  }
  checkVersion();
  $('reload').onclick = async () => {
    $('reload').disabled = true;
    if (!updateReady) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
        await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 3000); });
      } catch { /* ricarico comunque */ }
    }
    location.reload();
  };
}

load();
