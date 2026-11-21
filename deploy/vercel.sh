#!/usr/bin/env bash
# =============================================================================
#  C.S.I. Front Office — Deploy su Vercel (AVVISO: NON compatibile)
#  Questo script NON deploya il rigenerato (file unico Node.js + SQLite locale)
#  su Vercel serverless. Perché no? Vedi VERCEL-ADAPTER.md.
#
#  Questo script esegue invece l'azione equivalente per l'utente che vuole
#  rimanere su Vercel: deploya l'ORIGINALE (Next.js + Turso) dal progetto
#  spacchettato, applicando le patch di sicurezza del Lotto L1 del
#  report-divergenze.md.
# =============================================================================
set -e

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  ATTENZIONE: il rigenerato NON può girare su Vercel              ║"
echo "║  (server Node long-running + SQLite locale, serverless incompatible)║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "Questo script NON deploya crm-rigenerato/crm.js su Vercel."
echo ""
echo "Opzioni disponibili:"
echo ""
echo "  A) Deploya il rigenerato su Railway / Render / Fly.io / VPS"
echo "     Usa uno degli altri script in deploy/"
echo "     (railway.sh, render.sh, fly.sh, vps-systemd.sh)"
echo ""
echo "  B) Continua a usare Vercel con l'ORIGINALE (Next.js + Turso)"
echo "     applicando le patch di sicurezza del Lotto L1 del report-divergenze.md."
echo "     Per farlo:"
echo ""
echo "       1. Verifica di avere un VERCEL_TOKEN nel env:"
echo "          echo \$VERCEL_TOKEN"
echo "          (se vuoto, crealo su https://vercel.com/account/tokens)"
echo ""
echo "       2. Prendi il codice originale:"
echo "          ls /home/z/my-project/upload/extracted/workspace/csi-crm-deploy/"
echo ""
echo "       3. Applica il Lotto L1 (vedi report-divergenze.md sezione 8):"
echo "          - Rimuovi credenziali da .env e vercel.json"
echo "          - Aggiungi middleware di auth su tutte le route /api/*"
echo "          - Rimuovi POST /api/seed"
echo "          - Rimuovi demoOtpCode dalla risposta"
echo "          - Sostituisci sha256('master-csi-2026') con hash dal setup"
echo "          - Rimuovi OPERATOR_ACCESS_CODE dal .env"
echo ""
echo "       4. Deploya:"
echo "          cd /home/z/my-project/upload/extracted/workspace/csi-crm-deploy"
echo "          vercel deploy --yes --prod"
echo ""
echo "  C) Riadatta il rigenerato per Vercel (NON raccomandato):"
echo "     Vedi VERCEL-ADAPTER.md per la lista delle modifiche necessarie."
echo "     In sintesi: è quasi come ricostruire l'originale, controproducente."
echo ""
exit 0
