// Controllo anti-allucinazione: un campo estratto vale solo se ogni parola significativa
// compare davvero nella trascrizione (numeri scritti a parole = cifre). Altrimenti viene scartato.
const NUM: Record<string, string> = {
  uno: "1", una: "1", due: "2", tre: "3", quattro: "4", cinque: "5", sei: "6", sette: "7", otto: "8", nove: "9",
  dieci: "10", undici: "11", dodici: "12", tredici: "13", quattordici: "14", quindici: "15", sedici: "16",
  diciassette: "17", diciotto: "18", diciannove: "19", venti: "20", ventuno: "21", ventidue: "22",
  ventitre: "23", ventiquattro: "24",
  // inglese (stessi numeri a parole = cifre, per confrontare "seven" e "7")
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20",
};
const STOP = new Set([
  "il", "lo", "la", "le", "i", "gli", "un", "l", "di", "del", "dello", "della", "dei", "degli", "delle",
  "da", "dal", "dallo", "dalla", "in", "nel", "nella", "a", "al", "alla", "alle", "allo", "ai", "con", "e", "ed",
  "per", "su", "sul", "ore", "ora",
]);

// numeri italiani composti ("venticinque", "trentuno", "cento", "duemila") -> cifre, così "duemila" e "2000" coincidono
const UNITS: Record<string, number> = { uno: 1, un: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9 };
const TENS: Record<string, number> = { venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90 };
function itNumber(w: string): string | null {
  if (w === "cento") return "100";
  if (w === "mille") return "1000";
  const th = /^(due|tre|quattro|cinque|sei|sette|otto|nove|dieci)mila$/.exec(w);
  if (th) return String((th[1] === "dieci" ? 10 : UNITS[th[1]]) * 1000);
  for (const [t, v] of Object.entries(TENS)) {
    if (w === t) return String(v);
    const stem = t.slice(0, -1); // "venti" -> "vent" (ventuno, ventotto) oppure "venti"+unit (ventidue)
    for (const [u, n] of Object.entries(UNITS)) {
      if (w === t + u || ((u === "uno" || u === "otto") && w === stem + u)) return String(v + n);
    }
  }
  return null;
}

export function tokens(s: string): string[] {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/[^a-z0-9]+/).filter(Boolean).map((t) => NUM[t] ?? itNumber(t) ?? t);
}

export function supported(value: string | null, textTokens: Set<string>): boolean {
  if (!value) return false;
  const toks = tokens(value).filter((t) => !STOP.has(t));
  return toks.length > 0 && toks.every((t) => textTokens.has(t));
}

// "Prenotazione" solo se qualcuno dice di aver GIÀ prenotato: serve una forma conclusa ("ho prenotato",
// "la prenotazione") in una frase senza dubbio, intenzione, richiesta, negazione o domanda.
const BOOKED = /\b(prenotat[oaie]|prenotazion[ei])\b/i;
const HEDGE = /\b(non|ancora|forse|magari|se|potrei|potremmo|dovrei|dovremmo|vorrei|voglio|devo|dobbiamo|prenoti|prenota|prenotare|prenotiamo|prenoterò|prenotero|boh)\b/i;
export function isBooked(text: string): boolean {
  const sentences = text.match(/[^.!?\n]+[.!?]?/g) ?? [];
  return sentences.some((s) => BOOKED.test(s) && !HEDGE.test(s) && !s.trim().endsWith("?"));
}

// un "quando" già passato ("ieri sera", "venerdì scorso") non è un appuntamento
const PAST = /\b(ieri|altroieri|scors[oaie])\b/i;
export function isPastRef(v: string | null): boolean {
  return !!v && PAST.test(v);
}

// --- riassunto per punti: riga "In breve" e tetto ai punti ---
// "In breve" regge solo se le sue parole principali (radici di 5 lettere) compaiono davvero nel vocale.
const GENERIC = new Set(["racconta", "parla", "descrive", "spiega", "tratta", "presenta", "riguarda", "vocale", "messaggio", "breve", "persona"]);
export function briefSupported(line: string, text: string): boolean {
  const stem = (t: string) => t.slice(0, 5);
  const textStems = new Set(tokens(text).map(stem));
  const content = tokens(line).filter((t) => t.length >= 4 && !STOP.has(t) && !GENERIC.has(t));
  if (content.length === 0) return false;
  return content.filter((t) => textStems.has(stem(t))).length / content.length >= 0.6;
}

