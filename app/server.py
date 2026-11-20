"""起動スクリプト: ローカルサーバーを立ち上げてブラウザで開く。

    python server.py               # 通常起動
    python server.py --no-browser  # ブラウザを開かない
    python server.py --port 8800   # ポートを指定

データの場所は環境変数 YAKUSHI_FLASH_DIR で変更できる。
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import threading
import traceback
import urllib.request
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from flashcards import APP_ID, VERSION, cloze, db, io_json, srs, stats, storage  # noqa: E402
from flashcards.bulk import parse_bulk  # noqa: E402
from flashcards.subjects import SUBJECTS  # noqa: E402

STATIC_DIR = Path(__file__).resolve().parent / "static"
DEFAULT_PORT = 8765
MAX_BODY = 200 * 1024 * 1024
CSRF_HEADER = "X-Yakushi-Flash"


class App:
    """サーバー全体で共有する状態。SQLite へのアクセスはロックで1本化する。"""

    def __init__(self, db_file: Path):
        self.db_file = db_file
        self.conn = db.connect(db_file, threadsafe=True)
        self.lock = threading.Lock()
        self.store = db.Store(self.conn)

    @property
    def backups(self) -> Path:
        return storage.backup_dir(self.db_file.parent)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _int(value, name="id") -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ApiError(400, f"{name} が正しくありません") from None


def weak_with_plain(data: dict) -> dict:
    for c in data["cards"]:
        c["front_plain"] = cloze.plain(c["front"])
    return data


class Handler(BaseHTTPRequestHandler):
    app: App  # 起動時に設定
    port: int
    protocol_version = "HTTP/1.1"
    timeout = 60

    def log_message(self, fmt, *args):  # 静かにする（エラーだけ表示）
        pass

    # ---- 共通 ----
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        return host in {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data, status: int = 200, extra: dict | None = None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "データが大きすぎます")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "JSON の形式が正しくありません") from None
        if not isinstance(data, dict):
            raise ApiError(400, "JSON の形式が正しくありません")
        return data

    def _dispatch(self, method: str):
        if not self._host_ok():
            self._json({"error": "許可されていないアクセスです"}, 403)
            return
        url = urlparse(self.path)
        path = url.path
        query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            if path.startswith("/api/"):
                if method != "GET" and self.headers.get(CSRF_HEADER) != "1":
                    raise ApiError(403, "許可されていないアクセスです")
                body = self._body() if method in ("POST", "PUT") else {}
                with self.app.lock:
                    self._api(method, path[len("/api/"):].strip("/").split("/"), query, body)
            elif method == "GET":
                self._static(path)
            else:
                raise ApiError(404, "見つかりません")
        except ApiError as e:
            self._json({"error": str(e)}, e.status)
        except KeyError as e:
            self._json({"error": e.args[0] if e.args else "見つかりません"}, 404)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:  # 想定外
            traceback.print_exc()
            self._json({"error": f"内部エラー: {e}"}, 500)

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    # ---- 静的ファイル ----
    def _static(self, path: str):
        if path in ("", "/"):
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR.resolve() not in target.parents or not target.is_file():
            raise ApiError(404, "見つかりません")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    # ---- API ----
    def _api(self, method: str, parts: list[str], q: dict, body: dict):
        app = self.app
        st = app.store
        conn = app.conn
        route = (method, parts[0] if parts else "")

        if route == ("GET", "ping"):
            return self._json({"app": APP_ID, "version": VERSION})

        if route == ("GET", "meta"):
            return self._json({
                "app": APP_ID, "version": VERSION, "subjects": SUBJECTS,
                "intervals": srs.INTERVALS, "mature_days": srs.MATURE_DAYS,
                "mature_stage": srs.MATURE_STAGE, "day_boundary_hour": srs.DAY_BOUNDARY_HOUR,
                "today": st.today().isoformat(), "db_path": str(app.db_file),
                "backup_dir": str(app.backups),
            })

        if route == ("GET", "dashboard"):
            return self._json(stats.dashboard(conn, st.today()))

        if parts[0] == "session" and method == "GET" and parts[1:] == ["next"]:
            return self._json(st.next_card(q.get("subject", "")))

        if route == ("POST", "review"):
            result = st.record_review(_int(body.get("card_id")), str(body.get("rating", "")))
            return self._json(result)

        if parts[0] == "cards":
            return self._cards(method, parts[1:], q, body)

        if route == ("GET", "units"):
            return self._json(st.units(q.get("subject", "")))

        if parts[0] == "stats" and method == "GET":
            kind = parts[1] if len(parts) > 1 else ""
            if kind == "subjects":
                return self._json(stats.by_subject(conn))
            if kind == "units":
                return self._json(stats.by_unit(conn, q.get("subject", "")))

        if route == ("GET", "weak"):
            days = max(1, min(365, _int(q.get("days", 14), "days")))
            min_again = max(1, min(50, _int(q.get("min", 2), "min")))
            return self._json(weak_with_plain(stats.weak(conn, st.today(), days, min_again)))

        if route == ("POST", "backup"):
            path = storage.make_backup(conn, app.backups, "manual")
            return self._json({"path": str(path)})

        if route == ("GET", "export"):
            data = io_json.export_data(conn)
            name = f"yakushi-flash_{datetime.now():%Y%m%d_%H%M%S}.json"
            body_bytes = json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8")
            return self._send(200, body_bytes, "application/json; charset=utf-8",
                              {"Content-Disposition": f'attachment; filename="{name}"'})

        if route == ("POST", "import"):
            mode = str(body.get("mode", ""))
            if mode not in io_json.MODES:
                raise ApiError(400, "取り込み方法（追加／全置き換え）を選んでください")
            backup = storage.make_backup(conn, app.backups, "before-import")
            result = io_json.import_data(conn, body.get("data"), mode)
            result["backup"] = str(backup)
            return self._json(result)

        raise ApiError(404, "見つかりません")

    def _cards(self, method: str, rest: list[str], q: dict, body: dict):
        st = self.app.store
        if not rest:
            if method == "GET":
                limit = max(1, min(500, _int(q.get("limit", 50), "limit")))
                offset = max(0, _int(q.get("offset", 0), "offset"))
                unit = q.get("unit")
                return self._json(st.list_cards(
                    q=q.get("q", "").strip(), subject=q.get("subject", ""),
                    unit=unit if "unit" in q else None, level=q.get("level", ""),
                    due=q.get("due", ""), sort=q.get("sort", "due"), limit=limit, offset=offset,
                ))
            if method == "POST":
                card_id = st.add_card(body.get("subject", ""), body.get("unit", ""),
                                      body.get("front", ""), body.get("back", ""))
                return self._json(st.get_card(card_id), 201)
        if rest == ["bulk"] and method == "POST":
            parsed = parse_bulk(str(body.get("text", "")))
            preview = {
                "count": len(parsed.cards),
                "errors": [{"line": n, "message": m} for n, m in parsed.errors],
                "samples": [{"front": f, "back": b, "question_html": cloze.render_question(f)}
                            for f, b in parsed.cards[:5]],
            }
            if body.get("dry_run"):
                return self._json(preview)
            if parsed.errors:
                raise ApiError(400, f"{len(parsed.errors)}行に問題があります。直してから追加してください")
            if not parsed.cards:
                raise ApiError(400, "追加するカードがありません")
            ids = st.add_many(body.get("subject", ""), body.get("unit", ""), parsed.cards)
            return self._json({**preview, "added": len(ids)}, 201)
        card_id = _int(rest[0])
        if len(rest) == 1:
            if method == "GET":
                return self._json(st.get_card(card_id))
            if method == "PUT":
                st.update_card(card_id, body.get("subject", ""), body.get("unit", ""),
                               body.get("front", ""), body.get("back", ""))
                return self._json(st.get_card(card_id))
            if method == "DELETE":
                st.delete_card(card_id)
                return self._json({"deleted": card_id})
        if rest[1:] == ["reset"] and method == "POST":
            st.reset_card(card_id)
            return self._json(st.get_card(card_id))
        if rest[1:] == ["history"] and method == "GET":
            return self._json(st.card_history(card_id))
        raise ApiError(404, "見つかりません")


def already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1) as r:
            return json.loads(r.read().decode("utf-8")).get("app") == APP_ID
    except Exception:
        return False


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="薬剤師国試 フラッシュカード")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    if already_running(args.port):
        print("すでに起動しています。ブラウザで開きます。")
        if not args.no_browser:
            webbrowser.open(f"http://127.0.0.1:{args.port}/")
        return 0

    db_file = storage.db_path()
    app = App(db_file)
    auto = storage.auto_backup(app.conn, app.backups)

    server = None
    port = args.port
    for port in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if server is None:
        print("使えるポートが見つかりませんでした。")
        return 1
    server.daemon_threads = True
    Handler.app = app
    Handler.port = port

    url = f"http://127.0.0.1:{port}/"
    print("=" * 60)
    print(" 薬剤師国試 フラッシュカード")
    print(f"  画面        : {url}")
    print(f"  データファイル: {db_file}")
    if auto:
        print(f"  自動バックアップ: {auto.name}")
    print("  終了するには、この黒い画面を閉じるか Ctrl+C を押してください。")
    print("=" * 60)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
