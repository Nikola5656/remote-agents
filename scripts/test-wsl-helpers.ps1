#Requires -Version 7.0
# Regression tests for the WSL worker helpers using a mocked `wsl` command.
# Runs on Windows PowerShell 7 or the official Linux PowerShell container.
# Exercises scripts/wsl-common.ps1, setup-worker-wsl.ps1 and run-wsl-validation.ps1
# against copies in a temp directory; the repository is never written to.
#
#   pwsh -NoProfile -File scripts/test-wsl-helpers.ps1
#
# Exit code 0 when every check passes, 1 otherwise. Real WSL is never invoked.

$ErrorActionPreference = "Continue"
Set-StrictMode -Version 2.0

$scriptsDir = $PSScriptRoot
$mockDir = Join-Path $scriptsDir "test-fixtures/wsl-mock"
$pwsh = (Get-Process -Id $PID).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ("ra-wsl-tests-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$repo = Join-Path $root "repo"
New-Item -ItemType Directory -Force -Path (Join-Path $repo "scripts") | Out-Null
foreach ($f in "wsl-common.ps1", "setup-worker-wsl.ps1", "run-wsl-validation.ps1") {
  Copy-Item (Join-Path $scriptsDir $f) (Join-Path $repo "scripts" $f)
}
if ($IsWindows) {
  # cmd.exe re-parses .cmd arguments and strips embedded quotes, so bare `wsl`
  # must resolve to a real executable for argv fidelity. Build the checked-in
  # launcher with the .NET Framework csc.exe that ships with Windows.
  $mockBin = Join-Path $root "mock-bin"
  New-Item -ItemType Directory -Force -Path $mockBin | Out-Null
  $csc = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $csc) { Write-Error "csc.exe not found; cannot build the wsl.exe mock launcher"; exit 1 }
  $mockExe = Join-Path $mockBin "wsl.exe"
  & $csc /nologo /optimize ("/out:" + $mockExe) (Join-Path $mockDir "wsl-launcher.cs")
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $mockExe)) { Write-Error "failed to compile the wsl.exe mock launcher"; exit 1 }
  $env:RA_WSL_MOCK_PWSH = $pwsh
  $env:RA_WSL_MOCK_PS1 = Join-Path $mockDir "wsl-mock.ps1"
  $env:PATH = $mockBin + [IO.Path]::PathSeparator + $env:PATH
} else {
  & chmod +x (Join-Path $mockDir "wsl") 2>$null
  $env:PATH = $mockDir + [IO.Path]::PathSeparator + $env:PATH
}
$env:WSLENV = ""
$env:SERVER_URL = "https://example.test"
$env:WORKER_TOKEN = "dummy-token-not-real"
$env:RA_WSL_MOCK_DISTROS = $null
$env:RA_WSL_MOCK_NO_NODE = $null

$script:passed = 0
$script:failed = 0

function Check([string]$Name, [scriptblock]$Body) {
  try {
    $r = & $Body
    $ok = [bool]$r['ok']
    $detail = [string]$r['detail']
  } catch {
    $ok = $false
    $detail = "exception: " + $_.Exception.Message
  }
  if ($ok) { $script:passed++ } else { $script:failed++ }
  Write-Host ("[" + $(if ($ok) { "PASS" } else { "FAIL" }) + "] " + $Name + $(if ($detail) { " :: " + $detail } else { "" }))
}

function Read-CallLog([string]$Path) {
  if (-not (Test-Path $Path)) { return @() }
  return @(Get-Content $Path | ForEach-Object { $_ | ConvertFrom-Json })
}

# One label per wsl invocation: the subcommand, or the executable after -e.
function Get-CallLabels($Records) {
  foreach ($r in $Records) {
    $argv = @($r.argv)
    if ($argv[0] -in "--status", "-l", "--install") { $argv[0]; continue }
    if ($argv -contains "wslpath") { "wslpath"; continue }
    $i = [array]::IndexOf($argv, "-e")
    if ($i -ge 0 -and $i + 1 -lt $argv.Count) { $argv[$i + 1] } else { "?" }
  }
}

function Get-ExecArgs($Records, [string]$Executable) {
  foreach ($r in $Records) {
    $argv = @($r.argv)
    $i = [array]::IndexOf($argv, "-e")
    if ($i -ge 0 -and $argv[$i + 1] -eq $Executable) { , @($argv | Select-Object -Skip ($i + 2)) }
  }
}

