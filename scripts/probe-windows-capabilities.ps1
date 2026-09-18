#Requires -Version 7.0
# Read-only Windows capability probe for the Windows/WSL acceptance gate.
# Reports hypervisor, virtualization firmware, optional-feature and WSL state
# without enabling, installing, or changing anything.
#
#   pwsh -NoProfile -File scripts/probe-windows-capabilities.ps1 [-OutFile <path>]
#
# Exit codes: 0 = probe completed (verdict may still be UNVERIFIED),
#             2 = probe could not gather basic facts or ran on non-Windows.
# A missing WSL is reported as UNVERIFIED, never as a pass: this probe on its
# own does not prove the full Windows/WSL provider workflow.

param([string]$OutFile = "")

$ErrorActionPreference = "Continue"
Set-StrictMode -Version 2.0

if (-not $IsWindows) {
  Write-Host "probe: this script reports Windows capabilities and must run on Windows."
  exit 2
}

$lines = [System.Collections.Generic.List[string]]::new()
function Emit([string]$Text) { $lines.Add($Text); Write-Host $Text }
function Section([string]$Title) { Emit ""; Emit "== $Title ==" }

function Probe([string]$Name, [scriptblock]$Body) {
  try {
    $value = & $Body
    if ($null -eq $value -or ($value -is [string] -and -not $value.Trim())) { $value = "(empty)" }
    foreach ($v in @($value)) { Emit ("{0}: {1}" -f $Name, $v) }
    return $value
  } catch {
    Emit ("{0}: probe-failed ({1})" -f $Name, $_.Exception.Message.Split("`n")[0])
    return $null
  }
}

Section "Host"
$os = Probe "os" { (Get-CimInstance Win32_OperatingSystem).Caption }
Probe "os-version" { [Environment]::OSVersion.Version.ToString() }
Probe "arch" { $env:PROCESSOR_ARCHITECTURE }
Probe "powershell" { $PSVersionTable.PSVersion.ToString() }
Probe "elevated" {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Section "Virtualization"
$hvPresent = Probe "hypervisor-present" { (Get-CimInstance Win32_ComputerSystem).HypervisorPresent }
$vfw = Probe "virtualization-firmware-enabled" {
  (Get-CimInstance Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled
}
Probe "slat" {
  (Get-CimInstance Win32_Processor | Select-Object -First 1).SecondLevelAddressTranslationExtensions
}

Section "Optional features (read-only query)"
$features = @{}
foreach ($name in "Microsoft-Windows-Subsystem-Linux", "VirtualMachinePlatform", "Microsoft-Hyper-V-All") {
  $features[$name] = Probe $name {
    (Get-WindowsOptionalFeature -Online -FeatureName $name -ErrorAction Stop).State
  }
}

Section "WSL"
$wslCmd = Get-Command wsl.exe -ErrorAction SilentlyContinue
Emit ("wsl.exe: {0}" -f ($(if ($wslCmd) { $wslCmd.Source } else { "not found" })))
$wslStatus = $null
if ($wslCmd) {
  # wsl.exe emits UTF-16; capture bytes and strip NULs so text survives redirection.
  $wslStatus = Probe "wsl-status" { ((& wsl.exe --status 2>&1) -join " ") -replace "`0", "" }
  Probe "wsl-distros" { ((& wsl.exe --list --verbose 2>&1) -join " ") -replace "`0", "" }
}

Section "Verdict"
# A version string or HypervisorPresent does not prove a WSL2 distribution boots.
Emit "verdict: UNVERIFIED — capability inventory only. No WSL2 workload was started or tested. NOT a pass of the Windows/WSL gate."
Emit "note: this probe is informational and read-only; only scripts/run-wsl-validation.ps1 on a real WSL2 host can pass the gate."

if ($OutFile) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) -ErrorAction SilentlyContinue | Out-Null
  Set-Content -Path $OutFile -Value ($lines -join [Environment]::NewLine) -Encoding utf8
}

if ($null -eq $os) { exit 2 }
exit 0
