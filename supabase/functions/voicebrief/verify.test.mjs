// node --experimental-strip-types supabase/functions/voicebrief/verify.test.mjs
import { tokens, supported } from "./verify.ts";
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
console.log(bad ? `${bad} falliti` : `tutti ok (${cases.length})`);
process.exit(bad ? 1 : 0);
