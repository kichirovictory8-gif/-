"""iPad など同じ Wi-Fi の機器から使うための仕組み（パスコード・ログイン・接続先の判定）。

- パスコード（6桁）は初回に自動で作り、データフォルダの settings.json に保存する
- iPad でパスコードを入れるとログイン用の合言葉（トークン）を発行し、Cookie で覚えさせる
  （settings.json にはトークンそのものではなくハッシュ値だけを保存する）
- パスコードを変更すると、それまでに覚えさせた機器はすべて入り直しになる
- 間違いが続いた接続元は、しばらく受け付けない
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import secrets
import socket
import threading
import time
from pathlib import Path

SETTINGS_NAME = "settings.json"
COOKIE_NAME = "yf_token"
COOKIE_MAX_AGE = 400 * 24 * 3600   # ブラウザが許す最長（約400日）
MAX_FAILURES = 5
LOCK_SECONDS = 10 * 60


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_passcode() -> str:
    return f"{secrets.randbelow(10**6):06d}"


class LanAuth:
    def __init__(self, settings_path: Path, clock=time.monotonic):
        self.path = settings_path
        self.clock = clock
        self.lock = threading.Lock()
        self.failures: dict[str, list[float]] = {}
        self.settings = self._load()
        if not self.settings.get("lan_passcode"):
            self.settings["lan_passcode"] = new_passcode()
            self.settings["lan_tokens"] = []
            self._save()

    # ---- 保存 ----
    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.settings, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    # ---- パスコード ----
    @property
    def passcode(self) -> str:
        return self.settings["lan_passcode"]

    def change_passcode(self) -> str:
        with self.lock:
            self.settings["lan_passcode"] = new_passcode()
            self.settings["lan_tokens"] = []
            self._save()
            return self.passcode

    # ---- ログイン ----
    def locked_for(self, client: str) -> int:
        """この接続元があと何秒受け付けないか（0 なら受け付ける）。"""
        now = self.clock()
        recent = [t for t in self.failures.get(client, []) if now - t < LOCK_SECONDS]
        self.failures[client] = recent
        if len(recent) >= MAX_FAILURES:
            return int(LOCK_SECONDS - (now - recent[-MAX_FAILURES])) + 1
        return 0

    def login(self, client: str, passcode: str) -> str | None:
        """正しければ新しいトークンを返す。間違い・受付停止中なら None。"""
        with self.lock:
            if self.locked_for(client):
                return None
            if not hmac.compare_digest(str(passcode).strip(), self.passcode):
                self.failures.setdefault(client, []).append(self.clock())
                return None
            self.failures.pop(client, None)
            token = secrets.token_urlsafe(32)
            tokens = self.settings.setdefault("lan_tokens", [])
            tokens.append(_hash(token))
            del tokens[:-50]   # 古いものから捨てる（最大50台分）
            self._save()
            return token

    def check(self, token: str | None) -> bool:
        if not token:
            return False
        h = _hash(token)
        return any(hmac.compare_digest(h, t) for t in self.settings.get("lan_tokens", []))


def is_loopback(client_ip: str) -> bool:
    try:
        return ipaddress.ip_address(client_ip.split("%")[0]).is_loopback
    except ValueError:
        return False


def host_allowed(host_header: str, port: int, lan: bool) -> bool:
    """Host ヘッダーの確認（悪意あるサイトからの DNS リバインディング対策）。

    通常モード: 127.0.0.1 / localhost のみ。
    iPad モード: それに加えて IP アドレスでの指定と、この PC の名前（.local 含む）。
    """
    host = (host_header or "").strip().lower()
    if not host:
        return False
    if host.startswith("["):              # IPv6 [::1]:8765
        name, _, rest = host[1:].partition("]")
        port_part = rest[1:] if rest.startswith(":") else ""
    else:
        name, _, port_part = host.rpartition(":") if ":" in host else (host, "", "")
    if port_part != str(port):
        return False
    if name in ("127.0.0.1", "localhost", "::1"):
        return True
    if not lan:
        return False
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass
    pc = socket.gethostname().lower()
    return name in (pc, pc + ".local")


def local_ips() -> list[str]:
    """iPad から入力するための、この PC の LAN 内アドレス（推定）。"""
    found: list[str] = []
    try:   # 実際には送信しない（経路の選択だけ）
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.168.255.255", 1))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in found:
                found.append(ip)
    except OSError:
        pass
    out = []
    for ip in found:
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if a.is_private and not a.is_loopback and not a.is_link_local:
            out.append(ip)
    return out