function Invoke-Child([string]$Script, [string[]]$ScriptArgs, [string]$Tag) {
  $log = Join-Path $root ($Tag + ".calls.jsonl")
  $out = Join-Path $root ($Tag + ".out.log")
  Remove-Item $log, $out -ErrorAction SilentlyContinue
  $env:RA_WSL_MOCK_LOG = $log
  & $pwsh -NoProfile -NonInteractive -File (Join-Path $repo "scripts" $Script) @ScriptArgs *> $out
  $code = $LASTEXITCODE
  $env:RA_WSL_MOCK_LOG = $null
  return [pscustomobject]@{
    ExitCode = $code
    Output = [string](Get-Content $out -Raw -ErrorAction SilentlyContinue)
    Calls = Read-CallLog $log
    LogPath = $log
  }
}

Write-Host ("test-wsl-helpers: pwsh " + $PSVersionTable.PSVersion + " on " + [System.Runtime.InteropServices.RuntimeInformation]::OSDescription)

# --- syntax -----------------------------------------------------------------
foreach ($f in "wsl-common.ps1", "setup-worker-wsl.ps1", "run-wsl-validation.ps1") {
  Check "syntax: $f parses" {
    $null = [scriptblock]::Create((Get-Content (Join-Path $repo "scripts" $f) -Raw))
    @{ ok = $true }
  }
}

. (Join-Path $repo "scripts/wsl-common.ps1")

# --- Get-WslDistro ----------------------------------------------------------
Check "Get-WslDistro strips UTF-16 NULs and never selects docker-desktop" {
  $d = Get-WslDistro
  @{ ok = ($d -eq "Ubuntu-24.04"); detail = "returned=[$d]" }
}
Check "Get-WslDistro returns null when only docker-desktop is registered" {
  $env:RA_WSL_MOCK_DISTROS = "none"
  try { $d = Get-WslDistro } finally { $env:RA_WSL_MOCK_DISTROS = $null }
  @{ ok = ($null -eq $d); detail = "returned=[$d]" }
}
Check "Get-WslDistro falls back to Ubuntu names when the preferred distro is absent" {
  $d = Get-WslDistro -Preferred @("Debian")
  @{ ok = ($d -eq "Ubuntu-24.04"); detail = "returned=[$d]" }
}

# --- Convert-ToWslPath ------------------------------------------------------
Check "Convert-ToWslPath keeps spaces, dollar and percent in the path" {
  $log = Join-Path $root "wslpath.calls.jsonl"
  $env:RA_WSL_MOCK_LOG = $log
  try { $p = Convert-ToWslPath -WinPath 'C:\ra\odd path $x%y' -Distro "Ubuntu-24.04" }
  finally { $env:RA_WSL_MOCK_LOG = $null }
  $actual = @((Read-CallLog $log)[0].argv)
  $expected = @("-d", "Ubuntu-24.04", "-e", "wslpath", "-a", 'C:\ra\odd path $x%y')
  $sep = [char]1
  @{ ok = ($p -eq '/mnt/c/ra/odd path $x%y' -and ($actual -join $sep) -eq ($expected -join $sep)); detail = "returned=[$p] argv=" + ($actual -join " | ") }
}

# --- Set-WslForwardedEnv ----------------------------------------------------
Check "Set-WslForwardedEnv merges existing WSLENV, dedupes, and skips unset names" {
  $env:WSLENV = "FOO/u:SERVER_URL/u"
  $saved = $env:WORKER_TOKEN
  $env:WORKER_TOKEN = $null
  try { Set-WslForwardedEnv -Names @("SERVER_URL", "WORKER_TOKEN"); $v = $env:WSLENV }
  finally { $env:WORKER_TOKEN = $saved }
  @{ ok = ($v -eq "FOO/u:SERVER_URL/u"); detail = "WSLENV=[$v]" }
}
Check "Set-WslForwardedEnv appends NAME/u for a set variable" {
  $env:WSLENV = "FOO/u:SERVER_URL/u"
  Set-WslForwardedEnv -Names @("SERVER_URL", "WORKER_TOKEN")
  $v = $env:WSLENV
  $env:WSLENV = ""
  @{ ok = ($v -eq "FOO/u:SERVER_URL/u:WORKER_TOKEN/u"); detail = "WSLENV=[$v]" }
}

