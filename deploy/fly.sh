#!/usr/bin/env bash
# =============================================================================
#  C.S.I. Front Office — Deploy su Fly.io
#  Requisiti: flyctl CLI installata (curl -L https://fly.io/install.sh | sh)
#  Uso: ./deploy/fly.sh
# =============================================================================
set -e

FLY_BIN=$(command -v flyctl 2>/dev/null || command -v fly 2>/dev/null || true)
if [ -z "$FLY_BIN" ]; then
  echo "✗ flyctl non installata."
  echo "  curl -L https://fly.io/install.sh | sh"
  exit 1
fi
FLY=$FLY_BIN

if ! $FLY auth whoami >/dev/null 2>&1; then
  echo "✗ Non autenticato a Fly.io. Esegui '$FLY auth login' prima."
  exit 1
fi

cd "$(dirname "$0")/.."
APP_NAME="${FLY_APP_NAME:-csi-crm-rigenerato}"
echo "=== Deploy $APP_NAME su Fly.io ==="
echo "  directory: $(pwd)"
echo ""

# Launch (crea l'app se non esiste)
$FLY launch --app "$APP_NAME" --no-deploy --yes --dockerfile Dockerfile --region fra

# Volume persistent per il DB SQLite
$FLY volumes create csi_data --size 1 --app "$APP_NAME" --region fra --yes 2>/dev/null || true

# Crea fly.toml con mount del volume e configurazione HTTP
cat > fly.toml <<TOML
app = "$APP_NAME"
primary_region = "fra"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

[mounts]
  source = "csi_data"
  destination = "/data"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
TOML

echo "=== fly.toml scritto ==="
cat fly.toml
echo ""

# Variabili ambiente (le imposta come secret; le variabili non-secret via --env)
$FLY secrets set NODE_ENV=production DATABASE_URL="file:/data/crm.sqlite" --app "$APP_NAME"

# Deploy
$FLY deploy --yes --app "$APP_NAME"

# URL pubblico
echo ""
echo "=== Deploy completato ==="
$FLY apps show --app "$APP_NAME" 2>&1 | grep -E "Hostname|URL" || true
echo ""
echo "Una volta online, imposta:"
echo "  $FLY secrets set NEXT_PUBLIC_SITE_URL=https://$APP_NAME.fly.dev --app $APP_NAME"
echo "  $FLY secrets set SMTP_HOST=smtp.gmail.com --app $APP_NAME"
echo "  $FLY secrets set SMTP_USER=... --app $APP_NAME"
echo "  $FLY secrets set SMTP_PASS=... --app $APP_NAME"
echo ""
echo "Smoke test:"
echo "  node scripts/smoke-test.js https://$APP_NAME.fly.dev"
