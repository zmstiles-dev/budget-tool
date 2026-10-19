param(
    [ValidateSet('mock', 'sync-with-existing-token', 'create-item', 'verify-mock-e2e', 'verify-synthetic-e2e', 'verify-sandbox-e2e')]
    [string]$Mode = 'mock',
    [switch]$ResetLocalDemo,
    [switch]$CheckLauncher,
    [switch]$Unattended
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$verify = 'D:\Documents\Codex\.assistant-storage\budget-tool-verification'
$deps = Join-Path $verify 'node_modules'
$emulatorCache = Join-Path $verify 'firebase-emulators'
if (-not (Test-Path -LiteralPath (Join-Path $deps 'firebase-tools\lib\bin\firebase.js'))) { throw "Firebase CLI is missing under the D: verification directory: $deps" }
if (-not (Test-Path -LiteralPath (Join-Path $deps 'firebase-admin'))) { throw "firebase-admin is missing under the D: verification directory: $deps" }
if (-not (Test-Path -LiteralPath $emulatorCache)) { throw "Firebase emulator cache is missing under the D: verification directory: $emulatorCache" }

$bundledNodeModules = 'C:\Users\Zach\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:NODE_PATH = "$deps;$bundledNodeModules"
$env:BUDGET_TOOL_LOCAL_DEPS = $deps
$env:BUDGET_TOOL_PLAYWRIGHT_BROWSERS_PATH = 'D:\Documents\Codex\.assistant-storage\playwright-browsers'
$env:FIREBASE_EMULATORS_PATH = $emulatorCache
$env:GCLOUD_PROJECT = 'demo-budget-tool'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8088'
$env:APPDATA = Join-Path $verify 'appdata'
$env:LOCALAPPDATA = Join-Path $verify 'localappdata'
$env:XDG_CONFIG_HOME = Join-Path $verify 'xdg-config'
$env:TEMP = Join-Path $verify 'temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP

foreach ($directory in @($env:APPDATA, $env:LOCALAPPDATA, $env:XDG_CONFIG_HOME, $env:TEMP, $emulatorCache)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

$node = (Get-Command node -ErrorAction Stop).Source
$launcher = Join-Path $repo 'local-demo-bridge-emulator-launcher.js'
$launcherArgs = @('--mode', $Mode)
if ($ResetLocalDemo) { $launcherArgs += '--reset-local-demo' }
if ($Unattended) { $launcherArgs += '--unattended' }
if ($CheckLauncher) {
    $env:BUDGET_TOOL_LAUNCHER_CHECK = '1'
    $env:BUDGET_TOOL_LAUNCHER_CAPTURE = Join-Path $verify 'local-demo-bridge-launcher-argv.json'
} else {
    Remove-Item Env:BUDGET_TOOL_LAUNCHER_CHECK -ErrorAction SilentlyContinue
    Remove-Item Env:BUDGET_TOOL_LAUNCHER_CAPTURE -ErrorAction SilentlyContinue
}
& $node $launcher @launcherArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
