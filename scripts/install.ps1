# Installs the Yoink helper and registers it with Chrome (Windows).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#        powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$HostName = 'com.yoink.helper'
# The unpacked (developer) copy: fixed by the "key" in extension\manifest.json.
$ExtensionId = 'dkeiibggiepjfgldgpjnlliajcpnbkma'
# The Chrome Web Store copy gets its own ID. Paste it here once the store shows it.
$StoreExtensionId = ''
# Earlier name of this helper, cleaned up on install.
$OldHostName = 'com.videodownloader.host'

$Root = Split-Path -Parent $PSScriptRoot
$SrcDir = Join-Path $Root 'host'
# The helper runs from its own folder, not from the project folder.
$HostDir = Join-Path $env:USERPROFILE '.yoink\helper'
$Log = Join-Path $env:USERPROFILE '.yoink\helper.log'
$Wrapper = Join-Path $HostDir 'run-helper.bat'
$ManifestPath = Join-Path $HostDir "$HostName.json"
$RegKeys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)

if ($Uninstall) {
  foreach ($key in $RegKeys) { Remove-Item -Path $key -ErrorAction SilentlyContinue }
  Remove-Item -Path $HostDir -Recurse -ErrorAction SilentlyContinue
  Write-Host 'Removed the Yoink helper. You can delete this folder now.'
  exit 0
}

# 1. Node 18+
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'Node.js is missing. Install Node 18 or newer from https://nodejs.org and run this again.'
}
$major = [int](& $node.Source -p 'process.versions.node.split(".")[0]')
if ($major -lt 18) { Write-Error "Node $major is too old. Install Node 18 or newer and run this again." }

# 2. Copy the helper to its own folder (and drop the old one, if any).
foreach ($key in $RegKeys) { Remove-Item -Path ($key -replace [regex]::Escape($HostName), $OldHostName) -ErrorAction SilentlyContinue }
Remove-Item -Path (Join-Path $env:USERPROFILE '.video-downloader\host') -Recurse -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $HostDir | Out-Null
Copy-Item (Join-Path $SrcDir '*') $HostDir -Recurse -Force -Exclude node_modules

# 3. ffmpeg: needed to merge high-resolution video and audio, and for mp3.
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host 'ffmpeg not found on PATH. Fetching a bundled copy...'
  try {
    Push-Location $HostDir
    npm install --omit=dev --no-audit --no-fund
  } catch {
    Write-Host 'Could not fetch ffmpeg. Basic downloads still work; install ffmpeg yourself for high resolutions and mp3.'
  } finally { Pop-Location }
}

# 4. Wrapper script. Chrome starts hosts with a bare PATH, so pin the full node path.
"@echo off`r`n`"$($node.Source)`" `"$(Join-Path $HostDir 'host.js')`" 2>>`"$Log`"`r`n" | Set-Content -Path $Wrapper -Encoding ASCII

# 5. Tell each browser about the helper.
$origins = @("chrome-extension://$ExtensionId/")
if ($StoreExtensionId) { $origins += "chrome-extension://$StoreExtensionId/" }
$manifest = [ordered]@{
  name = $HostName
  description = 'Yoink helper (runs yt-dlp)'
  path = $Wrapper
  type = 'stdio'
  allowed_origins = $origins
} | ConvertTo-Json
Set-Content -Path $ManifestPath -Value $manifest -Encoding ASCII

foreach ($key in $RegKeys) {
  # Always set up Chrome (the first entry); the others only if that browser is installed.
  $browserKey = Split-Path (Split-Path $key -Parent) -Parent
  if ($key -eq $RegKeys[0] -or (Test-Path $browserKey)) {
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $ManifestPath
    Write-Host "Registered for: $browserKey"
  }
}

Write-Host ''
Write-Host 'Done. Now open the Yoink popup and press "Check again".'
