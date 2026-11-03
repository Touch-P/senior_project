<#
.SYNOPSIS
  Create the HTTPS certificate so phones on the same Wi-Fi can open the camera page (brief section 9).

.DESCRIPTION
  Browsers allow the camera only on https:// (or localhost). This script:
    1. finds the IPv4 address of the Wi-Fi adapter (or use -Ip),
    2. creates certs/lan.pem + certs/lan-key.pem for that IP + localhost
       - with mkcert when it is installed (its local CA), otherwise
       - with the openssl that ships with Git for Windows (a local "Smart Cart LAN CA" in certs/ca/),
    3. copies the CA certificate to certs/smartcart-ca.crt - install it on the phone once
       (the server also offers it at http://<ip>:8080/smartcart-ca.crt),
    4. prints the URLs and a QR code.

  Does NOT need Administrator and does not change Windows. Trusting the CA on this PC is optional
  (see docs/phone-camera.md). Opening the firewall is a separate script: scripts/firewall.ps1 (Administrator).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\lan-https.ps1
  powershell -ExecutionPolicy Bypass -File scripts\lan-https.ps1 -Ip 192.168.1.20
#>
param(
  [string]$Ip,
  [string]$OutDir,
  [int]$Port = 8443,
  [int]$RedirectPort = 8080
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'certs' }
New-Item -ItemType Directory -Force $OutDir | Out-Null

# Windows PowerShell 5.1 turns anything a native tool writes to stderr into an error when
# $ErrorActionPreference is Stop (openssl prints progress dots there), so judge by the exit code instead.
function Invoke-Tool([string]$Exe, [string[]]$ToolArgs, [string]$What) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = & $Exe @ToolArgs 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  if ($code) {
    $out | ForEach-Object { Write-Host "  $_" }
    throw "$What failed (exit $code)"
  }
}

# 1. LAN address -------------------------------------------------------------
if (-not $Ip) {
  $candidates = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -in 'Dhcp', 'Manual' }
  $wifi = $candidates | Where-Object { $_.InterfaceAlias -match 'Wi-?Fi|Wireless|WLAN' } | Select-Object -First 1
  $pick = if ($wifi) { $wifi } else { $candidates | Select-Object -First 1 }
  if (-not $pick) { throw 'No LAN IPv4 address found. Connect to Wi-Fi or pass -Ip 192.168.x.x' }
  $Ip = $pick.IPAddress
  Write-Host "LAN address: $Ip ($($pick.InterfaceAlias))"
}
$netProfile = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
  Where-Object { $_.InterfaceAlias -match 'Wi-?Fi|Wireless|WLAN' } | Select-Object -First 1
if ($netProfile -and $netProfile.NetworkCategory -ne 'Private') {
  Write-Warning "Wi-Fi '$($netProfile.Name)' is a $($netProfile.NetworkCategory) network. Phones cannot connect until it is Private:"
  Write-Warning '  Settings > Network & internet > Wi-Fi > (this network) > Network profile type: Private'
  Write-Warning '  (or run scripts\firewall.ps1 -SetPrivate as Administrator)'
}

$cert = Join-Path $OutDir 'lan.pem'
$key = Join-Path $OutDir 'lan-key.pem'
$caOut = Join-Path $OutDir 'smartcart-ca.crt'

# 2. certificate --------------------------------------------------------------
$mkcert = Get-Command mkcert -ErrorAction SilentlyContinue
if ($mkcert) {
  Write-Host 'Using mkcert'
  Invoke-Tool 'mkcert' @('-cert-file', $cert, '-key-file', $key, $Ip, 'localhost', '127.0.0.1') 'mkcert'
  $caRoot = (& mkcert -CAROOT).Trim()
  Copy-Item (Join-Path $caRoot 'rootCA.pem') $caOut -Force
} else {
  $openssl = @(
    (Get-Command openssl -ErrorAction SilentlyContinue).Source,
    "$env:ProgramFiles\Git\usr\bin\openssl.exe",
    "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $openssl) {
    throw 'Neither mkcert nor openssl found. Install Git for Windows (has openssl) or mkcert (winget install FiloSottile.mkcert).'
  }
  Write-Host "Using openssl: $openssl"
  $caDir = Join-Path $OutDir 'ca'
  New-Item -ItemType Directory -Force $caDir | Out-Null
  $caKey = Join-Path $caDir 'ca-key.pem'
  $caCert = Join-Path $caDir 'ca.pem'
  if (-not (Test-Path $caCert)) {
    # one local CA per machine; its private key never leaves certs/ca/ (gitignored)
    Invoke-Tool $openssl @('req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', $caKey, '-out', $caCert,
      '-days', '3650', '-sha256', '-subj', "/CN=Smart Cart LAN CA ($env:COMPUTERNAME)/O=Smart Cart senior project",
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign') 'openssl: creating the CA'
  }
  $csr = Join-Path $caDir 'lan.csr'
  $ext = Join-Path $caDir 'lan.ext'
  @(
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    "subjectAltName=IP:$Ip,DNS:localhost,IP:127.0.0.1"
  ) | Set-Content -Encoding ascii $ext
  Invoke-Tool $openssl @('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', $key, '-out', $csr, '-subj', "/CN=$Ip") 'openssl: creating the key'
  # 825 days: the longest validity iOS accepts for server certificates
  Invoke-Tool $openssl @('x509', '-req', '-in', $csr, '-CA', $caCert, '-CAkey', $caKey, '-CAcreateserial', '-out', $cert,
    '-days', '825', '-sha256', '-extfile', $ext) 'openssl: signing the certificate'
  Remove-Item $csr, $ext -Force
  Copy-Item $caCert $caOut -Force
}

# 3. URLs + QR ----------------------------------------------------------------
$url = "https://${Ip}:$Port/"
$caUrl = "http://${Ip}:$RedirectPort/smartcart-ca.crt"
Write-Host ''
Write-Host "Certificate : $cert  (for $Ip, localhost)"
Write-Host "Phone CA    : $caOut  ->  $caUrl"
Write-Host "Server      : $url   (restart npm run dev so it picks up the certificate)"
Write-Host ''
Write-Host '1) On the phone, open this address and install the CA (once):'
& node (Join-Path $root 'scripts\qr.js') $caUrl
Write-Host '2) Then open the camera link for a cart:  npm run device-link -- A-07'
Write-Host '   (Firewall: run scripts\firewall.ps1 as Administrator once.)'
