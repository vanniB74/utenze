# C.S.I. Front Office — Adapter Vercel

## TL;DR

Il rigenerato `crm.js` NON può girare su Vercel serverless. Le due architetture sono incompatibili. Per deployarlo serve una piattaforma con processo long-running + filesystem persistente (Railway, Render, Fly.io, VPS). Vedi `README-deploy.md`.

## Perché non funziona su Vercel

Vercel serverless ha tre vincoli fondamentali che il rigenerato viola:

### 1. Processi long-running non supportati
`crm.js` avvia un server HTTP con `http.createServer(...).listen(PORT)` (riga 1693 di `crm.js`). Vercel serverless esegue handler per-request con un timeout massimo (60s nel piano free, 300s nel Pro). Non c'è `listen()`.

### 2. Filesystem persistente non disponibile
`crm.js` usa `node:sqlite` con `DATABASE_URL=file:/data/crm.sqlite` (riga 458). Il filesystem di una funzione serverless è **ephemeral**: ogni invocazione parte da un'immagine read-only, le scritture in `/tmp` sopravvivono solo per la durata dell'invocazione. Il DB verrebbe perso a ogni cold start.

### 3. SQLite non è adatto a multi-istanza
Anche se si montasse un volume persistent (Vercel non offre volumi persistent), ogni funzione serverless è una nuova istanza che aprirebbe il DB SQLite indipendentemente. SQLite supporta un solo writer alla volta; con N funzioni in parallelo si otterrebbero errori `database is locked`.

## Cosa fare se DEVI stare su Vercel

Hai tre opzioni, in ordine di sforzo crescente:

### Opzione 1 — Continua a usare l'ORIGINALE (consigliata se già su Vercel)

L'originale (`src/`, Next.js 16 + Prisma + Turso) è già architettato per Vercel. Applica il **Lotto L1** del `report-divergenze.md` (7 fix di sicurezza critiche, ~2 ore di lavoro) e ridistribuiscilo:

```bash
cd /home/z/my-project/upload/extracted/workspace/csi-crm-deploy
# Applica le 7 fix del Lotto L1 (vedi report-divergenze.md §8.L1)
# ...
vercel deploy --yes --prod
```

Le funzionalità del rigenerato che mancano all'originale (QR operatori, brogliaccio, sessione operatore duratura) sono nel **Lotto L2** del `report-divergenze.md` (4 BUG, ~4 ore).

### Opzione 2 — Riadatta il rigenerato per Vercel (NON raccomandato)

Per far girare il rigenerato su Vercel dovresti:

1. **Sostituire `node:sqlite` con un DB esterno**:
   - Turso (`@libsql/client`) o Neon Postgres o PlanetScale
   - Riscrivere tutte le `db.prepare(...).run()` / `.get()` con il client asincrono
   - Riscrivere le migrazioni come script Prisma separati

2. **Splittare `crm.js` in route handlers Next.js**:
   - 56 route → 56 file in `src/app/api/*/route.ts`
   - Ciascun handler diventa `export async function GET/POST(req: Request)`
   - Il router custom (`route()` + `dispatch()`) è eliminato

3. **Sostituire `http.createServer` con il server Next.js**:
   - Le 2 pagine HTML (`/` home e `/operator/:token` login) diventano `src/app/page.tsx` e `src/app/operator/[token]/page.tsx`
   - I cookie di sessione (`Set-Cookie`) diventano `next/headers` o `cookies()`

4. **Sostituire la tabella `setup_state` con variabili ambiente**:
   - `master_email`, `master_password_hash` diventano env vars o una tabella dedicata
   - `master_session_<hash>` diventa un cookie + tabella sessions

**Sforzo stimato**: 12-16 ore. **Risultato**: ricostruire l'originale, ma con il design del rigenerato. Sconsigliato.

### Opzione 3 — Vercel + Docker (solo Vercel Pro+)

Vercel supporta container deploy via `vercel.json` con `"functions": { "runtime": "@vercel/docker" }`. Tuttavia:

- Anche con Docker, le funzioni hanno il timeout serverless (60-300s)
- Il filesystem ephemeral rimane (nessun volume persistent)
- Il DB SQLite si perderebbe a ogni cold start

Questa opzione risolve solo il problema del runtime, non quello del DB. Sconsigliato.

## Conclusione

Se l'utente è bloccato su Vercel per ragioni organizzative, l'**Opzione 1** (continuare con l'originale + applicare Lotto L1) è la strada consigliata: sforzo minimo, mantiene il deploy esistente, risolve i 7 BUG critici di sicurezza, e i 4 BUG bloccanti del QR operatori sono nel Lotto L2.

Se l'utente è libero di scegliere la piattaforma, **Railway/Render/Fly.io/VPS** con il rigenerato è più semplice, più economico, e ha zero dipendenze esterne (no supply chain).
