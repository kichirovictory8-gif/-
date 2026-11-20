@echo off
chcp 65001 > nul
cd /d "%~dp0"
title 薬剤師国試 フラッシュカード

set "PY="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" > nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto run
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" > nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto run
goto nopython

:run
%PY% server.py %*
if errorlevel 1 (
  echo.
  echo 起動中にエラーが起きました。上のメッセージを確認してください。
  pause
)
exit /b

:nopython
echo.
echo ============================================================
echo  Python 3.9 以上が見つかりませんでした。
echo.
echo  1. https://www.python.org/downloads/ を開き、
echo     「Download Python 3.x.x」からインストーラーを入手する
echo  2. インストーラーの最初の画面で
echo     「Add python.exe to PATH」にチェックを入れて Install Now
echo  3. インストールが終わったら、この start.bat をもう一度ダブルクリック
echo.
echo  詳しくは app\README.md の「はじめての準備」を見てください。
echo ============================================================
echo.
pause