export function splitBrief(out: string): { brief: string | null; rest: string } {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.trim());
  const m = i >= 0 ? /^\s*in breve\s*[:\-–]\s*(.+)$/i.exec(lines[i]) : null;
  if (!m) return { brief: null, rest: out };
  return { brief: m[1].trim(), rest: lines.slice(i + 1).join("\n").replace(/^\n+/, "") };
}

// tetto rigido ai punti elenco: oltre il massimo si scartano i successivi
export function capBullets(out: string, max: number): string {
  let n = 0;
  return out
    .split("\n")
    .filter((l) => (/^\s*([-*•]|\d+[.)])\s+/.test(l) ? ++n <= max : true))
    .join("\n");
}

// massimo 6 punti al minuto (1 ogni 10 s), tra 3 e 15
export function maxBulletsFor(seconds: number): number {
  return Math.min(15, Math.max(3, Math.round(seconds / 10)));
}

// "cosa" troppo generico ("ci vediamo", "incontro") non informa: lo si scarta
const GENERIC_WHAT = new Set(["ci", "vediamo", "vediamoci", "troviamo", "troviamoci", "incontriamo", "sentiamo", "vado", "andiamo", "facciamo", "incontro", "appuntamento", "evento", "cosa", "mangiare", "cenare", "pranzare", "uscire", "venire", "andare", "passare", "trovarci", "vederci", "vedersi", "incontrarci", "incontrarsi", "mangiamo", "andiamo", "usciamo"]);
export function isGenericWhat(v: string | null): boolean {
  if (!v) return true;
  const toks = tokens(v).filter((t) => !STOP.has(t));
  return toks.length === 0 || toks.every((t) => GENERIC_WHAT.has(t));
}

// "mangiare da Nonna Rosa" + dove "da Nonna Rosa": il luogo sta già in "Dove", dal "Cosa" si toglie
const PLACE_PREPS = new Set(["da", "dal", "dalla", "dallo", "al", "alla", "allo", "a", "in", "presso", "di", "del", "della", "nel", "nella"]);
export function stripPlace(what: string | null, where: string | null): string | null {
  if (!what || !where) return what;
  const wt = new Set(tokens(where).filter((t) => !PLACE_PREPS.has(t)));
  if (wt.size === 0) return what;
  const kept = what.split(/\s+/).filter((w) => {
    const t = tokens(w)[0];
    return !(t && wt.has(t));
  });
  while (kept.length && PLACE_PREPS.has(tokens(kept[kept.length - 1])[0] ?? "")) kept.pop();
  const out = kept.join(" ").trim();
  return out || null;
}

// "cosa" che ripete solo il luogo ("McDonald's" / "McDonald's") non informa: lo si scarta
export function sameAsWhere(what: string | null, where: string | null): boolean {
  if (!what || !where) return false;
  const w = tokens(what).filter((t) => !STOP.has(t)), d = new Set(tokens(where).filter((t) => !STOP.has(t)));
  return w.length > 0 && w.every((t) => d.has(t));
}

// --- "Testo pulito": può togliere esitazioni e ripetizioni, non aggiungere né cambiare nulla ---
// Valida solo se: (1) quasi tutte le parole significative (radici di 5 lettere) c'erano già nel vocale,
// (2) ogni numero c'era già, (3) la lunghezza resta plausibile (non è un riassunto né una riscrittura più lunga).
export function cleanFaithful(out: string, text: string): boolean {
  const stem = (t: string) => t.slice(0, 5);
  const inTok = tokens(text);
  const outTok = tokens(out);
  if (outTok.length === 0) return false;
  const inStems = new Set(inTok.map(stem));
  const inAll = new Set(inTok);
  // parole unite o divise dal rifacimento ("can not" -> "cannot") non sono aggiunte: si confrontano anche le coppie adiacenti unite
  const joined = new Set(inTok.slice(1).map((t, i) => stem(inTok[i] + t)));
  const known = (t: string) => inStems.has(stem(t)) || joined.has(stem(t));
  const content = outTok.filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t));
  if (content.length > 0 && content.filter(known).length / content.length < 0.92) return false;
  if (outTok.filter((t) => /^\d+$/.test(t)).some((n) => !inAll.has(n))) return false;
  const ratio = outTok.length / Math.max(1, inTok.length);
  return ratio >= 0.4 && ratio <= 1.15;
}

