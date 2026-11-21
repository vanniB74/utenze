# C.S.I. Front Office — CRM Rigenerato · Deploy

## Cos'è

File unico Node.js (`crm.js`, 1 712 righe) con zero dipendenze esterne. Usa solo moduli built-in: `node:sqlite`, `node:crypto`, `node:http`, `node:tls`, `node:net`, `node:fs`, `node:path`.

Lo stesso progetto originale (Next.js + Prisma + Turso, 22 509 LOC, 43 dipendenze) gira su Vercel serverless perché ogni route è una funzione isolata con DB esterno. **Il rigenerato NON può girare su Vercel serverless**: è un server HTTP long-running con DB SQLite locale e filesystem persistente. Le due architetture sono incompatibili.

Per deployarlo serve una piattaforma che supporti:
- Processi Node long-running (non serverless)
- Filesystem persistente (per il DB SQLite)
- Porta TCP esposta

## Requisiti

- Node.js ≥ 22.5.0 (per `node:sqlite`; raccomandato 22 LTS o 24)
- Filesystem persistente (volume, disco, o directory locale)
- Porta TCP esposta (default 3000)

## Avvio rapido (locale, in 3 comandi)

```bash
cp .env.example .env
# Edita .env: imposta NEXT_PUBLIC_SITE_URL e (se vuoi OTP via email) SMTP_*
node crm.js
```

Poi apri `http://localhost:3000` e segui il setup (POST /api/auth/register con masterEmail, password, fingerprintSeed).

## Deploy — 4 opzioni

Vedi i file `deploy/` per ciascuna piattaforma:

| Piattaforma | Costoindicativo | File | Quando usarla |
|---|---|---|---|
| Railway | free tier poi $5/mese | `deploy/railway.sh` | setup più rapido, git-push deploy |
| Render | free tier con limiti | `deploy/render.sh` | simile a Railway, più opzioni disk |
| Fly.io | free tier + pay-as-you-go | `deploy/fly.sh` | più vicino a un VPS ma gestito |
| VPS (DigitalOcean/Hetzner/...) | $5-10/mese | `deploy/vps-systemd.sh` | pieno controllo, DB su disco |

Per il deploy su **Vercel** (utenti che vogliono rimanere su Vercel): non puoi deployare questo file. Vedi `VERCEL-ADAPTER.md` per la strategia di adattamento (sostituire `node:sqlite` con Turso/Neon + splittare le route in handlers Next.js — è essenzialmente ricostruire l'originale, controproducente).

## Variabili ambiente critiche

| Var | Obbligatoria? | Note |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | **SÌ** per QR operatori | URL pubblico del deployment; l'URL QR punta a `${NEXT_PUBLIC_SITE_URL}/operator/:token` |
| `DATABASE_URL` | No (default `file:crm.sqlite`) | Usa `file:/percorso/crm.sqlite` per mount persistent |
| `PORT` | No (default 3000) | La piattaforma la imposta automaticamente |
| `NODE_ENV` | Consigliata `production` | Abilita `Secure` flag sui cookie sessione |
| `SMTP_*` | Solo per OTP via email | Senza, l'OTP è loggato a stderr con `CSI_TEST_SEED=1` |
| `CSI_BACKUP_KEY` | Solo per backup cifrato | 32 byte hex (64 char); genera con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

## Primo setup (una tantum, post-deploy)

Dopo il primo avvio, chiama una sola volta:

```bash
curl -X POST https://<tuo-dominio>/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"masterEmail":"admin@tuodominio.it","password":"<password-sicura-di-12+char>","fingerprintSeed":"<frase-segreta-per-fingerprint-macchina>"}'
```

Response attesa: `{"ok":true,"setupComplete":true,"adminOperatorCode":"ADMIN-001"}`.

Poi importa il catalogo servizi:

```bash
# Richiede prima il login 3FA via /api/auth/send-otp-email + /api/auth/verify-otp
curl -X POST https://<tuo-dominio>/api/admin/import-services \
  -H "X-Master-Token: <token-da-verify-otp>" \
  -H "Content-Type: application/json" -d '{}'
```

Response attesa: `{"ok":true,"macroAreas":9,"services":44}`.

## Verifica post-deploy

```bash
curl https://<tuo-dominio>/api/health
# atteso: {"ok":true,...,"setupComplete":true,...}

curl https://<tuo-dominio>/api/macro-areas
# atteso: 9 macroaree

curl https://<tuo-dominio>/api/services
# atteso: 44 servizi
```

## Backup

```bash
curl -X POST https://<tuo-dominio>/api/backup \
  -H "X-Master-Token: <token>"
# Scrive un backup AES-256-GCM cifrato in ogni directory di CSI_BACKUP_DIRS
```

## Cleanup dati di test (se hai eseguito il seed in produzione per errore)

```bash
curl -X DELETE https://<tuo-dominio>/api/admin/test-data \
  -H "X-Master-Token: <token>"
# Elimina SOLO i record con is_test=1, preserva il resto
```

## Sicurezza — checklist post-deploy

- [ ] `NODE_ENV=production` (abilita cookie `Secure`)
- [ ] `NEXT_PUBLIC_SITE_URL` punta a HTTPS (i cookie `Secure` richiedono HTTPS)
- [ ] SMTP password è una Gmail App Password (16 char), NON la password Gmail
- [ ] `CSI_BACKUP_KEY` è un valore casuale di 32 byte hex (NON riutilizzato)
- [ ] `CSI_TEST_SEED=0` in produzione (mai 1)
- [ ] Il volume `/data` è montato su storage persistent (non ephemeral)
- [ ] HTTPS terminato dal reverse proxy (Caddy, nginx, o dalla piattaforma)
- [ ] Firewall: solo 80/443 esposti; la porta del container 3000 solo interna

## Logs

Il server logga a stdout:
- `C.S.I. Front Office (rigenerato) in ascolto su http://localhost:PORT`
- `Primo accesso: POST /api/auth/register ...` (solo se setup non completo)

Log di sistema (azioni master, login, errori) scritti nella tabella `log_entry` del DB, leggibili con:
```bash
curl "https://<tuo-dominio>/api/logs?limit=100" -H "X-Master-Token: <token>"
```
