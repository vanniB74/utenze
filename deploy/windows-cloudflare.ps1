# =============================================================================
#  C.S.I. Front Office — Deploy Windows PowerShell (Cloudflare Tunnel)
#  Avvia il server Node locale + gestisce il tunnel Cloudflare.
#  Tunnel URL: https://transparency-scholarships-world-webpage.trycloudflare.com
# =============================================================================
#
#  PREREQUISITI (esegui una sola volta):
#  1. Node.js 22+ installato — verifica: node --version
#     Download: https://nodejs.org/dist/v22.20.0/node-v22.20.0-x64.msi
#  2. Clona il repo:
#       git clone -b csi-crm-rigenerato https://github.com/vanniB74/utenze.git csi-crm
#       cd csi-crm
#  3. (Opzionale) cloudflared per tunnel persistente (non trycloudflare):
#       winget install --id Cloudflare.cloudflared
#
#  USO:
#  - Avvio (tunnel trycloudflare temporaneo, URL fornito):
#      .\deploy\windows-cloudflare.ps1
#  - Avvio con tunnel persistente (richiede cloudflared configurato):
#      .\deploy\windows-cloudflare.ps1 -PersistentTunnel
#  - Stop: Ctrl+C in entrambe le finestre (server + tunnel)
#
#  NOTA SUL TUNNEL TRYCLOUDFLARE:
#  L'URL https://transparency-scholarships-world-webpage.trycloudflare.com è
#  TEMPORANEO. Scade quando cloudflared viene fermato. Per un URL stabile,
#  usa -PersistentTunnel (richiede login Cloudflare + named tunnel).
# =============================================================================

param(
    [switch]$PersistentTunnel = $false,
    [int]$Port = 3000,
    [string]$TunnelUrl = "https://transparency-scholarships-world-webpage.trycloudflare.com"
)

$ErrorActionPreference = "Stop"

# Verifica Node
try {
    $nodeVer = node --version
    Write-Host "  Node: $nodeVer" -ForegroundColor Green
    if ([version]$nodeVer.TrimStart('v') -lt [version]"22.5.0") {
        Write-Host "  ATTENZIONE: Node 22.5+ richiesto per node:sqlite." -ForegroundColor Red
        Write-Host "  Scarica: https://nodejs.org/dist/v22.20.0/node-v22.20.0-x64.msi" -ForegroundColor Yellow
        exit 1
    }
} catch {
    Write-Host "  Node non installato. Scarica da https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# Verifica cloudflared
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
    Write-Host "  cloudflared non trovato. Per tunnel persistente serve:" -ForegroundColor Red
    Write-Host "    winget install --id Cloudflare.cloudflared" -ForegroundColor Yellow
    if ($PersistentTunnel) { exit 1 }
    Write-Host "  Procedo con tunnel trycloudflare (URL temporaneo)." -ForegroundColor Yellow
}

# Crea directory dati se non esiste
$dataDir = Join-Path $PSScriptRoot "..\data"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Write-Host "  Creata directory dati: $dataDir" -ForegroundColor Green
}

# Crea .env se non esiste (dal template)
$envFile = Join-Path $PSScriptRoot "..\.env"
$envTemplate = Join-Path $PSScriptRoot "..\.env.example"
if (-not (Test-Path $envFile) -and (Test-Path $envTemplate)) {
    Copy-Item $envTemplate $envFile
    Write-Host "  Creato .env dal template. EDITA i valori reali (SMTP_*, CSI_BACKUP_KEY)." -ForegroundColor Yellow
}

# Genera CSI_BACKUP_KEY se mancante nel .env
$envContent = Get-Content $envFile -Raw
if ($envContent -match "CSI_BACKUP_KEY=\s*$") {
    $key = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    $envContent = $envContent -replace "CSI_BACKUP_KEY=\s*$", "CSI_BACKUP_KEY=$key"
    Set-Content $envFile $envContent
    Write-Host "  Generata CSI_BACKUP_KEY (32 byte hex AES-256-GCM)." -ForegroundColor Green
}

# Imposta NEXT_PUBLIC_SITE_URL al tunnel URL (sovrascrive .env)
$env:NEXT_PUBLIC_SITE_URL = $TunnelUrl
$env:PORT = $Port
$env:HOST = "0.0.0.0"
$env:NODE_ENV = "production"
$env:DATABASE_URL = "file:$(Join-Path $dataDir 'crm.sqlite')"

Write-Host ""
Write-Host "=== Avvio C.S.I. Front Office ===" -ForegroundColor Cyan
Write-Host "  Tunnel URL: $TunnelUrl" -ForegroundColor Green
Write-Host "  Port locale: $Port" -ForegroundColor Green
Write-Host "  DB: $env:DATABASE_URL" -ForegroundColor Green
Write-Host ""

# Avvia il server Node in background
$crmScript = Join-Path $PSScriptRoot "..\crm.js"
$nodeJob = Start-Process -FilePath "node" -ArgumentList $crmScript -PassThru -NoNewWindow
Write-Host "  Server Node avviato (PID $($nodeJob.Id))." -ForegroundColor Green

# Attendi che il server risponda
Write-Host "  Attesa server..." -NoNewline
$ready = $false
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 2
        if ($r.ok) { $ready = $true; break }
    } catch { Write-Host "." -NoNewline }
}
Write-Host ""
if ($ready) {
    Write-Host "  Server pronto su http://localhost:$Port" -ForegroundColor Green
} else {
    Write-Host "  Server non risponde entro 10s. Controlla log." -ForegroundColor Red
    Stop-Process -Id $nodeJob.Id -Force
    exit 1
}

# Avvia cloudflared tunnel
if ($PersistentTunnel -and $cloudflared) {
    Write-Host ""
    Write-Host "=== Avvio tunnel Cloudflare PERSISTENTE ===" -ForegroundColor Cyan
    Write-Host "  (richiede cloudflared tunnel login + named tunnel configurato)"
    & cloudflared tunnel run --url "http://localhost:$Port"
} else {
    Write-Host ""
    Write-Host "=== Avvio tunnel Cloudflare TRY (URL temporaneo) ===" -ForegroundColor Cyan
    Write-Host "  NOTA: l'URL trycloudflare cambia a ogni riavvio."
    Write-Host "  Per URL stabile, usa -PersistentTunnel (richiede setup)."
    & cloudflared tunnel --url "http://localhost:$Port"
}

# Quando cloudflared esce (Ctrl+C), ferma anche il server
Write-Host ""
Write-Host "  Tunnel chiuso. Sto fermando il server Node..." -ForegroundColor Yellow
if (-not $nodeJob.HasExited) { Stop-Process -Id $nodeJob.Id -Force }
Write-Host "  Fatto." -ForegroundColor Green
