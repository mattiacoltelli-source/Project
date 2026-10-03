const $ = (id) => document.getElementById(id);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SECONDS = 10 * 60;
const TITLES = { full: 'Trascrizione completa', bullets: 'Riassunto per punti', clean: 'Testo pulito', translate: 'Traduzione' };
const safeLS = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
};

let entry = null;        // file ricevuto (da IndexedDB)
let duration = null;     // secondi, dai metadati del player
let transcript = null;   // solo in memoria: cambiare modalità non richiama l'STT
let eventInfo;           // impegni estratti: undefined = non ancora chiesti, [] = nessuno
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
const setStatus = (msg, isErr) => { $('status').textContent = msg || ''; $('status').classList.toggle('err', !!isErr); };
const show = (id, on) => { $(id).hidden = !on; };

function showView(view) { // 'idle' | 'pick' | 'recording' | 'working' | 'result'
  show('idle', view === 'idle');
  show('recording', view === 'recording');
  show('working', view === 'working');
  show('pick', view === 'pick');
  show('result', view === 'result');
  show('brand', view !== 'result');
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
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const [i, l] of lines.entries()) {
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
    const el = document.createElement(m ? 'div' : 'p');
    if (m) el.className = 'item';
    el.textContent = (m ? m[2] : l).replace(/\*\*/g, '');
    box.appendChild(el);
  }
  $('result-title').textContent = TITLES[mode];
}

// registrazione fatta nell'app (nome 'registrazione-…'): la traduzione va in inglese, per scrivere a qualcuno in inglese
const isRecording = (e) => !!e && /^registrazione-/.test(e.name || '');

async function load(forced) {
  const shared = forced || new URLSearchParams(location.search).get('shared');
  try { entry = await idb('readonly', (s) => s.get('latest')); } catch (e) { setStatus('Errore IndexedDB: ' + e, true); return; }
  history.replaceState(null, '', location.pathname);
  if (shared === 'nofile') setStatus('Condivisione ricevuta ma senza file audio.', true);
  if (shared === 'error') setStatus('Errore nel leggere il file condiviso.', true);

  if (!entry) {
    showView('idle');
    return;
  }
  transcript = null;
  transcriptJob = null;
  eventInfo = undefined;
  duration = entry.duration || null; // registrazioni: durata nota dal timer (il webm di MediaRecorder non la dichiara)
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(entry.blob);
  resetPlayer();
  $('player').src = objectUrl;
  if (duration) $('t-dur').textContent = fmtDur(duration);
  const isRec = isRecording(entry);
  $('tr-sub').textContent = isRec ? 'In inglese' : 'Sempre in italiano';
  const last = safeLS.get('vb_mode') || 'bullets';
  const r = document.querySelector(`input[name=mode][value=${TITLES[last] ? last : 'bullets'}]`);
  r.checked = true;
  showView('pick');
  setStatus(shared === 'ok' ? 'Vocale ricevuto.' : shared === 'rec' ? 'Registrazione pronta.' : '');
  // appena arriva dalla condivisione parte la trascrizione, mentre scegli la modalità; errori ignorati (si ritenta con "Elabora")
  if (shared === 'ok' || shared === 'rec') getTranscript().catch(() => {});
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

function normalizedFile() {
  const ogg = /\.(opus|ogg|oga)$/i.test(entry.name || '') || /^audio\/(ogg|opus)/i.test(entry.type || '');
  if (ogg) return new File([entry.blob], 'audio.ogg', { type: 'audio/ogg' });
  return new File([entry.blob], entry.name || 'audio', { type: (entry.type || '').split(';')[0] });
}

// la trascrizione può partire in anticipo (appena arriva il vocale): una sola richiesta, riusata da "Elabora"
let transcriptJob = null;
function getTranscript() {
  if (transcript !== null) return Promise.resolve(transcript);
  if (!transcriptJob) {
    const mine = entry;
    const job = (async () => {
      if (mine.size > MAX_BYTES) throw new ApiError('too_big', 'Audio oltre 10 MB.');
      if (duration && duration > MAX_SECONDS) throw new ApiError('too_long', 'Audio oltre 10 minuti.');
      const fd = new FormData();
      fd.append('audio', normalizedFile());
      const data = await api({ method: 'POST', body: fd });
      if (!data.text) throw new ApiError('empty', 'Nessun parlato riconosciuto nell’audio.');
      if (entry === mine) transcript = data.text; // se nel frattempo è arrivato un altro vocale, scarta
      return data.text;
    })().finally(() => { if (transcriptJob === job) transcriptJob = null; });
    transcriptJob = job;
  }
  return transcriptJob;
}

// appuntamento (dove/quando/con chi): chiamata leggera, mai bloccante
async function getEvent(text) {
  if (eventInfo !== undefined) return eventInfo;
  try {
    const data = await api({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'event', text }) });
    eventInfo = Array.isArray(data.events) ? data.events : (data.event ? [data.event] : []);
  } catch { return null; } // non salvo l'errore: riprova alla prossima elaborazione
  return eventInfo;
}

