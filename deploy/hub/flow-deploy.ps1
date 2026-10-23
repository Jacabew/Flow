# DS Flow auto-deploy for the HUB. Runs every 5 minutes via Task Scheduler (installed by install.ps1).
#
# What it does, with no human involved:
#   1. Fetch origin/main. If nothing new: health-check the service, restart it if it's down.
#   2. If there's a new commit: switch to it, run the test suite ON THE HUB.
#      Tests fail  -> switch back, mark that commit bad (never retried), alert.
#   3. Restart the service and health-check it.
#      Unhealthy   -> roll back to the last good commit, restart, mark commit bad, alert.
#   4. Write a short status file into OneDrive\FLOW\status so Claude can read HUB state remotely.
#
# Plain ASCII on purpose (Windows PowerShell 5.1 friendly).

param(
  [string]$Root      = "C:\Flow",
  [string]$Service   = "DSFlow",
  [int]$Port         = 5680,
  [string]$StatusDir = "$env:USERPROFILE\OneDrive\FLOW\status"
)

$ErrorActionPreference = "Stop"
$App      = Join-Path $Root "app"
$StateDir = Join-Path $Root "deploy-state"
$LogFile  = Join-Path $Root "logs\deploy.log"
$Lock     = Join-Path $StateDir "deploy.lock"
$GoodFile = Join-Path $StateDir "last-good.txt"
$BadFile  = Join-Path $StateDir "bad-commits.txt"
$NtfyFile = Join-Path $Root "secrets\ntfy-topic.txt"

New-Item -ItemType Directory -Force -Path $StateDir, (Split-Path $LogFile), $StatusDir | Out-Null

function Log([string]$msg) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $LogFile -Value $line
  try { Add-Content -Path (Join-Path $StatusDir "deploy-log.txt") -Value $line } catch {}
}

function Alert([string]$msg) {
  Log "ALERT: $msg"
  if (Test-Path $NtfyFile) {
    $topic = (Get-Content $NtfyFile -Raw).Trim()
    try { Invoke-RestMethod -Method Post -Uri "https://ntfy.sh/$topic" -Body $msg -Headers @{ Title = "DS Flow HUB"; Priority = "high" } | Out-Null } catch {}
  }
}

function Healthy {
  for ($i = 0; $i -lt 6; $i++) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
      if ($r.ok) { return $true }
    } catch {}
    Start-Sleep -Seconds 5
  }
  return $false
}

function Git {
  # git writes progress to stderr; don't let PowerShell treat that as an error.
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $out = & git -C $App @args 2>$null
  $code = $LASTEXITCODE; $ErrorActionPreference = $old
  if ($code -ne 0) { throw "git $($args -join ' ') failed (exit $code)" }
  return $out
}

function Status([string]$result, [string]$sha) {
  $obj = [ordered]@{ checkedAt = (Get-Date).ToString("s"); result = $result; commit = $sha; service = $Service; port = $Port }
  try { $obj | ConvertTo-Json | Set-Content -Path (Join-Path $StatusDir "deploy-status.json") } catch {}
}

# One run at a time. A lock older than 30 min is treated as stale.
if ((Test-Path $Lock) -and ((Get-Item $Lock).LastWriteTime -gt (Get-Date).AddMinutes(-30))) { exit 0 }
Set-Content -Path $Lock -Value $PID

try {
  Git fetch --quiet origin main | Out-Null
  $current = (Git rev-parse HEAD).Trim()
  $target  = (Git rev-parse origin/main).Trim()
  $bad     = if (Test-Path $BadFile) { Get-Content $BadFile } else { @() }

  if ($current -eq $target -or $bad -contains $target) {
    if (-not (Healthy)) {
      Alert "DS Flow was down. Restarting service."
      & nssm restart $Service | Out-Null
      if (Healthy) { Log "Service recovered after restart."; Status "recovered" $current }
      else { Alert "DS Flow still down after restart."; Status "down" $current }
    } else {
      Status "ok" $current
    }
    exit 0
  }

  Log "New commit $target (was $current). Testing."
  Git reset --hard $target | Out-Null

  Push-Location $App
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  & node --test "test/**/*.test.js" *> (Join-Path $Root "logs\last-test.log")
  $ErrorActionPreference = $old
  $testsPassed = ($LASTEXITCODE -eq 0)
  Pop-Location

  if (-not $testsPassed) {
    Git reset --hard $current | Out-Null
    Add-Content -Path $BadFile -Value $target
    Alert "Rejected $($target.Substring(0,7)): tests failed on the HUB. Still running $($current.Substring(0,7))."
    Status "rejected-tests" $current
    exit 0
  }

  & nssm restart $Service | Out-Null
  if (Healthy) {
    Set-Content -Path $GoodFile -Value $target
    Log "Deployed $($target.Substring(0,7)). Healthy."
    Status "deployed" $target
  } else {
    $good = if (Test-Path $GoodFile) { (Get-Content $GoodFile -Raw).Trim() } else { $current }
    Git reset --hard $good | Out-Null
    & nssm restart $Service | Out-Null
    Add-Content -Path $BadFile -Value $target
    $state = if (Healthy) { "rolled-back" } else { "rolled-back-but-down" }
    Alert "Commit $($target.Substring(0,7)) failed health check. Rolled back to $($good.Substring(0,7)) ($state)."
    Status $state $good
  }
}
catch {
  Alert "Deploy script error: $($_.Exception.Message)"
  Status "script-error" ""
}
finally {
  Remove-Item -Path $Lock -ErrorAction SilentlyContinue
}
