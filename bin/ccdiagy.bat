@echo off
:: WARNING: Launches Claude Code with --dangerously-skip-permissions, which
:: disables ALL safety confirmations. Use only in trusted environments.
setlocal
node "%~dp0..\index.js" --dangerously-skip-permissions %*
exit /b %ERRORLEVEL%