# --- Invoke-WslRepoCommand --------------------------------------------------
Check "Invoke-WslRepoCommand passes every argument verbatim without a shell" {
  $log = Join-Path $root "invoke.calls.jsonl"
  Remove-Item $log -ErrorAction SilentlyContinue
  $env:RA_WSL_MOCK_LOG = $log
  try {
    Invoke-WslRepoCommand -Distro "Ubuntu-24.04" -RepoRoot 'C:\ra\odd path $x%y' -Executable "printf" -Arguments @('%s\n', 'a b', '$HOME', '"q"', "it's") | Out-Null
  } finally { $env:RA_WSL_MOCK_LOG = $null }
  $expected = @("-d", "Ubuntu-24.04", "--cd", 'C:\ra\odd path $x%y', "-e", "printf", '%s\n', "a b", '$HOME', '"q"', "it's")
  $actual = @((Read-CallLog $log)[0].argv)
  $sep = [char]1
  @{ ok = (($actual -join $sep) -eq ($expected -join $sep)); detail = "argv=" + ($actual -join " | ") }
}

# --- setup-worker-wsl.ps1 ---------------------------------------------------
$setupSkip = Invoke-Child "setup-worker-wsl.ps1" @("-SkipCi", "-SkipBuild") "setup-skip"
Check "setup-worker-wsl.ps1 -SkipCi -SkipBuild exits 0" {
  @{ ok = ($setupSkip.ExitCode -eq 0); detail = "exit=" + $setupSkip.ExitCode }
}
Check "setup-worker-wsl.ps1 call order: status, list, wslpath, node --version, assert-node-version, install-linux" {
  $labels = @(Get-CallLabels $setupSkip.Calls)
  $expected = @("--status", "-l", "wslpath", "node", "node", "bash")
  $nodeArgs = @(Get-ExecArgs $setupSkip.Calls "node")
  $bashArgs = @(Get-ExecArgs $setupSkip.Calls "bash")
  $ok = (($labels -join ",") -eq ($expected -join ",")) -and
        ($nodeArgs[0][0] -eq "--version") -and
        ($nodeArgs[1] -join " ") -eq "scripts/assert-node-version.mjs 22.13.0 worker" -and
        ($bashArgs[0][0] -eq "apps/worker/scripts/install-linux.sh")
  @{ ok = $ok; detail = "calls=" + ($labels -join ",") }
}
Check "setup-worker-wsl.ps1 does not call npm when both skips are given" {
  @{ ok = (-not ((Get-CallLabels $setupSkip.Calls) -contains "npm")) }
}

$setupFull = Invoke-Child "setup-worker-wsl.ps1" @() "setup-full"
Check "setup-worker-wsl.ps1 default runs npm ci before npm run build, then the installer" {
  $npm = @(Get-ExecArgs $setupFull.Calls "npm" | ForEach-Object { $_ -join " " })
  $labels = @(Get-CallLabels $setupFull.Calls)
  $ok = ($setupFull.ExitCode -eq 0) -and ($npm.Count -eq 2) -and
        ($npm[0] -eq "ci --no-audit --no-fund") -and ($npm[1] -eq "run build") -and
        ($labels[-1] -eq "bash")
  @{ ok = $ok; detail = "exit=" + $setupFull.ExitCode + " npm=" + ($npm -join " ; ") }
}

$env:RA_WSL_MOCK_NO_NODE = "1"
$setupNoNode = Invoke-Child "setup-worker-wsl.ps1" @("-SkipCi", "-SkipBuild") "setup-no-node"
$env:RA_WSL_MOCK_NO_NODE = $null
Check "setup-worker-wsl.ps1 fails before the installer when node --version fails inside WSL" {
  $labels = @(Get-CallLabels $setupNoNode.Calls)
  $ok = ($setupNoNode.ExitCode -ne 0) -and
        ($setupNoNode.Output -match "Node\.js >= 22\.13 is required inside WSL") -and
        (-not ($labels -contains "bash"))
  @{ ok = $ok; detail = "exit=" + $setupNoNode.ExitCode + " calls=" + ($labels -join ",") }
}

