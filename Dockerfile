# =============================================================================
#  C.S.I. Front Office — Dockerfile
#  Image minimale Node 22 su Alpine, single-file Node server.
#  Build:   docker build -t csi-crm-rigenerato .
#  Run:     docker run -p 3000:3000 -v csi-data:/data --env-file .env csi-crm-rigenerato
# =============================================================================

FROM node:22-alpine AS base

# Healthcheck: usa wget (in Alpine di default) per colpire /api/health
# Se il server non risponde per 30s, il container viene marcato unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/health || exit 1

WORKDIR /app

# Copia prima i file statici (config, scripts, package.json) — layer cached
COPY package.json ./
COPY crm.js ./
COPY config/ ./config/
COPY scripts/ ./scripts/

# Volume per il DB SQLite persistente (sovrascrive DATABASE_URL via env)
# In produzione: mappa un volume persistent o usa un disco esterno (Turso, ecc.)
VOLUME ["/data"]

# Variabili ambiente di default (sovrascrivibili con --env o -e)
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL=file:/data/crm.sqlite \
    HOST=0.0.0.0

# Esponi la porta
EXPOSE 3000

# Comando di avvio (nessuna dipendenza da installare: solo moduli built-in)
CMD ["node", "crm.js"]
