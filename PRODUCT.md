# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Il proprietario del progetto e persone vicine (amici, famiglia). Parlano italiano e usano Android con Chrome, con l'app installata come PWA. Ricevono vocali WhatsApp lunghi che non possono ascoltare in quel momento (riunione, treno, senza cuffie) e vogliono capire in fretta cosa viene chiesto o detto.

## Product Purpose
VoiceBrief trascrive e riassume i vocali di WhatsApp. L'utente li condivide all'app dal menu "Condividi" (oppure registra un vocale nell'app), sceglie una modalità e legge il risultato. Successo: capire il contenuto di un vocale in pochi secondi, senza ascoltarlo, e poter copiare o inoltrare il testo.

## Positioning
Si inserisce nel gesto già noto di WhatsApp (tieni premuto, Condividi, scegli l'app), senza account né copia di file. Estrae anche gli impegni (cosa, quando, dove, con chi) quando il vocale ne contiene.

## Operating Context
- Uso da telefono, spesso con una mano, a volte con poca attenzione.
- Il vocale arriva dal Web Share Target; il service worker lo salva in IndexedDB e l'app lo apre.
- Si possono aggiungere più vocali nello stesso gruppo (max 10, 10 minuti totali).
- Le richieste vanno a una funzione Supabase che usa OpenAI.

## Capabilities and Constraints
- Modalità: riassunto per punti, testo pulito, riassunto, traduzione, commento (tono serio o pungente).
- Lingua del vocale: italiano o automatica. Uscita in italiano; la registrazione in app può tradurre in inglese.
- Estrazione di appuntamenti con controlli deterministici contro invenzioni (`verify.ts`).
- Funziona come PWA installabile; la condivisione da WhatsApp richiede l'installazione.
- Costi: tetto mensile di circa 1 euro, applicato dalla funzione. Nessuna funzione a pagamento in più senza approvazione.
- Interfaccia e testi in italiano.

## Brand Commitments
- Il nome VoiceBrief e l'icona attuale restano.
- Il flusso di condivisione da WhatsApp e le cinque modalità non cambiano.
- Tono sobrio, orientato all'uso rapido. Il verde-teal attuale è l'identità esistente, non un vincolo esplicito.

## Evidence on Hand
- App funzionante pubblicata su GitHub Pages: https://mattiacoltelli-source.github.io/voicebrief/
- Icone in `icons/`, manifest in `manifest.webmanifest`.
- Nessun testimonial, metrica d'uso o dato di mercato: non vanno inventati.

## Product Principles
1. Leggere deve costare meno che ascoltare: il risultato è il centro, il resto sta in secondo piano.
2. Il gesto di condivisione da WhatsApp non cambia e non si complica.
3. Mai inventare: nomi, numeri e orari devono venire dal vocale.
4. Costi e peso contenuti: niente dipendenze o servizi in più senza motivo.
5. Mobile first, offline per quanto possibile.

## Accessibility & Inclusion
Bersagli touch di almeno 44px, contrasto leggibile all'aperto, rispetto di `prefers-reduced-motion`. Interfaccia in italiano.
