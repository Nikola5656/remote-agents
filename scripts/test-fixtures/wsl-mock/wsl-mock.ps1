# Mock of wsl.exe for scripts/test-wsl-helpers.ps1.
# Behaviour is driven only by RA_WSL_MOCK_* variables. The call log records
# argument vectors and whether forwarded variables are set, never their values.
#
#   RA_WSL_MOCK_LOG      append one JSON record per invocation to this file
#   RA_WSL_MOCK_DISTROS  comma list of registered distros (default Ubuntu-24.04),
#                        or "none"; docker-desktop is always listed first
#   RA_WSL_MOCK_NO_NODE  1 => `node --version` inside the distro exits 127

$argv = @($args)

function Write-CallLog {
  if (-not $env:RA_WSL_MOCK_LOG) { return }
  $record = [ordered]@{
    argv = $argv
    wslenv = [string]$env:WSLENV
    forwarded = [ordered]@{
      SERVER_URL = [bool]$env:SERVER_URL
      WORKER_TOKEN = [bool]$env:WORKER_TOKEN
    }
  }
  Add-Content -Path $env:RA_WSL_MOCK_LOG -Value ($record | ConvertTo-Json -Compress -Depth 4)
}

# Real `wsl -l -q` writes UTF-16LE; read as UTF-8 that yields a NUL after every character.
function Write-Utf16Line([string]$Text) {
  $chars = foreach ($c in $Text.ToCharArray()) { "$c`0" }
  [Console]::Out.Write(($chars -join "") + "`r`0`n`0")
}

function Convert-WindowsPath([string]$Path) {
  if ($Path -match '^([A-Za-z]):\\(.*)$') {
    return "/mnt/" + $Matches[1].ToLower() + "/" + ($Matches[2] -replace '\\', '/')
  }
  return $Path
}

Write-CallLog

switch ($argv[0]) {
  "--status" { exit 0 }
  "--install" { exit 0 }
  "-l" {
    Write-Utf16Line "docker-desktop"
    $distros = if ($env:RA_WSL_MOCK_DISTROS) { $env:RA_WSL_MOCK_DISTROS } else { "Ubuntu-24.04" }
    foreach ($d in ($distros -split "," | Where-Object { $_ -and $_ -ne "none" })) { Write-Utf16Line $d }
    exit 0
  }
  "-d" {
    $rest = @($argv | Select-Object -Skip 2)
    if ($rest.Count -ge 2 -and $rest[0] -eq "--cd") { $rest = @($rest | Select-Object -Skip 2) }
    if ($rest[0] -eq "-e") { $rest = @($rest | Select-Object -Skip 1) }
    if ($rest[0] -eq "wslpath") {
      Write-Output (Convert-WindowsPath $rest[$rest.Count - 1])
      exit 0
    }
    if ($rest[0] -eq "node" -and $rest[1] -eq "--version") {
      if ($env:RA_WSL_MOCK_NO_NODE -eq "1") { exit 127 }
      Write-Output "v22.13.1"
      exit 0
    }
    Write-Output ("mock-exec: " + ($rest -join " "))
    exit 0
  }
}
Write-Error "wsl mock: unsupported invocation: $($argv -join ' ')"
exit 64
