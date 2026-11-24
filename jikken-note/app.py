# -*- coding: utf-8 -*-
"""実験ノート印刷ツール（ローカル専用サーバ）

Python に最初から入っている機能だけで動きます（追加インストール不要）。
  - データ: data/notebook.db （SQLite 1ファイル）
  - 画面:   static/ フォルダ
起動すると自動でブラウザが開きます。この黒い画面を閉じると終了します。
"""
import base64
import json
import os
import socket
import shutil
import sqlite3
import sys
import threading
import urllib.request
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"   # 自分のPCからだけ接続できる（--share のときは研究室のネットワークからも）
PORT = 8765
SHARE = "--share" in sys.argv
PASSWORD = ""        # 共有モードの合言葉（password.txt に保存）
BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
DATA_DIR = os.path.join(BASE, "data")
DB_PATH = os.path.join(DATA_DIR, "notebook.db")
PASSWORD_FILE = os.path.join(DATA_DIR, "password.txt")
BACKUP_DIR = os.path.join(BASE, "backup")
AUTO_BACKUP_KEEP = 14

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def location_warning():
    """データが壊れやすい置き場所（クラウド同期・ダウンロード・ネットワーク上）なら注意文を返す"""
    low = BASE.lower().replace("/", "\\")
    if any(k in low for k in ("onedrive", "dropbox", "google drive", "googledrive", "icloud", "box sync")):
        return "このツールはクラウド同期フォルダ（OneDrive など）の中にあります。同期の途中でデータが壊れることがあるので、同期されないフォルダ（例：C:\\jikken-note）に移すことをおすすめします。"
    if "\\downloads\\" in low + "\\" or "\\ダウンロード\\" in low + "\\":
        return "このツールは「ダウンロード」フォルダの中にあります。整理のときに消してしまわないよう、別のフォルダ（例：C:\\jikken-note）に移すことをおすすめします。"
    if low.startswith("\\\\"):
        return "このツールはネットワーク上のフォルダにあります。データが壊れることがあるので、自分のPCのフォルダに置いてください。"
    return ""


def app_version():
    """ツール本体のファイルの更新日時。変わったら開いている画面に「再読み込み」を出す"""
    latest = os.path.getmtime(os.path.abspath(__file__))
    for root, _, files in os.walk(STATIC):
        for f in files:
            latest = max(latest, os.path.getmtime(os.path.join(root, f)))
    return str(int(latest))


def lan_addresses():
    """他のPCから開くときのアドレス候補"""
    names = [socket.gethostname()]
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))   # 実際には送信しない（使用中のIPを調べるだけ）
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    ips.discard("127.0.0.1")
    return [f"http://{h}:{PORT}/" for h in names + sorted(ips)]


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")


