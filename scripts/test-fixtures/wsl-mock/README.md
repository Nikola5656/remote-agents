# WSL helper regression tests

`scripts/test-wsl-helpers.ps1` exercises the Windows-side helpers
(`wsl-common.ps1`, `setup-worker-wsl.ps1`, `run-wsl-validation.ps1`) against a
mocked `wsl` command. It checks UTF-16 distro listing, path conversion, `WSLENV`
forwarding, verbatim argument passing, the install call order, and the failure
paths for missing Node or missing distro. It does not touch a real WSL
installation and does not prove behaviour on a real Windows host.

## Run

Windows, PowerShell 7:

```powershell
pwsh -NoProfile -File scripts\test-wsl-helpers.ps1
```

Linux or macOS with the official PowerShell container (offline is fine):

```bash
docker run --rm --network none -v "$PWD:/repo:ro" mcr.microsoft.com/powershell:latest \
  pwsh -NoProfile -File /repo/scripts/test-wsl-helpers.ps1
```

On Apple Silicon the image only ships `linux/amd64` and `linux/arm/v7`. Use
`--platform linux/amd64` and pass `-e DOTNET_EnableWriteXorExecute=0
-e DOTNET_TieredCompilation=0`; without them the .NET JIT can fault under
Rosetta.

Exit code 0 means every check passed. Scripts are copied to a temp directory
before running, so the repository is never written to.

## Mock

`wsl-mock.ps1` holds the behaviour. On Linux/macOS the `wsl` sh shim launches
it in a child pwsh. On Windows the test suite compiles `wsl-launcher.cs` with
the OS-supplied .NET Framework `csc.exe` into a temp-dir `wsl.exe` that
forwards CRT-parsed argv to a child pwsh (`RA_WSL_MOCK_PWSH` /
`RA_WSL_MOCK_PS1` point at the interpreter and script). A `.cmd` shim is not
faithful: cmd.exe re-parses `%*` and strips embedded quotes; and the
implementation must not be named `wsl.ps1`, or PowerShell resolves bare `wsl`
to it in-process, where `[Console]::Out.Write` bypasses output capture. The
mock is configured only through `RA_WSL_MOCK_*` variables listed at the top of
`wsl-mock.ps1`. Its call log
stores argument vectors and whether `SERVER_URL` / `WORKER_TOKEN` are set,
never their values. The test suite uses dummy values only.
