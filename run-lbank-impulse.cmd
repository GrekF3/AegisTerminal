@echo off
setlocal
cd /d "%~dp0"
start "LBank Impulse Local" /b pythonw "%~dp0tools\lbank-impulse\lbank_impulse.py"
endlocal
