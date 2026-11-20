@echo off
chcp 65001 > nul
cd /d "%~dp0"
set "PY="
py -3 -c "import sys" > nul 2>&1
if not errorlevel 1 set "PY=py -3"
if not defined PY set "PY=python"
%PY% -m unittest discover -s tests -t . -v
echo.
pause
