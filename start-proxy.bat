@echo off
cd /d "%~dp0"
echo Starting codex-bridge proxy for DeepSeek...
echo Press Ctrl+C to stop.
node --env-file=.env proxy.mjs
pause
