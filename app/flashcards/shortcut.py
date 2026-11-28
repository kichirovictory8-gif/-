"""デスクトップにショートカット（.lnk）を作る（Windows のみ）。

Windows に標準で入っている PowerShell と WScript.Shell を使う。追加のインストールは不要。
日本語の名前・フォルダでも文字化けしないよう、パスは環境変数で渡し、スクリプトは
-EncodedCommand（UTF-16 の Base64）で渡す。
"""
from __future__ import annotations

import base64
import os
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]
ICON = APP_DIR / "static" / "icon.ico"

#: (ショートカット名, 起動するバッチ, 説明)
SHORTCUTS = (
    ("国試フラッシュカード", "start.bat", "薬剤師国試 フラッシュカードを起動（PC 専用）"),
    ("国試フラッシュカード（iPad）", "start_ipad.bat", "薬剤師国試 フラッシュカードを起動（同じ Wi-Fi の iPad からも使う）"),
)

PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ws = New-Object -ComObject WScript.Shell
$desk = [Environment]::GetFolderPath('Desktop')
$n = [int]$env:YF_COUNT
for ($i = 0; $i -lt $n; $i++) {
  $name = [Environment]::GetEnvironmentVariable("YF_NAME_$i")
  $path = Join-Path $desk ($name + '.lnk')
  $lnk = $ws.CreateShortcut($path)
  $lnk.TargetPath = [Environment]::GetEnvironmentVariable("YF_TARGET_$i")
  $lnk.WorkingDirectory = $env:YF_DIR
  $lnk.IconLocation = $env:YF_ICON + ',0'
  $lnk.Description = [Environment]::GetEnvironmentVariable("YF_DESC_$i")
  $lnk.Save()
  [Console]::Out.WriteLine($path)
}
"""


def build_command(app_dir: Path = APP_DIR) -> tuple[list[str], dict[str, str]]:
    """PowerShell のコマンドと、渡す環境変数（テストしやすいよう分けておく）。"""
    env = {"YF_COUNT": str(len(SHORTCUTS)), "YF_DIR": str(app_dir), "YF_ICON": str(app_dir / "static" / "icon.ico")}
    for i, (name, bat, desc) in enumerate(SHORTCUTS):
        env[f"YF_NAME_{i}"] = name
        env[f"YF_TARGET_{i}"] = str(app_dir / bat)
        env[f"YF_DESC_{i}"] = desc
    encoded = base64.b64encode(PS_SCRIPT.encode("utf-16-le")).decode("ascii")
    cmd = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-EncodedCommand", encoded]
    return cmd, env


def create_desktop_shortcuts() -> list[str]:
    """デスクトップにショートカットを作り、作ったファイルのパスを返す（同じ名前があれば上書き）。"""
    if sys.platform != "win32":
        raise RuntimeError("ショートカットの作成は Windows でだけできます")
    cmd, extra = build_command()
    for _, bat, _ in SHORTCUTS:
        if not (APP_DIR / bat).exists():
            raise RuntimeError(f"{bat} が見つかりません: {APP_DIR}")
    proc = subprocess.run(
        cmd, env={**os.environ, **extra}, capture_output=True, timeout=60,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    out = proc.stdout.decode("utf-8", "replace") if proc.stdout else ""
    if proc.returncode != 0:
        err = proc.stderr.decode("mbcs" if sys.platform == "win32" else "utf-8", "replace").strip()
        raise RuntimeError(f"ショートカットを作れませんでした: {err[-300:] or proc.returncode}")
    return [line.strip() for line in out.splitlines() if line.strip()]