def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    fresh = not os.path.exists(DB_PATH)
    con = connect()
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS protocols (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sort INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL,
            created TEXT NOT NULL,
            updated TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            protocol_id INTEGER,
            protocol_name TEXT NOT NULL DEFAULT '',
            exp_date TEXT NOT NULL DEFAULT '',
            data TEXT NOT NULL,
            created TEXT NOT NULL,
            updated TEXT NOT NULL,
            printed TEXT
        );
        """
    )
    seed_protocols = []
    if fresh:
        try:
            import seed
            seed_protocols = seed.PROTOCOLS
        except Exception as e:  # noqa  登録データが無い・壊れている場合は空で始める
            print("最初の登録データを読み込めませんでした（プロトコル0件で開始）:", e)
    if fresh:
        for i, p in enumerate(seed_protocols):
            con.execute(
                "INSERT INTO protocols(name, sort, data, created, updated) VALUES (?,?,?,?,?)",
                (p["name"], (i + 1) * 10, json.dumps(p, ensure_ascii=False), now(), now()),
            )
    con.commit()
    con.close()


def backup(auto=False):
    """データベースを backup/ にコピー。auto=True のときは1日1回まで・古いものは削除。"""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    if not os.path.exists(DB_PATH):
        return None
    if auto:
        today = datetime.now().strftime("%Y%m%d")
        if any(f.startswith("auto_" + today) for f in os.listdir(BACKUP_DIR)):
            return None
        name = "auto_" + datetime.now().strftime("%Y%m%d_%H%M%S") + ".db"
    else:
        name = "notebook_" + datetime.now().strftime("%Y%m%d_%H%M%S") + ".db"
    dest = os.path.join(BACKUP_DIR, name)
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(dest)
    with dst:
        src.backup(dst)   # 使用中でも安全にコピーできる方法
    src.close()
    dst.close()
    if auto:
        autos = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("auto_"))
        for f in autos[:-AUTO_BACKUP_KEEP]:
            os.remove(os.path.join(BACKUP_DIR, f))
    return dest


def row_protocol(r, full=True):
    d = {"id": r["id"], "name": r["name"], "sort": r["sort"], "updated": r["updated"]}
    if full:
        d["data"] = json.loads(r["data"])
    return d


def row_record(r, full=True):
    d = {
        "id": r["id"], "protocol_id": r["protocol_id"], "protocol_name": r["protocol_name"],
        "exp_date": r["exp_date"], "created": r["created"], "updated": r["updated"],
        "printed": r["printed"],
    }
    data = json.loads(r["data"])
    d["title"] = (data.get("doc") or {}).get("title", "")
    if full:
        d["data"] = data
    return d


class Handler(BaseHTTPRequestHandler):
    server_version = "JikkenNote/1.0"

    def log_message(self, fmt, *args):   # 画面をすっきりさせるため通常のログは出さない
        pass

    # ---------- helpers ----------
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            self.send_error(404)
            return
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def auth_ok(self):
        """共有モードで合言葉が設定されているとき、他のPCからの接続には合言葉を求める"""
        if not PASSWORD or self.is_local():
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                user_pass = base64.b64decode(h[6:]).decode("utf-8")
                if user_pass.split(":", 1)[1] == PASSWORD:
                    return True
            except Exception:
                pass
        body = "合言葉が必要です".encode("utf-8")
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="jikken-note", charset="UTF-8"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    def shortcut(self):
        host = self.headers.get("Host") or f"{HOST}:{PORT}"
        body = (f"[InternetShortcut]\r\nURL=http://{host}/\r\n"
                f"IconFile=http://{host}/icon.ico\r\nIconIndex=0\r\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''%E5%AE%9F%E9%A8%93%E3%83%8E%E3%83%BC%E3%83%88%E5%8D%B0%E5%88%B7.url")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def parts(self):
        u = urlparse(self.path)
        return u, [p for p in u.path.split("/") if p]

    # ---------- routes ----------
    def do_GET(self):
        if not self.auth_ok():
            return
        u, p = self.parts()
        if u.path == "/shortcut.url":
            return self.shortcut()
        if not p or p[0] != "api":
            return self.serve_static(u.path)
        try:
            con = connect()
            if p[1:] == ["ping"]:
                return self.send_json({"app": "jikken-note"})
            if p[1] == "protocols":
                if len(p) == 2:
                    rows = con.execute("SELECT * FROM protocols ORDER BY sort, id").fetchall()
                    return self.send_json([row_protocol(r, False) for r in rows])
                r = con.execute("SELECT * FROM protocols WHERE id=?", (int(p[2]),)).fetchone()
                return self.send_json(row_protocol(r)) if r else self.send_json({"error": "not found"}, 404)
            if p[1] == "records":
                if len(p) == 2:
                    q = (parse_qs(u.query).get("q") or [""])[0].strip()
                    rows = con.execute("SELECT * FROM records ORDER BY exp_date DESC, id DESC").fetchall()
                    out = [row_record(r, False) for r in rows]
                    if q:
                        raw = {r["id"]: r["data"] for r in rows}
                        out = [o for o in out if q in o["protocol_name"] or q in o["title"]
                               or q in o["exp_date"] or q in raw[o["id"]]]
                    return self.send_json(out)
                r = con.execute("SELECT * FROM records WHERE id=?", (int(p[2]),)).fetchone()
                return self.send_json(row_record(r)) if r else self.send_json({"error": "not found"}, 404)
            if p[1] == "info":
                return self.send_json({"db": DB_PATH, "backup_dir": BACKUP_DIR, "share": SHARE,
                                       "local": self.is_local(), "password": bool(PASSWORD), "version": app_version(),
                                       "warn": location_warning() if self.is_local() else "",
                                       "addresses": lan_addresses() if SHARE else []})
            self.send_json({"error": "not found"}, 404)
        except Exception as e:  # noqa
            self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        if not self.auth_ok():
            return
        u, p = self.parts()
        try:
            con = connect()
            body = self.read_json()
            if p[1:] == ["import"]:
                # Word（.docx）を読み取って段落・表・画像の並びを返す（PDF は画面側で読む）
                name = (body.get("name") or "").lower()
                if not name.endswith(".docx"):
                    return self.send_json({"error": "Word は .docx 形式のファイルにしてください（古い .doc は Word で開いて「名前を付けて保存」→ .docx）"}, 400)
                import importer
                try:
                    items = importer.read_docx(base64.b64decode(body.get("data") or ""))
                except Exception as e:  # noqa
                    return self.send_json({"error": "Word ファイルを読み取れませんでした: " + str(e)}, 400)
                return self.send_json({"items": items})
            if p[1:] == ["backup"]:
                if not self.is_local():
                    return self.send_json({"error": "バックアップはツールを起動しているPCで行ってください"}, 403)
                return self.send_json({"path": backup()})
            if p[1] == "protocols":
                if len(p) == 2:
                    data = body["data"]
                    srt = con.execute("SELECT COALESCE(MAX(sort),0)+10 FROM protocols").fetchone()[0]
                    cur = con.execute(
                        "INSERT INTO protocols(name, sort, data, created, updated) VALUES (?,?,?,?,?)",
                        (data.get("name") or "無題", srt, json.dumps(data, ensure_ascii=False), now(), now()))
                    con.commit()
                    return self.send_json({"id": cur.lastrowid})
                if len(p) == 4 and p[3] == "duplicate":
                    r = con.execute("SELECT * FROM protocols WHERE id=?", (int(p[2]),)).fetchone()
                    data = json.loads(r["data"])
                    data["name"] = data.get("name", "") + "（コピー）"
                    cur = con.execute(
                        "INSERT INTO protocols(name, sort, data, created, updated) VALUES (?,?,?,?,?)",
                        (data["name"], r["sort"] + 1, json.dumps(data, ensure_ascii=False), now(), now()))
                    con.commit()
                    return self.send_json({"id": cur.lastrowid})
                if len(p) == 4 and p[3] == "move":
                    # 並べ替え: body = {"dir": -1 or 1}
                    rows = con.execute("SELECT id FROM protocols ORDER BY sort, id").fetchall()
                    ids = [r["id"] for r in rows]
                    i = ids.index(int(p[2]))
                    j = i + int(body.get("dir", 0))
                    if 0 <= j < len(ids):
                        ids[i], ids[j] = ids[j], ids[i]
                        for k, pid in enumerate(ids):
                            con.execute("UPDATE protocols SET sort=? WHERE id=?", ((k + 1) * 10, pid))
                        con.commit()
                    return self.send_json({"ok": True})
            if p[1] == "records":
                if len(p) == 2:
                    data = body["data"]
                    cur = con.execute(
                        "INSERT INTO records(protocol_id, protocol_name, exp_date, data, created, updated) "
                        "VALUES (?,?,?,?,?,?)",
                        (data.get("protocol_id"), data.get("protocol_name", ""), data.get("exp_date", ""),
                         json.dumps(data, ensure_ascii=False), now(), now()))
                    con.commit()
                    return self.send_json({"id": cur.lastrowid})
                if len(p) == 4 and p[3] == "printed":
                    con.execute("UPDATE records SET printed=? WHERE id=?", (now(), int(p[2])))
                    con.commit()
                    return self.send_json({"ok": True})
                if len(p) == 4 and p[3] == "duplicate":
                    r = con.execute("SELECT * FROM records WHERE id=?", (int(p[2]),)).fetchone()
                    data = json.loads(r["data"])
                    data["exp_date"] = datetime.now().strftime("%Y-%m-%d")
                    cur = con.execute(
                        "INSERT INTO records(protocol_id, protocol_name, exp_date, data, created, updated) "
                        "VALUES (?,?,?,?,?,?)",
                        (r["protocol_id"], r["protocol_name"], data["exp_date"],
                         json.dumps(data, ensure_ascii=False), now(), now()))
                    con.commit()
                    return self.send_json({"id": cur.lastrowid})
            self.send_json({"error": "not found"}, 404)
        except Exception as e:  # noqa
            self.send_json({"error": str(e)}, 500)

    def do_PUT(self):
        if not self.auth_ok():
            return
        u, p = self.parts()
        try:
            con = connect()
            body = self.read_json()
            data = body["data"]
            table = {"protocols": "protocols", "records": "records"}[p[1]]
            cur = con.execute(f"SELECT updated FROM {table} WHERE id=?", (int(p[2]),)).fetchone()
            if cur is None:
                return self.send_json({"error": "見つかりません（削除された可能性があります）"}, 404)
            # 同時編集の上書き防止：開いた後に別の人が保存していたら知らせる
            if body.get("base") and body["base"] != cur["updated"] and not body.get("force"):
                return self.send_json({"conflict": True, "updated": cur["updated"]}, 409)
            if p[1] == "protocols":
                con.execute("UPDATE protocols SET name=?, data=?, updated=? WHERE id=?",
                            (data.get("name") or "無題", json.dumps(data, ensure_ascii=False), now(), int(p[2])))
            elif p[1] == "records":
                con.execute("UPDATE records SET protocol_name=?, exp_date=?, data=?, updated=? WHERE id=?",
                            (data.get("protocol_name", ""), data.get("exp_date", ""),
                             json.dumps(data, ensure_ascii=False), now(), int(p[2])))
            con.commit()
            new = con.execute(f"SELECT updated FROM {table} WHERE id=?", (int(p[2]),)).fetchone()["updated"]
            self.send_json({"ok": True, "updated": new})
        except Exception as e:  # noqa
            self.send_json({"error": str(e)}, 500)

    def do_DELETE(self):
        if not self.auth_ok():
            return
        u, p = self.parts()
        try:
            con = connect()
            table = {"protocols": "protocols", "records": "records"}[p[1]]
            con.execute(f"DELETE FROM {table} WHERE id=?", (int(p[2]),))
            con.commit()
            self.send_json({"ok": True})
        except Exception as e:  # noqa
            self.send_json({"error": str(e)}, 500)


def already_running():
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/api/ping", timeout=1) as r:
            return b"jikken-note" in r.read()
    except Exception:
        return False


def setup_password():
    global PASSWORD
    if os.path.exists(PASSWORD_FILE):
        PASSWORD = open(PASSWORD_FILE, encoding="utf-8").read().strip()
        return
    print("共有モードを初めて使います。")
    print("他のPCから開くときに入力する「合言葉」を決めてください。")
    print("（何も入力せずに Enter を押すと合言葉なしになります。研究室外の人も開ける可能性があるので、設定をおすすめします）")
    try:
        PASSWORD = input("合言葉: ").strip()
    except EOFError:
        PASSWORD = ""
    with open(PASSWORD_FILE, "w", encoding="utf-8") as f:
        f.write(PASSWORD)
    print("合言葉を保存しました（変えるときは data\\password.txt を消して起動し直す）")


def main():
    url = f"http://127.0.0.1:{PORT}/"
    no_browser = "--no-browser" in sys.argv
    if already_running():
        print("すでに起動しています。ブラウザを開きます。")
        if not no_browser:
            webbrowser.open(url)
        return
    sys.path.insert(0, BASE)
    init_db()
    try:
        b = backup(auto=True)
        if b:
            print("自動バックアップ:", b)
    except Exception as e:  # noqa
        print("自動バックアップに失敗:", e)
    bind = HOST
    if SHARE:
        setup_password()
        bind = "0.0.0.0"
    try:
        server = ThreadingHTTPServer((bind, PORT), Handler)
    except OSError as e:
        print("起動できませんでした（ポート", PORT, "が使用中の可能性）:", e)
        return
    if location_warning():
        print("【注意】" + location_warning())
    print("=" * 50)
    print(" 実験ノート印刷ツール 起動中" + ("（共有モード）" if SHARE else ""))
    print(" ブラウザで", url, "を開いています")
    if SHARE:
        print(" 他のPCからは、次のどれかのアドレスをブラウザで開いてください:")
        for a in lan_addresses():
            print("   ", a)
        print(" 合言葉:", "あり" if PASSWORD else "なし")
        print(" ※Windowsの「アクセスを許可しますか」が出たら「許可」を押してください")
    print(" 終了するときは、この画面を閉じてください")
    print("=" * 50)
    if not no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
