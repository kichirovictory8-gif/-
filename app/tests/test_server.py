"""サーバーを実際に起動して API を通しで確かめる。"""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from tests import helpers  # noqa: F401
import server


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["YAKUSHI_FLASH_DIR"] = cls.tmp.name
        cls.app = server.App(Path(cls.tmp.name) / "flashcards.db")
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        server.Handler.app = cls.app
        server.Handler.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{server.Handler.port}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.app.conn.close()
        cls.tmp.cleanup()
        os.environ.pop("YAKUSHI_FLASH_DIR", None)

    def call(self, method, path, body=None, headers=None):
        h = {"Content-Type": "application/json", "X-Yakushi-Flash": "1", **(headers or {})}
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())

    def test_flow(self):
        s, card = self.call("POST", "/api/cards", {"subject": "薬理", "unit": "自律", "front": "{{c1::β1}}", "back": ""})
        self.assertEqual(s, 201)
        s, prev = self.call("POST", "/api/cards/bulk", {"subject": "衛生", "unit": "", "text": "a\tb\nc\td\nbad", "dry_run": True})
        self.assertEqual((s, prev["count"], len(prev["errors"])), (200, 2, 1))
        s, _ = self.call("POST", "/api/cards/bulk", {"subject": "衛生", "text": "a\tb\nbad"})
        self.assertEqual(s, 400)
        s, res = self.call("POST", "/api/cards/bulk", {"subject": "衛生", "text": "a\tb\nc\td"})
        self.assertEqual((s, res["added"]), (201, 2))
        s, n = self.call("GET", "/api/session/next")
        self.assertEqual((n["remaining_due"], n["card"]["id"]), (3, card["id"]))
        self.assertIn('class="cl"', n["card"]["question_html"])
        s, r = self.call("POST", "/api/review", {"card_id": card["id"], "rating": "again"})
        self.assertEqual((s, r["stage"]), (200, 0))
        s, d = self.call("GET", "/api/dashboard")
        self.assertEqual((d["total"], d["reviewed_today"], d["due_today"]), (3, 1, 2))
        s, subj = self.call("GET", "/api/stats/subjects")
        self.assertEqual(subj["total"]["total"], 3)
        s, lst = self.call("GET", "/api/cards?subject=%E8%A1%9B%E7%94%9F")
        self.assertEqual(lst["total"], 2)
        s, w = self.call("GET", "/api/weak?days=14&min=1")
        self.assertEqual(w["cards"][0]["front_plain"], "β1")
        s, _ = self.call("PUT", f"/api/cards/{card['id']}", {"subject": "薬理", "unit": "", "front": "x", "back": "y"})
        self.assertEqual(s, 200)
        s, _ = self.call("POST", f"/api/cards/{card['id']}/reset", {})
        self.assertEqual(s, 200)
        s, b = self.call("POST", "/api/backup", {})
        self.assertTrue(Path(b["path"]).exists())
        with urllib.request.urlopen(self.base + "/api/export") as r:
            exported = json.loads(r.read().decode())
        s, imp = self.call("POST", "/api/import", {"mode": "replace", "data": exported})
        self.assertEqual((s, imp["cards"]), (200, 3))
        s, _ = self.call("DELETE", f"/api/cards/{card['id']}")
        self.assertEqual(s, 200)
        s, e = self.call("GET", f"/api/cards/{card['id']}")
        self.assertEqual(s, 404)

    def test_images_and_render(self):
        import base64
        png = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x07" * 30).decode()
        s, im = self.call("POST", "/api/images", {"data": png, "thumb": png, "width": 10, "height": 5})
        self.assertEqual(s, 201)
        with urllib.request.urlopen(f"{self.base}/api/images/{im['id']}/thumb") as r:
            self.assertEqual(r.headers["Content-Type"], "image/png")
            self.assertIn("max-age", r.headers["Cache-Control"])
            self.assertTrue(r.read().startswith(b"\x89PNG"))
        masks = {str(im["id"]): [{"x": 0.2, "y": 0.2, "w": 0.3, "h": 0.3}]}
        s, r = self.call("POST", "/api/render", {"front": f"[[img:{im['id']}]]", "back": "b", "masks": masks})
        self.assertEqual((s, r["image_ids"]), (200, [im["id"]]))
        self.assertIn('class="mask"', r["question_html"])
        s, c = self.call("POST", "/api/cards", {"subject": "化学", "front": f"[[img:{im['id']}]]", "back": "", "masks": masks})
        self.assertEqual((s, c["thumb_id"]), (201, im["id"]))
        s, e = self.call("POST", "/api/images", {"data": "data:image/png;base64,PHN2Zz4="})
        self.assertEqual(s, 400)

    def test_tags_and_session_options(self):
        from urllib.parse import quote
        s, c1 = self.call("POST", "/api/cards", {"subject": "薬剤", "front": "t1", "back": "b", "tags": "タグA タグB"})
        s, c2 = self.call("POST", "/api/cards", {"subject": "薬剤", "front": "t2", "back": "b", "tags": ["タグA"]})
        self.assertEqual(c1["tags"], ["タグA", "タグB"])
        s, tags = self.call("GET", "/api/tags")
        self.assertIn({"tag": "タグA", "n": 2}, tags)
        q = "tags=" + quote("タグA,タグB")
        s, cnt = self.call("GET", f"/api/session/count?{q}&tag_mode=and")
        self.assertEqual(cnt["total"], 1)
        s, n = self.call("GET", f"/api/session/next?{q}&tag_mode=or&order=added_desc")
        self.assertEqual(n["card"]["id"], c2["id"])
        s, n = self.call("GET", f"/api/session/next?{q}&session=sess-abcdefgh&order=added")
        self.assertEqual((n["kind"], n["card"]["id"]), ("practice", c1["id"]))
        s, r = self.call("POST", "/api/review", {"card_id": c1["id"], "rating": "good", "session": "sess-abcdefgh"})
        self.assertEqual((s, r["practice"], r["stage"]), (200, True, 0))
        s, _ = self.call("GET", "/api/session/next?order=bogus")
        self.assertEqual(s, 400)
        s, c = self.call("PUT", f"/api/cards/{c1['id']}", {"subject": "薬剤", "front": "t1", "back": "b", "tags": ""})
        self.assertEqual(c["tags"], [])
        s, lst = self.call("GET", "/api/cards?tag=" + quote("タグA"))
        self.assertEqual(lst["total"], 1)

    def test_study_aids_api(self):
        from urllib.parse import quote
        s, m = self.call("POST", "/api/memos", {"text": "あとで調べる", "subject": "薬理"})
        self.assertEqual(s, 201)
        s, ms = self.call("GET", "/api/memos")
        self.assertIn(m["id"], [x["id"] for x in ms])
        s, d = self.call("GET", "/api/dashboard")
        self.assertGreaterEqual(d["memos"], 1)
        s, _ = self.call("DELETE", f"/api/memos/{m['id']}")
        self.assertEqual(s, 200)
        s, r = self.call("GET", "/api/past?subject=" + quote("化学") + "&limit=3")
        self.assertEqual((r["total"], len(r["items"])), (50, 3))
        s, th = self.call("GET", "/api/past/themes?subject=" + quote("化学"))
        self.assertTrue(th and th[0]["subject"] == "化学")
        s, dr = self.call("GET", "/api/past/draft?id=104-2&style=cloze")
        self.assertIn("{{c1::", dr["front"])
        s, c = self.call("POST", "/api/cards", {k: dr[k] for k in ("subject", "unit", "front", "back", "tags", "source")})
        self.assertEqual((s, c["source"]), (201, "hissu:104-2"))
        s, cov = self.call("GET", "/api/past/coverage")
        self.assertGreaterEqual(cov["summary"]["covered"], 1)
        s, f = self.call("POST", f"/api/cards/{c['id']}/flag", {"on": True})
        self.assertIn("あとで直す", f["tags"])
        s, d = self.call("GET", "/api/dashboard")
        self.assertGreaterEqual(d["flagged"], 1)
        s, _ = self.call("GET", "/api/past/draft?id=104-2&style=bad")
        self.assertEqual(s, 400)

    def test_generated_api(self):
        from urllib.parse import quote
        s, c = self.call("POST", "/api/cards", {"subject": "薬理", "unit": "自律神経作用薬", "front": "演習", "back": "x"})
        s, _ = self.call("POST", "/api/review", {"card_id": c["id"], "rating": "again"})
        s, r = self.call("POST", "/api/generated/run", {"trigger": "manual"})
        self.assertGreater(r["created"], 0)
        s, cnt = self.call("GET", "/api/generated/count")
        self.assertEqual(cnt["pending"], r["pending"])
        s, items = self.call("GET", "/api/generated")
        self.assertIn('class="cl"', items[0]["question_html"])
        s, a = self.call("POST", f"/api/generated/{items[0]['id']}/add", {"front": items[0]["front"], "tags": "自動生成 頻出"})
        self.assertEqual(len(a["card_ids"]), 1)
        s, _ = self.call("POST", f"/api/generated/{items[1]['id']}/discard", {"reason": "easy"})
        self.assertEqual(s, 200)
        s, _ = self.call("POST", f"/api/generated/{items[1]['id']}/discard", {"reason": "easy"})
        self.assertEqual(s, 400)
        s, st = self.call("GET", "/api/generated/style")
        self.assertIn("alpha", st["style"])
        self.assertTrue(st["weak"])
        s, sp = self.call("POST", "/api/cards/split", {"subject": "薬理", "front": "{{c1::A}}{{c1::B}}", "back": "b"})
        self.assertEqual((s, len(sp["card_ids"])), (201, 2))
        s, n = self.call("POST", f"/api/cards/{c['id']}/note", {"text": "取り違え"})
        self.assertIn("取り違え", n["back"])
        s, _ = self.call("GET", "/api/session/next?order=grouped")
        self.assertEqual(s, 200)
        s, _ = self.call("POST", "/api/generated/run", {"trigger": "bad"})
        self.assertEqual(s, 400)

    def test_csrf_and_host(self):
        s, _ = self.call("POST", "/api/cards", {"subject": "薬理", "front": "a", "back": "b"},
                         headers={"X-Yakushi-Flash": ""})
        self.assertEqual(s, 403)
        s, _ = self.call("GET", "/api/meta", headers={"Host": "evil.example:80"})
        self.assertEqual(s, 403)

    def test_shortcut_api(self):
        import sys
        s, m = self.call("GET", "/api/meta")
        self.assertEqual(m["can_shortcut"], sys.platform == "win32")
        if sys.platform != "win32":
            s, e = self.call("POST", "/api/shortcut", {})
            self.assertEqual(s, 400)
            self.assertIn("Windows", e["error"])
        with urllib.request.urlopen(self.base + "/icon.ico") as r:
            self.assertTrue(r.read(4) == b"\x00\x00\x01\x00")

    def test_static(self):
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn("text/html", r.headers["Content-Type"])
        s, _ = self.call("GET", "/../server.py")
        self.assertEqual(s, 404)


if __name__ == "__main__":
    unittest.main()
