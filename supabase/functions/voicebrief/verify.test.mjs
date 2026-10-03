// node --experimental-strip-types supabase/functions/voicebrief/verify.test.mjs
import { tokens, supported, isBooked, isPastRef, briefSupported, splitBrief, capBullets, maxBulletsFor, isGenericWhat, cleanFaithful } from "./verify.ts";
const T = (s) => new Set(tokens(s));
const t1 = "Oh allora sabato ci vediamo alle 8, però prima devo passare da Marco a prendere la macchina, quindi magari facciamo direttamente davanti al ristorante da Gigi.";
const cases = [
  ["sabato alle 8", t1, true],
  ["sabato alle 20", t1, false],            // 8 convertito in 20: scartato
  ["sabato alle 20:00", t1, false],
  ["davanti al ristorante da Gigi", t1, true],
  ["ristorante da Gigi in centro", t1, false], // parola inventata
  ["Marco", t1, true],
  ["Marco e Laura", t1, false],              // persona inventata
  ["alle 8", "ci vediamo alle otto", true],  // numero a parole
  ["domani alle 15", "domani pomeriggio alle quindici", true],
  ["domani alle 16", "domani pomeriggio alle quindici", false],
  ["giovedì", "ci vediamo giovedi in ufficio", true], // accenti
  ["Laura e Paolo", "con Laura e Paolo per la riunione", true],
  [null, t1, false],
  ["", t1, false],
  ["alle", t1, false],                       // solo parole vuote: non basta
];
let bad = 0;
for (const [v, t, exp] of cases) {
  const got = supported(v, T(t));
  if (got !== exp) { bad++; console.log("FAIL", JSON.stringify(v), "atteso", exp, "ottenuto", got); }
}
const booked = [
  ["Ho prenotato da Gianni per quattro alle 20.", true],
  ["Abbiamo fatto la prenotazione per sabato.", true],
  ["La prenotazione è confermata da Gianni.", true],
  ["Ho prenotato da Gianni. Poi devo prenotare l'hotel.", true], // frasi separate: la prima basta
  ["Ho prenotato da Gianni, poi devo prenotare l'hotel.", false], // frase mista: prudenza (resta Appuntamento)
  ["Devo prenotare da Gianni.", false],
  ["Prenoti tu da Gianni?", false],
  ["Ho prenotato da Gianni?", false],
  ["Non ho ancora prenotato.", false],
  ["Se hai prenotato dimmelo.", false],
  ["Forse prenoto da Gianni.", false],
  ["Magari prenotiamo da Gianni sabato.", false],
  ["Ci vediamo sabato da Gianni.", false],
];
for (const [t, exp] of booked) {
  const got = isBooked(t);
  if (got !== exp) { bad++; console.log("FAIL isBooked", JSON.stringify(t), "atteso", exp, "ottenuto", got); }
}
const past = [["ieri sera", true], ["venerdì scorso", true], ["la settimana scorsa", true], ["sabato alle 20", false], ["domani alle 13", false], [null, false]];
for (const [v, exp] of past) {
  const got = isPastRef(v);
  if (got !== exp) { bad++; console.log("FAIL isPastRef", JSON.stringify(v), "atteso", exp, "ottenuto", got); }
}
const serie = "Allora ti racconto questa serie che sto guardando, c'è questa ragazza che studiava a casa e poi va in una scuola pubblica, viene bullizzata, cresce in una bolla, diversa dalle altre ragazze, poi ha il ciclo e la prendono in giro con dei video sui social e lei sviluppa la telecinesi, sposta oggetti e fa danni, diventa arrabbiata e cattiva.";
const brief = [
  ["In breve: serie TV su una ragazza bullizzata che sviluppa la telecinesi.", serie, true],
  ["Parla di una vacanza in Sicilia con la famiglia.", serie, false],      // contesto inventato
  ["Racconta di una serie sul bullismo scolastico.", serie, true],
  ["", serie, false],
];
for (const [l, t, exp] of brief) { const got = briefSupported(l, t); if (got !== exp) { bad++; console.log("FAIL briefSupported", JSON.stringify(l), "atteso", exp, "ottenuto", got); } }
const sb = splitBrief("In breve: una serie TV.\n- uno\n- due");
if (sb.brief !== "una serie TV." || sb.rest !== "- uno\n- due") { bad++; console.log("FAIL splitBrief", JSON.stringify(sb)); }
if (splitBrief("- uno\n- due").brief !== null) { bad++; console.log("FAIL splitBrief senza riga"); }
const eight = "In breve: x.\n" + Array.from({ length: 8 }, (_, i) => `- p${i + 1}`).join("\n");
const capped = capBullets(eight, 6);
if (capped.split("\n").filter((l) => l.startsWith("- ")).length !== 6 || !capped.startsWith("In breve")) { bad++; console.log("FAIL capBullets", JSON.stringify(capped)); }
for (const [s, exp] of [[74, 7], [60, 6], [30, 3], [10, 3], [300, 15], [600, 15]]) { if (maxBulletsFor(s) !== exp) { bad++; console.log("FAIL maxBulletsFor", s, maxBulletsFor(s), "atteso", exp); } }
for (const [w, exp] of [["ci vediamo", true], ["incontro", true], ["appuntamento", true], [null, true], ["partita del Bologna", false], ["colazione", false], ["riunione", false], ["ci vediamo per la colazione", false]]) {
  const got = isGenericWhat(w); if (got !== exp) { bad++; console.log("FAIL isGenericWhat", JSON.stringify(w), "atteso", exp, "ottenuto", got); }
}
const orig = "Ehm allora, cioè, domani alle 15, tipo, ci vediamo in ufficio, ehm, con Laura e Paolo, cioè, per la riunione di progetto.";
for (const [o, exp, why] of [
  ["Domani alle 15 ci vediamo in ufficio con Laura e Paolo per la riunione di progetto.", true, "pulito ok"],
  ["Allora, domani alle 15 ci vediamo in ufficio con Laura e Paolo, per la riunione di progetto.", true, "pulito ok con punteggiatura"],
  ["Domani alle 16 ci vediamo in ufficio con Laura e Paolo per la riunione di progetto.", false, "numero cambiato"],
  ["Domani alle 15 ci vediamo in ufficio con Laura e Paolo per la riunione di progetto, porta anche il computer.", false, "parole aggiunte"],
  ["Riunione domani alle 15.", false, "troppo corto: è un riassunto"],
  ["Domani alle 15 ci vediamo in ufficio con Laura e Marco per la riunione di progetto.", false, "persona cambiata"],
  ["", false, "vuoto"],
]) { const got = cleanFaithful(o, orig); if (got !== exp) { bad++; console.log("FAIL cleanFaithful", why, "atteso", exp, "ottenuto", got); } }
console.log(bad ? `${bad} falliti` : "tutti ok");
process.exit(bad ? 1 : 0);
