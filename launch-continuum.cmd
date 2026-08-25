@echo off
rem CONTINUUM desktop launcher wrapper.
rem Works from any directory: resolves node regardless of the window's
rem inherited PATH (the npm shims and the nodejs MSI both need it), runs the
rem interactive menu from this checkout, and keeps the window open with the
rem error message if anything fails.
rem NOTE: the local variable is CONTINUUM_DIR, deliberately NOT
rem CONTINUUM_HOME — CONTINUUM treats the CONTINUUM_HOME env var as its
rem data/config-directory override (src/config/paths.ts), and setting it
rem here would point the credential backend at this install dir instead of
rem %USERPROFILE%\.continuum, making every stored credential invisible.
setlocal

set "CONTINUUM_DIR=C:\Users\Adminn\Developer\Ai-tools\CONTINUUM"

rem Windows Terminal sessions inherit the explorer PATH, which may not
rem include nodejs yet (e.g. freshly installed). Add it defensively.
set "PATH=C:\Program Files\nodejs;%PATH%"

cd /d "%CONTINUUM_DIR%"

rem Run the freshly built entry point of this checkout directly — no global
rem shim lookup, so the shortcut always uses this install.
node "%CONTINUUM_DIR%\dist\cli\bin.js"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :error
exit /b 0

:error
echo.
echo CONTINUUM exited with an error (code %EXIT_CODE%).
echo You can also run it from any PowerShell window with: continuum
echo.
pause
exit /b %EXIT_CODE%
