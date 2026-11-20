import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from tests.helpers import make_store
from flashcards import db, io_json, srs, stats, storage


class JsonTest(unittest.TestCase):
    def setUp(self):
        self.st, self.clock = make_store()
        self.addCleanup(self.st.conn.close)
        self.a = self.st.add_card("薬理", "自律神経", "{{c1::β1}}刺激", "")
        self.b = self.st.add_card("法規・制度・倫理", "", "毒薬", "黒地に白枠白字")
        self.st.record_review(self.a, srs.GOOD)
        self.st.record_review(self.b, srs.AGAIN)
        self.st.record_review(self.b, srs.FAIR)  # 再確認
        self.st.reset_card(self.a)
        self.st.record_review(self.a, srs.FAIR)

    def roundtrip(self, mode, target=None):
        data = json.loads(json.dumps(io_json.export_data(self.st.conn), ensure_ascii=False))
        if target is None:
            target = db.Store(db.connect(":memory:"), self.clock)
            self.addCleanup(target.conn.close)
        res = io_json.import_data(target.conn, data, mode)
        return target, res

    def test_roundtrip_replace(self):
        t, res = self.roundtrip("replace")
        self.assertEqual((res["cards"], res["reviews"]), (2, 4))
        self.assertEqual(io_json.export_data(t.conn, datetime(2000, 1, 1))["cards"],
                         io_json.export_data(self.st.conn, datetime(2000, 1, 1))["cards"])
        self.assertEqual(stats.by_subject(t.conn), stats.by_subject(self.st.conn))
        self.assertEqual(t.get_card(self.a)["reps"], 1)   # リセット前の評価は数えない
        self.assertEqual(len(t.card_history(self.a)), 2)

    def test_append_gives_new_ids(self):
        t, _ = self.roundtrip("append", target=self.st)
        self.assertEqual(self.st.conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0], 4)
        new = self.st.list_cards(sort="new", limit=2)["items"]
        self.assertTrue(all(c["id"] > self.b for c in new))
        self.assertEqual(stats.by_subject(self.st.conn)["total"]["reps"], 4)

    def test_replace_overwrites(self):
        other, _ = make_store()
        self.addCleanup(other.conn.close)
        other.add_card("物理", "", "x", "y")
        t, _ = self.roundtrip("replace", target=other)
        self.assertEqual([c["subject"] for c in io_json.export_data(t.conn)["cards"]], ["薬理", "法規・制度・倫理"])

    def test_invalid_is_atomic(self):
        data = io_json.export_data(self.st.conn)
        data["cards"][1]["subject"] = "数学"
        with self.assertRaises(ValueError):
            io_json.import_data(self.st.conn, data, "replace")
        self.assertEqual(self.st.conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0], 2)
        with self.assertRaises(ValueError):
            io_json.import_data(self.st.conn, {"format": "other"}, "append")
        with self.assertRaises(ValueError):
            io_json.import_data(self.st.conn, io_json.export_data(self.st.conn), "merge")


class BackupTest(unittest.TestCase):
    def test_backup_and_auto(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            conn = db.connect(d / "flashcards.db")
            try:
                self._run(conn, d)
            finally:
                conn.close()

    def _run(self, conn, d):
        bdir = storage.backup_dir(d)
        self.assertIsNone(storage.auto_backup(conn, bdir))  # カード0枚なら作らない
        db.Store(conn).add_card("薬理", "", "A", "a")
        p = storage.make_backup(conn, bdir, "manual", datetime(2026, 11, 20, 9))
        copy = db.connect(p)
        self.assertEqual(copy.execute("SELECT COUNT(*) FROM cards").fetchone()[0], 1)
        copy.close()
        for day in range(1, 20):
            self.assertIsNotNone(storage.auto_backup(conn, bdir, datetime(2026, 10, day, 9), keep=5))
        self.assertIsNone(storage.auto_backup(conn, bdir, datetime(2026, 10, 19, 21), keep=5))
        self.assertEqual(len(list(bdir.glob("*_auto*.db"))), 5)
        self.assertEqual(len(list(bdir.glob("*_manual*.db"))), 1)


if __name__ == "__main__":
    unittest.main()
