@echo off
rem デスクトップにショートカット（国試フラッシュカード / 国試フラッシュカード（iPad））を作る
chcp 65001 > nul
cd /d "%~dp0"
set "PY="
py -3 -c "import sys" > nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto run
python -c "import sys" > nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto run
echo Python が見つかりませんでした。先に README の「はじめての準備」で Python をインストールしてください。
pause
exit /b 1
:run
%PY% server.py --create-shortcut
echo.
pause
