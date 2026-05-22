# codex-bridge — 卸载开机启动任务
# 以管理员身份运行: powershell -ExecutionPolicy Bypass -File .\unregister-startup.ps1

$TaskName = "codex-bridge"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[OK] Task '$TaskName' removed." -ForegroundColor Green
} else {
    Write-Host "[SKIP] Task '$TaskName' not found (already removed)." -ForegroundColor Yellow
}
