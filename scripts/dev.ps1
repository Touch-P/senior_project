# Start the Smart Cart server for local development.
# Usage (from repo root):  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host 'Created .env from .env.example - change ADMIN_PASSWORD and SESSION_SECRET.' -ForegroundColor Yellow
}
if (-not (Test-Path 'node_modules')) { npm install }
if (-not (Test-Path 'db\smartcart.db')) { npm run db:init; npm run db:seed }

npm run dev
