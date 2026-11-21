#!/usr/bin/env bash
# =============================================================================
#  C.S.I. Front Office — Deploy su VPS (systemd + nginx reverse proxy)
#  Requisiti: VPS Linux con SSH, nginx, Node 22 installato.
#  Uso: ./deploy/vps-systemd.sh user@host
# =============================================================================
set -e

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "Uso: $0 user@host"
  echo "  Esempio: $0 root@159.203.0.1"
  echo ""
  echo "Prerequisiti sul VPS:"
  echo "  - Node.js 22+ (installa con: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -; sudo apt install -y nodejs)"
  echo "  - nginx (installa con: sudo apt install -y nginx)"
  echo "  - Un dominio con record A che punta al VPS"
  exit 1
fi

cd "$(dirname "$0")/.."
echo "=== Deploy C.S.I. Front Office su VPS ($TARGET) ==="
echo "  directory locale: $(pwd)"
echo ""

# 1. Sync del codice via rsync (esclude node_modules, DB, env, .git)
echo "=== 1. Rsync del codice ==="
rsync -avz --delete \
  --exclude node_modules --exclude '*.sqlite' --exclude '*.db' \
  --exclude .git --exclude .env --exclude .vercel \
  --exclude data --exclude /data \
  ./ "$TARGET:/opt/csi-crm/"

# 2. Setup su VPS: directory dati, env, systemd unit, nginx site
echo "=== 2. Setup servizio systemd + nginx ==="
ssh "$TARGET" 'bash -s' <<'REMOTE'
set -e
mkdir -p /opt/csi-crm/data/backups/primary
chown -R "$(whoami)":"$(whoami)" /opt/csi-crm

# .env minimale (DA EDITARE con valori reali)
if [ ! -f /opt/csi-crm/.env ]; then
cat > /opt/csi-crm/.env <<'ENV'
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
DATABASE_URL=file:/opt/csi-crm/data/crm.sqlite
NEXT_PUBLIC_SITE_URL=https://CRM.TUO-DOMINIO.IT
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=IL-TUO-ACCOUNT@gmail.com
SMTP_PASS=LA-TUA-APP-PASSWORD
CSI_BACKUP_DIRS=/opt/csi-crm/data/backups/primary
CSI_BACKUP_KEY=
ENV
  echo "  .env creato. EDITA /opt/csi-crm/.env con valori reali prima del primo avvio."
fi

# systemd unit
cat > /tmp/csi-crm.service <<'UNIT'
[Unit]
Description=C.S.I. Front Office — CRM Rigenerato
After=network.target

[Service]
Type=simple
User=%i
WorkingDirectory=/opt/csi-crm
EnvironmentFile=/opt/csi-crm/.env
ExecStart=/usr/bin/node /opt/csi-crm/crm.js
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

# Installa il service con l'utente corrente
USER=$(whoami)
sed -i "s/%i/$USER/" /tmp/csi-crm.service
sudo mv /tmp/csi-crm.service /etc/systemd/system/csi-crm.service
sudo systemctl daemon-reload
sudo systemctl enable csi-crm

echo "  systemd unit installato. Start: sudo systemctl start csi-crm"
REMOTE

# 3. Template nginx (l'utente lo adatta al proprio dominio)
echo "=== 3. Template nginx (da editare con il tuo dominio) ==="
cat <<'NGINX'
# Copia in /etc/nginx/sites-available/csi-crm e poi:
#   sudo ln -s /etc/nginx/sites-available/csi-crm /etc/nginx/sites-enabled/
#   sudo certbot --nginx -d crm.tuo-dominio.it
#   sudo nginx -t && sudo systemctl reload nginx

server {
    listen 80;
    server_name crm.tuo-dominio.it;

    # Reverse proxy al server Node (porta 3000)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # Per QR operatori: keep-alive sufficiente
        proxy_read_timeout 60s;
    }
}
NGINX
echo ""

echo "=== 4. Comandi di gestione (sul VPS) ==="
echo "  sudo systemctl start csi-crm         # avvia"
echo "  sudo systemctl status csi-crm        # stato"
echo "  sudo journalctl -u csi-crm -f        # log live"
echo "  sudo systemctl restart csi-crm       # restart dopo .env edit"
echo ""
echo "=== 5. Setup iniziale (POST deploy) ==="
echo "  Dopo l'avvio, dal tuo computer:"
echo "    curl -X POST https://crm.tuo-dominio.it/api/auth register \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"masterEmail\":\"admin@tuodominio.it\",\"password\":\"...\",\"fingerprintSeed\":\"...\"}'"
echo ""
echo "  Smoke test:"
echo "    node scripts/smoke-test.js https://crm.tuo-dominio.it"
