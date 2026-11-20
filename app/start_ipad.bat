@echo off
rem iPad など同じ Wi-Fi の機器からも使うモードで起動する（パスコード付き）
call "%~dp0start.bat" --lan %*
