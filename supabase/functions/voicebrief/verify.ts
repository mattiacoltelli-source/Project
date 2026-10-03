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

export function tokens(s: string): string[] {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/[^a-z0-9]+/).filter(Boolean).map((t) => NUM[t] ?? t);
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
const GENERIC_WHAT = new Set(["ci", "vediamo", "vediamoci", "troviamo", "troviamoci", "incontriamo", "sentiamo", "vado", "andiamo", "facciamo", "incontro", "appuntamento", "evento", "cosa"]);
export function isGenericWhat(v: string | null): boolean {
  if (!v) return true;
  const toks = tokens(v).filter((t) => !STOP.has(t));
  return toks.length === 0 || toks.every((t) => GENERIC_WHAT.has(t));
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
