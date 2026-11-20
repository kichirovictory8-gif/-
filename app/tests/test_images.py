import base64
import json
import sqlite3
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from tests.helpers import make_store
from flashcards import db, io_json

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 40).decode()
PNG2 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x01" * 40).decode()
JPG = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 40).decode()


class ImageStoreTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)

    def test_add_get_dedupe(self):
        a = self.st.add_image("data:image/png;base64," + PNG, "data:image/jpeg;base64," + JPG, 800, 600)
        self.assertFalse(a["existing"])
        self.assertEqual(self.st.add_image(PNG)["id"], a["id"])     # 同じ画像は1つだけ
        data, mime = self.st.get_image(a["id"])
        self.assertEqual((mime, data[:4]), ("image/png", b"\x89PNG"))
        self.assertEqual(self.st.get_image(a["id"], thumb=True)[1], "image/jpeg")
        with self.assertRaises(KeyError):
            self.st.get_image(999)

    def test_rejects_non_images(self):
        with self.assertRaises(ValueError):
            self.st.add_image(base64.b64encode(b"<svg></svg>").decode())
        with self.assertRaises(ValueError):
            self.st.add_image("data:image/png;base64,@@@")

    def test_card_with_image_and_masks(self):
        img = self.st.add_image(PNG)["id"]
        masks = {str(img): [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2, "hint": ""}]}
        cid = self.st.add_card("化学", "官能基", f"次の構造の官能基\n[[img:{img}]]", "", masks)  # 四角形があれば裏面は省略可
        c = self.st.get_card(cid)
        self.assertTrue(c["is_cloze"])
        self.assertEqual(c["thumb_id"], img)
        self.assertEqual(c["masks"][str(img)][0]["w"], 0.2)
        self.assertIn('class="mask"', c["question_html"])
        self.assertEqual(c["front_plain"], "次の構造の官能基\n［画像］")
        with self.assertRaises(ValueError):                    # 存在しない画像
            self.st.add_card("化学", "", "[[img:999]]", "x")
        with self.assertRaises(ValueError):                    # 穴も裏面もない
            self.st.add_card("化学", "", f"[[img:{img}]]", "")
        self.st.update_card(cid, "化学", "", "文字だけ", "裏", masks)   # 画像を消すと四角形も消える
        self.assertEqual(self.st.get_card(cid)["masks"], {})

    def test_back_image_thumb(self):
        img = self.st.add_image(PNG)["id"]
        cid = self.st.add_card("薬理", "", "{{c1::A}}", f"説明\n[[img:{img}]]")
        self.assertEqual(self.st.get_card(cid)["thumb_id"], img)

    def test_cleanup(self):
        used = self.st.add_image(PNG)["id"]
        unused = self.st.add_image(PNG2)["id"]
        self.st.add_card("薬理", "", f"[[img:{used}]]", "x")
        self.assertEqual(self.st.cleanup_images(), 0)          # 作ったばかりは消さない
        self.clock.advance(days=3)
        self.assertEqual(self.st.cleanup_images(), 1)
        self.st.get_image(used)
        with self.assertRaises(KeyError):
            self.st.get_image(unused)


class MigrationTest(unittest.TestCase):
    def test_v1_file_gets_masks_column(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "old.db"
            old = sqlite3.connect(path)
            old.executescript("""
                CREATE TABLE cards (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '',
                  front TEXT NOT NULL, back TEXT NOT NULL DEFAULT '', stage INTEGER NOT NULL DEFAULT 0,
                  due TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                  reset_review_id INTEGER NOT NULL DEFAULT 0);
                INSERT INTO cards(subject, front, back, due, created_at, updated_at)
                  VALUES ('薬理', '古いカード', '裏', '2026-11-20', '2026-11-20T10:00:00', '2026-11-20T10:00:00');
            """)
            old.commit()
            old.close()
            conn = db.connect(path)
            try:
                c = db.Store(conn).get_card(1)
                self.assertEqual((c["front"], c["masks"]), ("古いカード", {}))
                self.assertEqual(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], "2")
            finally:
                conn.close()


class ImageJsonTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)
        self.img = self.st.add_image(PNG, JPG)["id"]
        self.masks = {str(self.img): [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2, "hint": "OH"}]}
        self.cid = self.st.add_card("化学", "", f"[[img:{self.img}]]", "", self.masks)

    def exported(self):
        return json.loads(json.dumps(io_json.export_data(self.st.conn)))

    def test_replace_keeps_ids(self):
        other, _ = make_store()
        self.addCleanup(other.conn.close)
        res = io_json.import_data(other.conn, self.exported(), "replace")
        self.assertEqual(res["images"], 1)
        c = other.get_card(self.cid)
        self.assertEqual((c["front"], c["masks"]), (f"[[img:{self.img}]]", self.masks))
        self.assertEqual(other.get_image(self.img, thumb=True)[1], "image/jpeg")

    def test_append_remaps_ids(self):
        other, _ = make_store()
        self.addCleanup(other.conn.close)
        first = other.add_image(PNG2)["id"]          # 先に別の画像があり、id がずれる
        io_json.import_data(other.conn, self.exported(), "append")
        c = other.list_cards()["items"][0]
        new_id = c["thumb_id"]
        self.assertNotEqual(new_id, first)
        self.assertEqual(c["front"], f"[[img:{new_id}]]")
        self.assertEqual(list(c["masks"]), [str(new_id)])

    def test_append_same_image_is_reused(self):
        io_json.import_data(self.st.conn, self.exported(), "append")
        self.assertEqual(self.st.conn.execute("SELECT COUNT(*) FROM images").fetchone()[0], 1)
        self.assertEqual(self.st.conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0], 2)

    def test_missing_image_rejected(self):
        data = self.exported()
        data["images"] = []
        with self.assertRaises(ValueError):
            io_json.import_data(self.st.conn, data, "replace")
        self.assertEqual(self.st.conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0], 1)

    def test_v1_json_still_readable(self):
        data = {"format": "yakushi-flash", "version": 1, "cards": [
            {"subject": "薬理", "unit": "", "front": "a", "back": "b", "stage": 0, "due": "2026-11-20",
             "created_at": "2026-11-20T10:00:00", "reviews": []}]}
        self.assertEqual(io_json.import_data(self.st.conn, data, "append")["cards"], 1)


if __name__ == "__main__":
    unittest.main()
