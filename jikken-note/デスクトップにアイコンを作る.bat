@echo off
cd /d "%~dp0"
echo デスクトップに「実験ノート印刷」のアイコンを作ります。
echo.
echo   1 : 自分のPCだけで使う（ふつうはこちら）
echo   2 : 他のPCからも開けるようにする（共有モード）
echo.
set MODE=1
set /p MODE=番号を入力して Enter を押してください [1]: 
set "TARGET=起動.bat"
if "%MODE%"=="2" set "TARGET=起動（共有）.bat"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d '実験ノート印刷.lnk')); $s.TargetPath='%~dp0%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0static\icon.ico,0'; $s.Description='実験ノート印刷ツール'; $s.Save()"
echo.
if errorlevel 1 (
  echo アイコンを作れませんでした。
) else (
  echo デスクトップに「実験ノート印刷」のアイコンを作りました。
  echo 次からはそのアイコンをダブルクリックすると起動します。
  echo ※このフォルダの場所を移動したときは、もう一度この bat を実行してください。
)
echo.
pause
