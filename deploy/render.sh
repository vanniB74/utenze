#!/usr/bin/env bash
# =============================================================================
#  C.S.I. Front Office — Deploy su Render
#  Requisiti: account Render, repo git pushato a GitHub.
#  Uso: ./deploy/render.sh
# =============================================================================
set -e

RENDER_BIN=$(command -v render 2>/dev/null || true)
echo "=== Deploy C.S.I. Front Office su Render ==="
echo ""
echo "  Render non ha CLI ufficiale per create-service. Usa il dashboard."
echo ""
echo "  Passi:"
echo "  1. Crea un Web Service su https://dashboard.render.com"
echo "  2. Connetti il repo Git che contiene crm-rigenerato/"
echo "  3. Configura:"
echo "     Runtime: Node"
echo "     Build Command:  (vuoto - nessuna dipendenza da installare)"
echo "     Start Command:  node crm.js"
echo "     Plan:           Starter (\$7/mese) — include disk persistent"
echo "  4. Aggiungi un Disk:"
echo "     Mount Path:     /data"
echo "     Size:           1 GB"
echo "  5. Variabili ambiente (Environment):"
echo "     NODE_ENV=production"
echo "     DATABASE_URL=file:/data/crm.sqlite"
echo "     NEXT_PUBLIC_SITE_URL=https://csi-crm-rigenerato.onrender.com  (dopo primo deploy)"
echo "     SMTP_HOST=smtp.gmail.com (opzionale)"
echo "     SMTP_USER=... (opzionale)"
echo "     SMTP_PASS=... (opzionale, Gmail App Password)"
echo ""
echo "  6. Create Web Service"
echo "  7. Dopo il deploy, imposta NEXT_PUBLIC_SITE_URL all'URL finale"
echo "  8. Smoke test: node scripts/smoke-test.js https://csi-crm-rigenerato.onrender.com"
echo ""
echo "Nota: il free tier di Render NON include disk persistent."
echo "      Usa il tier Starter (\$7/mese) per il DB SQLite persistente."
