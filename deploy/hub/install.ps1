# DS Flow one-time install on the HUB. Run ONCE in an Administrator PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# After this, Jake never deploys DS Flow by hand again. The scheduled task pulls,
# tests, deploys and rolls back on its own.
#
# Installs to C:\Flow (deliberately NOT inside OneDrive: OneDrive syncing fights git and
# live data files). OneDrive\FLOW only receives small status files so Claude can see HUB state.

param(
  [string]$Root    = "C:\Flow",
  [string]$Service = "DSFlow",
  [int]$Port       = 5680,
  [string]$Repo    = "https://github.com/Jacabew/Flow.git"
)

$ErrorActionPreference = "Stop"

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd not found. $hint" }
}
Need git  "Install Git for Windows."
Need node "Install Node.js 22 LTS or newer."
Need nssm "NSSM is already used for DSOS; make sure nssm.exe is on PATH."

$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node $nodeMajor found; DS Flow needs Node 22 or newer." }

$App = Join-Path $Root "app"
New-Item -ItemType Directory -Force -Path $Root, "$Root\data", "$Root\logs", "$Root\secrets", "$Root\deploy-state" | Out-Null

# --- GitHub access (read-only) --------------------------------------------------------
# The deploy task runs as SYSTEM, so it can't use Jake's personal git login.
# If the repo is private, paste a fine-grained GitHub token with read-only "Contents"
# access to Jacabew/Flow. Press Enter to skip if the repo is public.
$token = Read-Host "GitHub read-only token for Jacabew/Flow (Enter to skip if repo is public)"
if (-not (Test-Path $App)) {
  if ($token) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
    git -c "http.extraHeader=Authorization: Basic $b64" clone $Repo $App
    git -C $App config http.extraHeader "Authorization: Basic $b64"
  } else {
    git clone $Repo $App
  }
}
git config --system --add safe.directory ($App -replace '\\','/')

# --- Secrets (stay on this machine only) -----------------------------------------------
$keyFile = Join-Path $Root "secrets\api-key.txt"
if (-not (Test-Path $keyFile)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  Set-Content -Path $keyFile -Value ([Convert]::ToBase64String($bytes))
}
$apiKey = (Get-Content $keyFile -Raw).Trim()

$topic = Read-Host "Phone alerts: ntfy topic name (Enter to skip; any long private word works)"
if ($topic) { Set-Content -Path (Join-Path $Root "secrets\ntfy-topic.txt") -Value $topic }

# --- Windows service via NSSM ------------------------------------------------------------
$nodeExe = (Get-Command node).Source
if (-not (Get-Service $Service -ErrorAction SilentlyContinue)) {
  nssm install $Service $nodeExe "$App\src\server.js"
}
nssm set $Service AppDirectory $App
$envs = "FLOW_DATA_DIR=$Root\data", "FLOW_PORT=$Port", "FLOW_API_KEY=$apiKey"
if ($topic) { $envs += "FLOW_ALERT_NTFY_TOPIC=$topic" }
nssm set $Service AppEnvironmentExtra @envs
nssm set $Service AppStdout "$Root\logs\service.log"
nssm set $Service AppStderr "$Root\logs\service.log"
nssm set $Service AppRotateFiles 1
nssm set $Service AppRotateBytes 5000000
nssm set $Service Start SERVICE_AUTO_START
nssm restart $Service

# --- Auto-deploy every 5 minutes ---------------------------------------------------------
$statusDir = "$env:USERPROFILE\OneDrive\FLOW\status"
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$App\deploy\hub\flow-deploy.ps1`" -StatusDir `"$statusDir`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "DSFlow-Deploy" -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

Start-Sleep -Seconds 5
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$Port/health"
  Write-Host "DS Flow is running. Version $($h.version), $($h.flows) flow(s)." -ForegroundColor Green
} catch {
  Write-Host "Service installed but health check failed. See $Root\logs\service.log" -ForegroundColor Yellow
}
Write-Host "Auto-deploy task 'DSFlow-Deploy' runs every 5 minutes. You're done."
