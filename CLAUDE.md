# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Cos'è

VoiceBrief è una PWA in italiano che trascrive e riassume i vocali di WhatsApp: l'utente li condivide all'app (Web Share Target) o li registra, poi sceglie una modalità (punti, testo pulito, riassunto, traduzione, commento). Il testo dell'interfaccia e dei prompt è in italiano.

## Comandi

- Nessuna build, nessun package manager: frontend in JS/CSS/HTML statici, serviti dalla radice del repo. Per provarlo in locale basta un server statico (es. `python3 -m http.server`); il service worker richiede `localhost` o HTTPS.
- Test della logica di verifica del backend (unico test del repo): `node --experimental-strip-types supabase/functions/voicebrief/verify.test.mjs` (stampa "tutti ok").
- Deploy frontend: il workflow `.github/workflows/pages.yml` pubblica la radice su GitHub Pages a ogni push su `main`. La funzione Supabase va distribuita a parte (Supabase deploy), non dal workflow.

## Architettura

**Frontend (radice del repo, senza framework)**
- `index.html` contiene tutte le schermate come `<section>` (`idle`, `recording`, `working`, `pick`, `result`); `showView()` in `app.js` ne mostra una sola. `style.css` è l'unico foglio di stile.
- `app.js` (un solo file, stato in variabili di modulo) gestisce player, gruppo di vocali, registrazione con `MediaRecorder`, chiamate API ed estrazione degli impegni (date e orari risolti anche in locale con `resolveDay`/`formatTimes`).
- Persistenza: IndexedDB `voicebrief` / store `files`. La chiave `group` contiene `{ items, open, updated, append }`: l'insieme dei vocali in attesa (max 10, 10 minuti totali). La chiave `latest` è il formato vecchio, ancora letta. `localStorage` serve solo a preferenze, sempre via `safeLS` (può lanciare eccezioni).
- `sw.js` ha due compiti: (1) intercetta il `POST` su `share-target` (dichiarato in `manifest.webmanifest`), salva i file condivisi in IndexedDB con `addShared` e reindirizza a `./?shared=<stato>`; (2) cache della shell, network-first con ripiego sulla cache. `app.js` e `sw.js` condividono lo stesso schema IndexedDB: se cambi uno, cambia l'altro.
- `config.js` è condiviso da pagina e service worker (`self.VB`: `VERSION`, `API_URL`). **Ogni modifica a file in `SHELL` (in `sw.js`) va accompagnata da un incremento di `VERSION`**, altrimenti la PWA installata non si aggiorna. Il banner "Nuova versione" si basa sul confronto tra `config.js` remoto e quello caricato.

**Backend (`supabase/functions/voicebrief/`, Deno)**
- `index.ts`: unica Edge Function, accetta audio o testo e usa OpenAI (modelli configurabili via env: `OPENAI_STT_MODEL`, `OPENAI_LLM_MODEL`, `OPENAI_FUN_MODEL`). Accetta richieste solo dall'origine GitHub Pages (`ORIGIN`). Ha un tetto di spesa mensile (`MONTHLY_CAP_MICRO_USD`, circa 1 euro) applicato con la RPC Supabase `vb_reserve` prima di ogni chiamata a pagamento, con stime di costo e margine di sicurezza.
- I prompt dipendono dalla durata del vocale (`maxSentencesFor`, `maxBulletsFor`) e il modello più costoso si usa solo per il tono "pungente", con ripiego su quello normale.
- `verify.ts`: controlli deterministici sull'output del modello (nomi, numeri e orari devono comparire nel testo originale, filtri su commenti e impegni). Se un controllo fallisce, la funzione riprova una volta con un avviso nel prompt. Le modifiche ai prompt o alle regole vanno coperte da casi in `verify.test.mjs`.

## Convenzioni

- Copy, commenti e nomi dei prompt sono in italiano: mantieni lo stesso registro.
- Frontend pensato per mobile (Chrome/Android installato come PWA, intent `whatsapp://`): target touch di almeno 44px, rispetta `prefers-reduced-motion`.