$env:RA_WSL_MOCK_DISTROS = "none"
$setupNoDistro = Invoke-Child "setup-worker-wsl.ps1" @("-SkipCi", "-SkipBuild") "setup-no-distro"
$env:RA_WSL_MOCK_DISTROS = $null
Check "setup-worker-wsl.ps1 attempts 'wsl --install -d Ubuntu --no-launch' when no distro is registered" {
  $install = @($setupNoDistro.Calls | Where-Object { $_.argv[0] -eq "--install" })
  $ok = ($install.Count -eq 1) -and ((@($install[0].argv) -join " ") -eq "--install -d Ubuntu --no-launch")
  @{ ok = $ok; detail = "installCalls=" + $install.Count }
}

# --- run-wsl-validation.ps1 -------------------------------------------------
$validation = Invoke-Child "run-wsl-validation.ps1" @() "validation"
$evidenceDir = Get-ChildItem (Join-Path $repo "evidence") -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
$status = if ($evidenceDir) { [string](Get-Content (Join-Path $evidenceDir.FullName "status.txt") -Raw) } else { "" }
Check "run-wsl-validation.ps1 exits 0 and records WSL_VALIDATION_PASS" {
  @{ ok = ($validation.ExitCode -eq 0 -and $status.Contains("WSL_VALIDATION_PASS")); detail = "exit=" + $validation.ExitCode }
}
Check "run-wsl-validation.ps1 forwards SERVER_URL and WORKER_TOKEN to build and test commands" {
  $execCalls = @($validation.Calls | Where-Object { @($_.argv) -contains "-e" -and @($_.argv) -notcontains "wslpath" })
  $bad = @($execCalls | Where-Object { $_.wslenv -ne "SERVER_URL/u:WORKER_TOKEN/u" -or -not $_.forwarded.SERVER_URL -or -not $_.forwarded.WORKER_TOKEN })
  @{ ok = ($execCalls.Count -gt 0 -and $bad.Count -eq 0); detail = "execCalls=" + $execCalls.Count + " nonForwarded=" + $bad.Count }
}
Check "run-wsl-validation.ps1 delegates the clean build to the Linux filesystem" {
  $labels = @(Get-CallLabels $validation.Calls)
  $bash = @(Get-ExecArgs $validation.Calls "bash")
  $ok = (($labels -join ",") -eq "--status,-l,wslpath,bash") -and
        ($bash[0][0] -eq "scripts/wsl-clean-build.sh") -and ($bash[0][1] -match "^/")
  @{ ok = $ok; detail = "calls=" + ($labels -join ",") }
}
Check "run-wsl-validation.ps1 writes a non-empty manifest.txt" {
  $mf = if ($evidenceDir) { Join-Path $evidenceDir.FullName "manifest.txt" } else { "" }
  $len = if ($mf -and (Test-Path $mf)) { (Get-Item $mf).Length } else { -1 }
  @{ ok = ($len -gt 0); detail = "bytes=$len" }
}

Remove-Item (Join-Path $repo "evidence") -Recurse -Force -ErrorAction SilentlyContinue
$env:RA_WSL_MOCK_DISTROS = "none"
$validationNoDistro = Invoke-Child "run-wsl-validation.ps1" @() "validation-no-distro"
$env:RA_WSL_MOCK_DISTROS = $null
Check "run-wsl-validation.ps1 exits 2 with WSL_UNAVAILABLE when no distro exists after install" {
  $dir = Get-ChildItem (Join-Path $repo "evidence") -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  $s = if ($dir) { [string](Get-Content (Join-Path $dir.FullName "status.txt") -Raw) } else { "" }
  @{ ok = ($validationNoDistro.ExitCode -eq 2 -and $s.Contains("WSL_UNAVAILABLE")); detail = "exit=" + $validationNoDistro.ExitCode }
}

# --- hygiene ----------------------------------------------------------------
Check "mock call logs never contain forwarded variable values" {
  $hits = @(Get-ChildItem $root -Filter "*.calls.jsonl" | Select-String -SimpleMatch "dummy-token-not-real", "example.test")
  @{ ok = ($hits.Count -eq 0); detail = "hits=" + $hits.Count }
}

Write-Host ("test-wsl-helpers: passed=" + $script:passed + " failed=" + $script:failed + " workdir=" + $root)
if ($script:failed -eq 0) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
exit $(if ($script:failed -eq 0) { 0 } else { 1 })
