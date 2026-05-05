@echo off
setlocal
node "%~dp0..\index.js" %*
exit /b %ERRORLEVEL%
