// Controllo anti-allucinazione: un campo estratto vale solo se ogni parola significativa
// compare davvero nella trascrizione (numeri scritti a parole = cifre). Altrimenti viene scartato.
const NUM: Record<string, string> = {
  uno: "1", una: "1", due: "2", tre: "3", quattro: "4", cinque: "5", sei: "6", sette: "7", otto: "8", nove: "9",
  dieci: "10", undici: "11", dodici: "12", tredici: "13", quattordici: "14", quindici: "15", sedici: "16",
  diciassette: "17", diciotto: "18", diciannove: "19", venti: "20", ventuno: "21", ventidue: "22",
  ventitre: "23", ventiquattro: "24",
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
