<#
.SYNOPSIS
  Allow phones on the same Wi-Fi to reach the Smart Cart server (inbound TCP 8443 and 8080, Private networks only).
  Must be run as Administrator — run it yourself:

    Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -File "<repo>\scripts\firewall.ps1"'

  -Remove  deletes the rules again.
  -SetPrivate  also switches the current Wi-Fi network to Private (the rules only apply to Private networks).
#>
param([switch]$Remove, [switch]$SetPrivate, [int[]]$Ports = @(8443, 8080))
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Error 'Run this script as Administrator (right-click PowerShell > Run as administrator).'; exit 1 }

$name = 'Smart Cart (LAN)'
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { Write-Host "Removed firewall rule '$name'."; exit 0 }

New-NetFirewallRule -DisplayName $name -Description 'Smart Cart senior project: HTTPS server for phones on the same Wi-Fi' `
  -Direction Inbound -Protocol TCP -LocalPort $Ports -Action Allow -Profile Private | Out-Null
Write-Host "Allowed inbound TCP $($Ports -join ', ') on Private networks."

$wifi = Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -match 'Wi-?Fi|Wireless|WLAN' } | Select-Object -First 1
if ($wifi -and $wifi.NetworkCategory -ne 'Private') {
  if ($SetPrivate) {
    Set-NetConnectionProfile -InterfaceIndex $wifi.InterfaceIndex -NetworkCategory Private
    Write-Host "Wi-Fi '$($wifi.Name)' is now a Private network."
  } else {
    Write-Warning "Wi-Fi '$($wifi.Name)' is $($wifi.NetworkCategory): the rule does not apply. Re-run with -SetPrivate, or change it in Settings."
  }
}
