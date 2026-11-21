#!/usr/bin/env bash
# =============================================================================
#  C.S.I. Front Office — Deploy su Railway
#  Requisiti: railway CLI installata (npm install -g @railway/cli) e loggata.
#  Uso: ./deploy/railway.sh
# =============================================================================
set -e

RAILWAY_BIN=$(command -v railway 2>/dev/null || true)
if [ -z "$RAILWAY_BIN" ]; then
  echo "✗ Railway CLI non installata."
  echo "  Installa con: npm install -g @railway/cli"
  echo "  Poi autentica: railway login"
  exit 1
fi

# Verifica login
if ! railway whoami >/dev/null 2>&1; then
  echo "✗ Non autenticato a Railway. Esegui 'railway login' prima."
  exit 1
fi

cd "$(dirname "$0")/.."
echo "=== Deploy C.S.I. Front Office su Railway ==="
echo "  directory: $(pwd)"
echo ""

# Crea o collega il progetto
railway link --yes || railway init --name csi-crm-rigenerato

# Volume persistent per il DB SQLite
railway volume add --mount-path /data --size 1GB

# Variabili ambiente minime (Railway le chiede interattivamente)
# Per configurarle non interattivamente, usa 'railway variables set KEY=VALUE'
echo "=== Variabili ambiente (imposta con 'railway variables set') ==="
echo "  NEXT_PUBLIC_SITE_URL  → dopo il deploy, l'URL pubblico sarà https://csi-crm-rigenerato.up.railway.app"
echo "  DATABASE_URL          → lascia default (file:/data/crm.sqlite, già gestito dal volume)"
echo "  NODE_ENV              → production"
echo "  PORT                  → Railway lo imposta automaticamente"
echo "  SMTP_*                → opzionali, per OTP via email"
echo "  CSI_BACKUP_KEY        → opzionale, 32 byte hex per backup cifrato"
echo ""
railway variables set NODE_ENV=production
railway variables set DATABASE_URL=file:/data/crm.sqlite

# Deploy
railway up --detach

# Mostra URL
echo ""
echo "=== Deploy avviato ==="
sleep 5
railway domain 2>&1 || true
echo ""
echo "Una volta online, configura:"
echo "  railway variables set NEXT_PUBLIC_SITE_URL=<url-assegnato>"
echo "  railway variables set SMTP_HOST=smtp.gmail.com"
echo "  railway variables set SMTP_USER=..."
echo "  railway variables set SMTP_PASS=..."
echo ""
echo "Smoke test (dopo 30s):"
echo "  node scripts/smoke-test.js https://<url-assegnato>"
