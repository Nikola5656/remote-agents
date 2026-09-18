# Remove optional Windows Scheduled Task if present (dev smoke only).
$ErrorActionPreference = "Stop"
$TaskName = "RemoteAgentsWorker"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task $TaskName"
} else {
  Write-Host "No scheduled task $TaskName found"
}
Write-Host "Worker data under %LOCALAPPDATA%\remote-agents-worker is preserved."
