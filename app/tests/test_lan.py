"""iPad から使うモード（パスコード・ログイン・接続元の判定）。"""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from tests import helpers  # noqa: F401
import server
from flashcards import lan


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class LanAuthTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "settings.json"
        self.clock = FakeClock()
        self.auth = lan.LanAuth(self.path, self.clock)

    def test_passcode_created_and_kept(self):
        code = self.auth.passcode
        self.assertRegex(code, r"^\d{6}$")
        self.assertEqual(lan.LanAuth(self.path).passcode, code)   # 次の起動でも同じ

    def test_login_and_token(self):
        self.assertIsNone(self.auth.login("1.1.1.1", "x"))
        token = self.auth.login("1.1.1.1", self.auth.passcode)
        self.assertTrue(token)
        self.assertTrue(self.auth.check(token))
        self.assertTrue(lan.LanAuth(self.path).check(token))      # 再起動後も有効
        self.assertFalse(self.auth.check("nope"))
        self.assertFalse(self.auth.check(None))
        self.assertNotIn(token, self.path.read_text(encoding="utf-8"))  # トークンそのものは保存しない

    def test_change_passcode_logs_out(self):
        token = self.auth.login("1.1.1.1", self.auth.passcode)
        old = self.auth.passcode
        new = self.auth.change_passcode()
        self.assertFalse(self.auth.check(token))
        if old != new:
            self.assertIsNone(self.auth.login("1.1.1.1", old))
        self.assertTrue(self.auth.login("1.1.1.1", new))

    def test_lockout(self):
        for _ in range(lan.MAX_FAILURES):
            self.assertIsNone(self.auth.login("2.2.2.2", "wrong"))
        self.assertGreater(self.auth.locked_for("2.2.2.2"), 0)
        self.assertIsNone(self.auth.login("2.2.2.2", self.auth.passcode))   # 正しくても受け付けない
        self.assertTrue(self.auth.login("3.3.3.3", self.auth.passcode))     # 別の接続元は影響なし
        self.clock.t += lan.LOCK_SECONDS + 1
        self.assertEqual(self.auth.locked_for("2.2.2.2"), 0)
        self.assertTrue(self.auth.login("2.2.2.2", self.auth.passcode))


class HostTest(unittest.TestCase):
    def test_host(self):
        self.assertTrue(lan.host_allowed("127.0.0.1:8765", 8765, False))
        self.assertFalse(lan.host_allowed("192.168.1.10:8765", 8765, False))
        self.assertTrue(lan.host_allowed("192.168.1.10:8765", 8765, True))
        self.assertFalse(lan.host_allowed("evil.example:8765", 8765, True))
        self.assertFalse(lan.host_allowed("192.168.1.10:80", 8765, True))
        self.assertFalse(lan.host_allowed("", 8765, True))

    def test_loopback(self):
        self.assertTrue(lan.is_loopback("127.0.0.1"))
        self.assertTrue(lan.is_loopback("::1"))
        self.assertFalse(lan.is_loopback("192.168.1.20"))
        self.assertFalse(lan.is_loopback("garbage"))


class LanServerTest(unittest.TestCase):
    """iPad（PC 以外）からのアクセスを再現して、サーバーを通しで確かめる。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.app = server.App(Path(cls.tmp.name) / "flashcards.db", lan_mode=True)

        class RemoteHandler(server.Handler):
            remote = True

            def _is_local(self):
                return not type(self).remote

        cls.Handler = RemoteHandler
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), RemoteHandler)
        RemoteHandler.app = cls.app
        RemoteHandler.port = cls.httpd.server_address[1]
        cls.port = RemoteHandler.port
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.app.conn.close()
        cls.tmp.cleanup()

    def setUp(self):
        self.Handler.remote = True
        self.app.auth.failures.clear()

    def call(self, method, path, body=None, cookie=None, host=None):
        h = {"Content-Type": "application/json", "X-Yakushi-Flash": "1",
             "Host": host or f"192.168.1.10:{self.port}"}
        if cookie:
            h["Cookie"] = cookie
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read().decode()), r.headers
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode()), e.headers

    def login(self):
        s, _, headers = self.call("POST", "/api/login", {"passcode": self.app.auth.passcode})
        self.assertEqual(s, 200)
        cookie = headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        return cookie.split(";")[0]

    def test_remote_needs_passcode(self):
        s, d, _ = self.call("GET", "/api/meta")
        self.assertEqual((s, d.get("auth")), (401, True))
        s, d, _ = self.call("GET", "/api/ping")
        self.assertEqual((s, d["lan"]), (200, True))
        s, d, _ = self.call("POST", "/api/login", {"passcode": "wrong"})
        self.assertEqual(s, 403)
        cookie = self.login()
        s, d, _ = self.call("GET", "/api/meta", cookie=cookie)
        self.assertEqual((s, d["is_local"]), (200, False))
        self.assertNotIn("passcode", d)        # iPad 側にはパスコードを見せない
        s, c, _ = self.call("POST", "/api/cards", {"subject": "薬理", "front": "a", "back": "b"}, cookie=cookie)
        self.assertEqual(s, 201)
        s, _, _ = self.call("POST", "/api/lan/passcode", {}, cookie=cookie)
        self.assertEqual(s, 403)               # 変更は PC からだけ
        s, _, _ = self.call("GET", "/api/meta", cookie="yf_token=forged")
        self.assertEqual(s, 401)
        s, _, _ = self.call("GET", "/api/meta", cookie=cookie, host=f"evil.example:{self.port}")
        self.assertEqual(s, 403)

    def test_lockout_over_http(self):
        for _ in range(lan.MAX_FAILURES - 1):
            s, _, _ = self.call("POST", "/api/login", {"passcode": "000000x"})
            self.assertEqual(s, 403)
        s, d, _ = self.call("POST", "/api/login", {"passcode": "000000x"})
        self.assertEqual(s, 429)
        s, d, _ = self.call("POST", "/api/login", {"passcode": self.app.auth.passcode})
        self.assertEqual(s, 429)

    def test_pc_sees_passcode_and_can_change(self):
        cookie = self.login()
        self.Handler.remote = False
        s, d, _ = self.call("GET", "/api/meta", host=f"127.0.0.1:{self.port}")
        self.assertEqual((s, d["is_local"], d["passcode"]), (200, True, self.app.auth.passcode))
        s, d, _ = self.call("POST", "/api/lan/passcode", {}, host=f"127.0.0.1:{self.port}")
        self.assertEqual(s, 200)
        self.Handler.remote = True
        s, _, _ = self.call("GET", "/api/meta", cookie=cookie)
        self.assertEqual(s, 401)               # パスコード変更で入り直し


if __name__ == "__main__":
    unittest.main()
