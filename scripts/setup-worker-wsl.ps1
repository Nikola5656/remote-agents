# Install the remote-agents worker inside WSL2 Ubuntu (systemd user service).
# Native Windows is not a supported worker platform.
# Node.js >= 22.13 is an explicit prerequisite inside WSL (not bootstrapped here).
param(
  [switch]$SkipBuild,
  [switch]$SkipCi
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "wsl-common.ps1")

Write-Host "==> remote-agents worker (Windows via WSL2)"
Write-Host "Native Windows worker is NOT supported; installing Linux systemd user worker inside WSL."

try {
  wsl --status *> $null
} catch {
  Write-Error "WSL is not available on this host. Install WSL2 + Ubuntu, then re-run: powershell -File scripts/setup-worker-wsl.ps1"
}

$distro = Get-WslDistro
if (-not $distro) {
  Write-Host "No WSL distro found; attempting Ubuntu install (may require elevation/reboot)..."
  wsl --install -d Ubuntu --no-launch
  $distro = Get-WslDistro -Preferred @("Ubuntu")
  if (-not $distro) { $distro = "Ubuntu" }
}

$wslRepo = Convert-ToWslPath -WinPath $RepoRoot -Distro $distro
if (-not $wslRepo) {
  Write-Error "wslpath failed for repo root under distro ${distro}"
}

Write-Host "==> WSL distro: $distro"
Write-Host "==> repo (Windows): $RepoRoot"
Write-Host "==> repo (WSL): $wslRepo"

$null = & wsl -d $distro --cd $RepoRoot -e node --version 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Error "Node.js >= 22.13 is required inside WSL before setup. Install Node in ${distro}, then re-run this script."
}

Invoke-WslRepoCommand -Distro $distro -RepoRoot $RepoRoot -Executable "node" -Arguments @(
  "scripts/assert-node-version.mjs", "22.13.0", "worker"
)

if (-not $SkipCi) {
  Invoke-WslRepoCommand -Distro $distro -RepoRoot $RepoRoot -Executable "npm" -Arguments @(
    "ci", "--no-audit", "--no-fund"
  )
}
if (-not $SkipBuild) {
  Invoke-WslRepoCommand -Distro $distro -RepoRoot $RepoRoot -Executable "npm" -Arguments @("run", "build")
}

Invoke-WslRepoCommand -Distro $distro -RepoRoot $RepoRoot -Executable "bash" -Arguments @(
  "apps/worker/scripts/install-linux.sh"
)

Write-Host "==> WSL worker install complete (systemd user service inside $distro)"
