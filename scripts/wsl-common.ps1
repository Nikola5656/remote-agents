# Shared helpers for WSL worker setup and validation scripts.

function Get-WslDistro {
  param([string[]]$Preferred = @("Ubuntu", "Ubuntu-24.04", "Ubuntu-22.04"))
  $raw = wsl -l -q 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  $installed = @($raw | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ })
  foreach ($name in @($Preferred + @("Ubuntu", "Ubuntu-24.04", "Ubuntu-22.04"))) {
    if ($installed -contains $name) { return $name }
  }
  return $null
}

function Convert-ToWslPath {
  param(
    [Parameter(Mandatory = $true)][string]$WinPath,
    [Parameter(Mandatory = $true)][string]$Distro
  )
  # Bypass the Linux shell so Windows backslashes and metacharacters stay literal.
  $out = wsl -d $Distro -e wslpath -a $WinPath 2>$null
  if ($LASTEXITCODE -eq 0 -and $out) { return $out.Trim() }
  return $null
}

function Set-WslForwardedEnv {
  param([string[]]$Names)
  $existing = @()
  if ($env:WSLENV) {
    $existing = @($env:WSLENV.Split(":") | Where-Object { $_ })
  }
  $forwarded = @()
  foreach ($name in $Names) {
    if ($null -ne (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue)) {
      $forwarded += "${name}/u"
    }
  }
  if ($forwarded.Count -eq 0) {
    return
  }
  $merged = @($existing + $forwarded) | Select-Object -Unique
  $env:WSLENV = ($merged -join ":")
}

function Invoke-WslRepoCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Distro,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  $allArgs = @("-d", $Distro, "--cd", $RepoRoot, "-e", $Executable) + $Arguments
  & wsl @allArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