// --- data esatta per "domani", "sabato", ... (calcolata qui, non dal modello) ---
const DAYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const noAccents = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const EXPLICIT_DATE = /\d{1,2}\s*(\/|-)\s*\d{1,2}|\d{1,2}\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/i;
// giorno in cui il vocale è stato inviato: dal nome WhatsApp (PTT-20261003-...), altrimenti dalla ricezione
function referenceDate() {
  const m = /(20\d{2})(\d{2})(\d{2})/.exec((entry && entry.name) || '');
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]) return d;
  }
  const r = new Date((entry && entry.receivedAt) || Date.now());
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
// solo formattazione, nessuna deduzione: "20" -> "alle 20"; "per quattro" -> "quattro" (l'etichetta è già "Per")
function evValue(k, v) {
  if (k === 'when' && /^\d{1,2}([:.]\d{2})?$/.test(v)) return 'alle ' + v;
  if (k === 'party') return v.replace(/^per\s+/i, '');
  return v;
}
// una card per impegno (max 3); le righe mancanti non esistono proprio
function renderEvents(list) {
  const box = $('events');
  box.textContent = '';
  const ref = referenceDate();
  let n = 0;
  for (const ev of list || []) {
    const rows = EV_FIELDS.filter(([k]) => ev[k]);
    if (!rows.length) continue;
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
const SUM_LABELS = { bullets: 'Preparo il riassunto per punti', clean: 'Pulisco il testo', translate: 'Traduco il testo' };

async function run() {
  if (busy) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  safeLS.set('vb_mode', mode);
  busy = true;
  cancelled = false;
  setStatus('');
  $('ws-2').hidden = mode === 'full';
  $('ws-2-label').textContent = SUM_LABELS[mode] || '';
  setStep(1, transcript !== null ? 'done' : 'active');
  setStep(2, transcript !== null && mode !== 'full' ? 'active' : 'pending');
  showView('working');
  history.pushState({ v: 'working' }, '');
  try {
    const text = await getTranscript();
    if (cancelled) throw new ApiError('cancelled', '');
    setStep(1, 'done');
    if (mode !== 'full') setStep(2, 'active');
    let notice = '';
    const [out, ev] = await Promise.all([
      mode === 'full' ? text : api({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, text, seconds: duration || undefined, target: isRecording(entry) ? 'en' : 'it' }) }).then((d) => { notice = d.notice || ''; return d.result; }),
      getEvent(text),
    ]);
    if (cancelled) throw new ApiError('cancelled', '');
    renderResult(mode, out || '(risultato vuoto)');
    renderEvents(ev);
    show('share', !!navigator.share);
    showView('result');
    history.replaceState({ v: 'result' }, '');
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
  if (!entry) return showView('idle');
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
  const back = () => showView(entry ? 'pick' : 'idle');
  if (r.cancelled) { back(); return; }
  if (secs < 1 || blob.size < 1000) { back(); setStatus('Registrazione troppo breve.', true); return; }
  const ext = /mp4/i.test(blob.type) ? 'm4a' : /ogg/i.test(blob.type) ? 'ogg' : 'webm';
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `registrazione-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`;
  try {
    await idb('readwrite', (s) => s.put({ blob, name, type: blob.type, size: blob.size, receivedAt: Date.now(), duration: secs }, 'latest'));
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
$('clear').onclick = async () => {
  await idb('readwrite', (s) => s.delete('latest'));
  entry = null; transcript = null; eventInfo = undefined;
  pausePlayer();
  player.removeAttribute('src');
  resetPlayer();
  showView('idle');
  setStatus('Audio eliminato.');
};
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
