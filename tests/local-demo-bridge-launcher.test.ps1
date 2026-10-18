$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$verify = 'D:\Documents\Codex\.assistant-storage\budget-tool-verification'
$capture = Join-Path $verify 'local-demo-bridge-launcher-argv.json'
$shells = @(
    'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
    'C:\Users\Zach\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe'
) | Where-Object { Test-Path -LiteralPath $_ }
if ($shells.Count -eq 0) { throw 'No supported PowerShell shell was found for launcher argument verification.' }
foreach ($shell in $shells) {
    Remove-Item -LiteralPath $capture -Force -ErrorAction SilentlyContinue
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'local-demo-bridge.ps1') -Mode create-item -Unattended -CheckLauncher
    if ($LASTEXITCODE -ne 0) { throw "Launcher shim failed under $shell (exit $LASTEXITCODE)." }
    if (-not (Test-Path -LiteralPath $capture)) { throw "Launcher shim did not write capture output under $shell." }
    $captured = Get-Content -LiteralPath $capture -Raw | ConvertFrom-Json
    if ($captured.mode -ne 'create-item') { throw "Launcher mode was not preserved under $shell." }
    if ($captured.runnerArgs -notcontains '--mode' -or $captured.runnerArgs -notcontains 'create-item' -or $captured.runnerArgs -notcontains '--unattended') { throw "Launcher mode flags were not preserved under $shell." }
    if ($captured.emulatorEnvKeys -contains 'PLAID_CLIENT_ID' -or $captured.emulatorEnvKeys -contains 'PLAID_SANDBOX_SECRET') { throw "Sandbox credentials reached emulator environment under $shell." }
    if ($captured.runnerEnvKeys -contains 'PLAID_CLIENT_ID' -or $captured.runnerEnvKeys -contains 'PLAID_SANDBOX_SECRET') { throw "Sandbox credentials were present in check-mode runner environment under $shell." }

    Remove-Item -LiteralPath $capture -Force -ErrorAction SilentlyContinue
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'local-demo-bridge.ps1') -Mode verify-sandbox-e2e -CheckLauncher
    if ($LASTEXITCODE -ne 0) { throw "Sandbox E2E launcher check failed under $shell (exit $LASTEXITCODE)." }
    $sandboxCaptured = Get-Content -LiteralPath $capture -Raw | ConvertFrom-Json
    if ($sandboxCaptured.runnerArgs -notcontains 'tests/approved-sandbox-e2e.cjs') { throw "Sandbox E2E harness was not selected under $shell." }
    if ($sandboxCaptured.emulatorEnvKeys -contains 'PLAID_CLIENT_ID' -or $sandboxCaptured.emulatorEnvKeys -contains 'PLAID_SANDBOX_SECRET') { throw "Sandbox credentials reached emulator environment under $shell." }
    if ($sandboxCaptured.runnerEnvKeys -contains 'PLAID_CLIENT_ID' -or $sandboxCaptured.runnerEnvKeys -contains 'PLAID_SANDBOX_SECRET') { throw "Sandbox credentials were present in check-mode E2E environment under $shell." }

    Remove-Item -LiteralPath $capture -Force -ErrorAction SilentlyContinue
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'local-demo-bridge.ps1') -Mode verify-synthetic-e2e -CheckLauncher
    if ($LASTEXITCODE -ne 0) { throw "Synthetic E2E launcher check failed under $shell (exit $LASTEXITCODE)." }
    $syntheticCaptured = Get-Content -LiteralPath $capture -Raw | ConvertFrom-Json
    if ($syntheticCaptured.runnerArgs -notcontains 'tests/approved-sandbox-synthetic-e2e.cjs') { throw "Synthetic E2E harness was not selected under $shell." }
    if ($syntheticCaptured.emulatorEnvKeys -contains 'PLAID_CLIENT_ID' -or $syntheticCaptured.emulatorEnvKeys -contains 'PLAID_SANDBOX_SECRET') { throw "Sandbox credentials reached synthetic emulator environment under $shell." }
    if ($syntheticCaptured.runnerEnvKeys -contains 'PLAID_CLIENT_ID' -or $syntheticCaptured.runnerEnvKeys -contains 'PLAID_SANDBOX_SECRET') { throw "Sandbox credentials were present in synthetic check-mode environment under $shell." }
}
Remove-Item -LiteralPath $capture -Force -ErrorAction SilentlyContinue
Write-Output "PASS: local bridge launcher preserves mode flags and excludes Sandbox credentials from emulator/check environments under $($shells.Count) PowerShell shell(s)."
