# CI/host validation: clean build + tests inside WSL2 Ubuntu (not native Windows).
param(
  [string]$Distro = $env:REMOTE_AGENTS_WSL_DISTRO
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EvidenceRoot = Join-Path $RepoRoot "evidence"
$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$EvidenceDir = Join-Path $EvidenceRoot "wsl-validation-$Stamp"
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$LogFile = Join-Path $EvidenceDir "wsl-run.log"

. (Join-Path $PSScriptRoot "wsl-common.ps1")

function Write-Evidence([string]$Message) {
  Add-Content -Path (Join-Path $EvidenceDir "status.txt") -Value $Message
  Write-Host $Message
}

Write-Evidence "platform=native-windows validation=wsl2-only node_min=22.13.0"

try {
  wsl --status *> $null
} catch {
  Write-Evidence "WSL_UNAVAILABLE: wsl command failed on this runner"
  exit 2
}

$preferred = @()
if ($Distro) { $preferred += $Distro }
$useDistro = Get-WslDistro -Preferred $preferred
if (-not $useDistro) {
  Write-Evidence "WSL_NO_DISTRO: no Linux distro registered; attempting Ubuntu install"
  wsl --install -d Ubuntu --no-launch 2>&1 | Tee-Object -FilePath $LogFile
  $useDistro = Get-WslDistro -Preferred @("Ubuntu")
  if (-not $useDistro) {
    Write-Evidence "WSL_UNAVAILABLE: Ubuntu not available after install attempt (reboot/admin may be required)"
    exit 2
  }
}

$wslRepo = Convert-ToWslPath -WinPath $RepoRoot -Distro $useDistro
if (-not $wslRepo) {
  Write-Evidence "WSL_UNAVAILABLE: wslpath failed for repo root under distro ${useDistro}"
  exit 2
}

Write-Evidence "wsl_distro=$useDistro wsl_repo=$wslRepo win_repo=$RepoRoot"
Set-WslForwardedEnv -Names @("SERVER_URL", "WORKER_TOKEN")

function Run-WslStep {
  param(
    [string]$Executable,
    [string[]]$Arguments
  )
  $output = & wsl -d $useDistro --cd $RepoRoot -e $Executable @Arguments 2>&1
  $output | Tee-Object -FilePath $LogFile -Append
  if ($LASTEXITCODE -ne 0) {
    Write-Evidence "WSL_VALIDATION_FAILED: ${Executable} exit=$LASTEXITCODE"
    exit 1
  }
}

Run-WslStep -Executable "bash" -Arguments @("scripts/wsl-clean-build.sh", $wslRepo)

Write-Evidence "WSL_VALIDATION_PASS evidence=$EvidenceDir"
Get-ChildItem $EvidenceDir | Out-File -FilePath (Join-Path $EvidenceDir "manifest.txt")
exit 0
