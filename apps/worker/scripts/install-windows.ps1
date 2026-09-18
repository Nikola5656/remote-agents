# Remote Agents worker on Windows: WSL2 Ubuntu + Linux systemd user service only.
# Native Windows is NOT a supported production worker platform.

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "../../..")
$WslScript = Join-Path $Root "scripts/setup-worker-wsl.ps1"

Write-Host "==> remote-agents worker (Windows)"
Write-Host ""
Write-Host "Native Windows worker is NOT supported."
Write-Host "Windows is supported via WSL2 Ubuntu with the same Linux systemd user worker."
Write-Host ""
Write-Host "Delegating to: $WslScript"
Write-Host ""

& powershell -NoProfile -ExecutionPolicy Bypass -File $WslScript
exit $LASTEXITCODE
