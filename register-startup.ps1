# codex-bridge — 注册为 Windows 开机启动任务
# 以管理员身份运行: powershell -ExecutionPolicy Bypass -File .\register-startup.ps1
#
# 注册后:
#   - 开机自动启动（无需登录）
#   - 崩溃后 1 分钟自动重启
#   - 可在"任务计划程序"中管理 (名称: codex-bridge)
#
# 卸载: powershell -ExecutionPolicy Bypass -File .\unregister-startup.ps1

$ErrorActionPreference = "Stop"

$TaskName = "codex-bridge"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodePath   = (Get-Command node).Source
$ScriptPath = Join-Path $ProjectDir "proxy.mjs"

if (-not (Test-Path $ScriptPath)) {
    Write-Error "proxy.mjs not found in $ProjectDir"
    exit 1
}

# 移除旧任务（如果存在）
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument "--env-file=`"$ProjectDir\.env`" `"$ScriptPath`"" `
    -WorkingDirectory $ProjectDir

$Trigger = New-ScheduledTaskTrigger -AtStartup

$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType S4U `
    -RunLevel Highest

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 3 `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "codex-bridge proxy (auto-start at boot)" `
    | Out-Null

Write-Host "[OK] Task '$TaskName' registered." -ForegroundColor Green
Write-Host ""
Write-Host "  Manage:"
Write-Host "    Start:     schtasks /Run /TN `"$TaskName`""
Write-Host "    Stop:      schtasks /End /TN `"$TaskName`""
Write-Host "    Status:    schtasks /Query /TN `"$TaskName`""
Write-Host "    Uninstall: powershell -File `"$ProjectDir\unregister-startup.ps1`""
Write-Host ""
Write-Host "  Logs: check console output or redirect in Task Scheduler actions"