// una card con un solo dato (es. solo "domani") non serve: ne servono almeno due tra quando, dove, con chi, per quanti
export function usefulEvent(e: { when: string | null; where: string | null; who: string | null; party: string | null }): boolean {
  return [e.when, e.where, e.who, e.party].filter(Boolean).length >= 2;
}

// --- "Riassunto" in prosa ---
// il testo è italiano? (parole funzione molto frequenti): serve a sapere se ha senso confrontare le radici delle parole
const IT_WORDS = new Set(["il", "lo", "la", "le", "gli", "un", "una", "di", "che", "e", "non", "per", "con", "su", "ma", "mi", "ti", "ci", "si", "sono", "ho", "hai", "ha", "è", "alle", "del", "della", "dei", "come", "anche", "più", "se", "da", "in", "al"]);
export function isItalianText(text: string): boolean {
  const toks = text.toLowerCase().split(/[^a-zà-ù]+/).filter(Boolean);
  if (toks.length < 5) return false;
  return toks.filter((t) => IT_WORDS.has(t)).length / toks.length >= 0.25;
}

// Il riassunto non deve contenere numeri, nomi propri o troppe parole importanti assenti dal vocale.
// Numeri e nomi propri si controllano sempre; la sovrapposizione delle parole solo se l'audio è italiano come il riassunto
// (altrimenti è una traduzione). Un riassunto riformula, quindi la soglia è bassa: serve a prendere le invenzioni evidenti.
export function summaryFaithful(out: string, text: string): boolean {
  const outTok = tokens(out);
  if (outTok.length === 0) return false;
  const inTok = tokens(text);
  const inAll = new Set(inTok);
  // i numeri si confrontano senza gli articoli "un/uno/una" (che sarebbero "1")
  const noArt = (x: string) => x.replace(/\b(un|uno|una|one)\b/gi, " ");
  const inNums = new Set(tokens(noArt(text)));
  if (tokens(noArt(out)).filter((t) => /^\d+$/.test(t)).some((n) => !inNums.has(n))) return false;
  // nomi propri (maiuscola a metà frase) che nel vocale non ci sono
  for (const sentence of out.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/).slice(1);
    for (const w of words) {
      const m = /^[("'«]*([A-ZÀ-Ù][a-zà-ù]{2,})/.exec(w);
      if (m && !inAll.has(tokens(m[1])[0])) return false;
    }
  }
  if (!isItalianText(text)) return true;
  const stem = (t: string) => t.slice(0, 4); // radici corte: il riassunto riformula i verbi (vieni -> viene)
  const inStems = new Set(inTok.map(stem));
  const joined = new Set(inTok.slice(1).map((t, i) => stem(inTok[i] + t)));
  const content = outTok.filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t) && !SUMMARY_FILLER.has(t));
  if (content.length === 0) return true;
  return content.filter((t) => inStems.has(stem(t)) || joined.has(stem(t))).length / content.length >= 0.55;
}

// frasi che dichiarano ciò che manca ("Non ci sono richieste specifiche"): non informano, si tolgono
export function dropEmptyClaims(out: string): string {
  const kept = out.split(/(?<=[.!?])\s+/).filter((s) => !/\b(non ci sono|non vi sono|nessuna|nessun)\b.*\b(richiest|domand|azion|impegn|appuntament|scadenz|indicazion)/i.test(s));
  return kept.join(" ").trim();
}
// parole di raccordo del riassunto ("chi parla", "propone", "chiede"...) che non devono essere nel vocale
const SUMMARY_FILLER = new Set(["parla", "chiede", "propone", "dice", "racconta", "spiega", "invita", "domanda", "avvisa", "ricorda", "vuole", "vorrebbe", "chiedere", "aspetta", "comunica", "informa", "annuncia", "ringrazia", "saluta", "anche", "inoltre", "quindi", "infine", "poi"]);

// massimo di frasi: circa una ogni 12 secondi, tra 2 e 7
export function maxSentencesFor(seconds: number): number {
  return Math.min(7, Math.max(2, Math.round(seconds / 12)));
}
