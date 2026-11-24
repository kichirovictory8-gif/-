@echo off
cd /d "%~dp0"
title 実験ノート印刷ツール（共有モード）
where python >nul 2>nul
if %errorlevel%==0 (
  python app.py --share
  goto end
)
where py >nul 2>nul
if %errorlevel%==0 (
  py app.py --share
  goto end
)
echo Python が見つかりませんでした。
echo https://www.python.org/ から Python をインストールしてください。
echo インストール時に「Add python.exe to PATH」にチェックを入れてください。
:end
echo.
echo サーバが停止しました。何かキーを押すとこの画面を閉じます。
pause >nul
