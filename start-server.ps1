param(
  [int]$Port = 3000,
  [int]$IdleTimeoutMinutes = 30,
  [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 22.5 ou plus récent est requis. Installez Node.js puis relancez le serveur."
}

$nodeVersion = (& node --version).TrimStart("v")
$versionParts = $nodeVersion.Split(".")
$major = [int]$versionParts[0]
$minor = [int]$versionParts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
  throw "Node.js 22.5 ou plus récent est requis. Version détectée : $nodeVersion"
}

$env:QRAFT_PORT = "$Port"
$env:QRAFT_HOST = $HostAddress
$env:QRAFT_IDLE_TIMEOUT_MINUTES = "$IdleTimeoutMinutes"
if (-not $env:QRAFT_PUBLIC_ORIGIN) {
  $env:QRAFT_PUBLIC_ORIGIN = "http://localhost:$Port"
}

& $node.Source (Join-Path $PSScriptRoot "server.mjs")
exit $LASTEXITCODE
