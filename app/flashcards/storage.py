"""データファイルの場所とバックアップ。"""
from __future__ import annotations

import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

DB_NAME = "flashcards.db"
DIR_NAME = "yakushi-flash"
ENV_DIR = "YAKUSHI_FLASH_DIR"
AUTO_BACKUP_KEEP = 14


def documents_dir() -> Path:
    """「ドキュメント」フォルダ。Windows では OneDrive への移動にも追従する。"""
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
            # CSIDL_PERSONAL = 5（ドキュメント）
            if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:
                return Path(buf.value)
        except Exception:
            pass
    return Path.home() / "Documents"


def data_dir() -> Path:
    override = os.environ.get(ENV_DIR)
    d = Path(override) if override else documents_dir() / DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / DB_NAME


def backup_dir(base: Path) -> Path:
    d = base / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def make_backup(conn: sqlite3.Connection, dest_dir: Path, label: str = "manual",
                now: datetime | None = None) -> Path:
    """SQLite のバックアップ機能で、使用中でも安全にコピーする。"""
    now = now or datetime.now()
    dest_dir.mkdir(parents=True, exist_ok=True)
    stem = f"flashcards_{now:%Y%m%d_%H%M%S}_{label}"
    path = dest_dir / f"{stem}.db"
    n = 1
    while path.exists():
        n += 1
        path = dest_dir / f"{stem}_{n}.db"
    dst = sqlite3.connect(str(path))
    try:
        conn.backup(dst)
    finally:
        dst.close()
    return path


def auto_backup(conn: sqlite3.Connection, dest_dir: Path, now: datetime | None = None,
                keep: int = AUTO_BACKUP_KEEP) -> Path | None:
    """起動時の自動バックアップ（1日1回）。古い自動バックアップは keep 個だけ残す。"""
    now = now or datetime.now()
    dest_dir.mkdir(parents=True, exist_ok=True)
    if list(dest_dir.glob(f"flashcards_{now:%Y%m%d}_*_auto*.db")):
        return None
    if conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0] == 0:
        return None
    path = make_backup(conn, dest_dir, "auto", now)
    autos = sorted(dest_dir.glob("flashcards_*_auto*.db"))
    for old in autos[:-keep]:
        try:
            old.unlink()
        except OSError:
            pass
    return path
